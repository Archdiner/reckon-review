/**
 * Stage 1 — collect.
 *
 * Builds the corpus from local git clones of the admitted repositories (see corpus.ts for
 * why the record can be recovered from git at all, and which repos that is valid for).
 *
 * OUTPUT LAYOUT — this is a leakage control, not filing preference:
 *
 *   data/prs/<id>/meta.json    provenance, size, language. No prose from the change.
 *   data/prs/<id>/diff.patch   stages 2 and 3 read this and nothing else.
 *   data/prs/<id>/record.md    stage 4 reads this and nothing else.
 *
 * Because the diff and the record live in separate files behind separate accessors
 * (guard.ts), a later stage cannot pick up the forbidden one by reaching into a struct that
 * happened to carry both.
 *
 * SAMPLING. Agent-authored PRs are the scarce arm, so all of them are taken up to the
 * target. Human PRs are drawn by seeded reservoir sample from the full eligible pool rather
 * than taking the most recent N, which would confound provenance with calendar time — agent
 * PRs skew recent, and "recent" also means "after the repo's current review norms settled".
 * Stage 5 then matches on language and size bucket.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPOS } from './corpus.js';
import { inferLanguage } from './corpus.js';
import { classify, isNonAgentAutomation, stripAttribution } from './provenance.js';
import { applyExclusions, type DiffFile, type DropReason } from './exclusions.js';
import { measureRecordOverlap } from './guard.js';
import { bucketOf, type PrMeta, type Provenance } from './types.js';

const exec = promisify(execFile);

const MAX_PATCH_BYTES = 400_000;
const GIT_CONCURRENCY = 6;

interface Candidate {
  repo: string;
  dir: string;
  sha: string;
  authorName: string;
  authorEmail: string;
  date: string;
  subject: string;
  body: string;
  prNumber: number;
  provenance: Provenance;
}

/** Deterministic PRNG so a rerun draws the same sample. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

async function enumerate(cloneRoot: string, repo: string, dir: string, since: string): Promise<Candidate[]> {
  const path = join(cloneRoot, dir);
  if (!existsSync(path)) throw new Error(`clone missing: ${path} (run "study clone" first)`);

  const { stdout } = await exec(
    'git',
    ['-C', path, 'log', `--since=${since}`, '--no-merges', '--format=%x00%H%x01%an%x01%ae%x01%aI%x01%s%x01%b'],
    { maxBuffer: 1024 * 1024 * 512 }
  );

  const out: Candidate[] = [];
  for (const rec of stdout.split('\x00')) {
    if (!rec.trim()) continue;
    const [sha, authorName, authorEmail, date, subject, body = ''] = rec.split('\x01');
    if (!sha || !subject) continue;

    // Squash-merge convention: the PR number is the trailing "(#123)" on the subject. A
    // commit without it did not arrive through a pull request and has no record to measure.
    const m = /\(#(\d+)\)\s*$/.exec(subject);
    if (!m) continue;

    if (isNonAgentAutomation(authorName, authorEmail)) continue;

    const { provenance } = classify(authorName, authorEmail, body);
    out.push({
      repo, dir, sha, authorName, authorEmail, date,
      subject: subject.trim(), body, prNumber: Number(m[1]), provenance,
    });
  }
  return out;
}

/** Parse `git show --numstat --patch` into per-file records. */
function parseShow(raw: string): DiffFile[] {
  const diffStart = raw.indexOf('diff --git ');
  const numstatBlock = diffStart === -1 ? raw : raw.slice(0, diffStart);
  const patchBlock = diffStart === -1 ? '' : raw.slice(diffStart);

  const counts = new Map<string, { added: number; deleted: number }>();
  for (const line of numstatBlock.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    // Renames appear as "old => new" or "dir/{a => b}/f"; take the post-rename path.
    let p = m[3];
    if (p.includes(' => ')) {
      p = p.replace(/\{([^}]*) => ([^}]*)\}/, '$2').replace(/^.* => /, '');
    }
    counts.set(p, { added: m[1] === '-' ? 0 : Number(m[1]), deleted: m[2] === '-' ? 0 : Number(m[2]) });
  }

  const files: DiffFile[] = [];
  for (const part of patchBlock.split(/\n(?=diff --git )/)) {
    if (!part.startsWith('diff --git ')) continue;
    const header = part.split('\n', 1)[0];
    const hm = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
    const path = hm ? hm[2] : header.slice(11);
    const c = counts.get(path) ?? { added: 0, deleted: 0 };
    files.push({ path, added: c.added, deleted: c.deleted, patch: part });
  }
  return files;
}

async function fetchDiff(cloneRoot: string, dir: string, sha: string): Promise<DiffFile[] | null> {
  try {
    const { stdout } = await exec(
      'git',
      ['-C', join(cloneRoot, dir), 'show', '--numstat', '--patch', '--unified=3', '--format=', '--no-color', sha],
      { maxBuffer: 1024 * 1024 * 256 }
    );
    return parseShow(stdout);
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

export interface CollectOpts {
  cloneRoot: string;
  outDir: string;
  since: string;
  agentTarget: number;
  humanTarget: number;
  seed: string;
}

export interface CollectReport {
  perRepo: Record<string, { eligible: number; agentEligible: number; selected: number }>;
  kept: { agent: number; human: number };
  drops: Record<DropReason, number>;
  total: number;
}

export async function collect(opts: CollectOpts): Promise<CollectReport> {
  const drops: Record<DropReason, number> = {
    'dependency-bump': 0, 'dependency-manifest-only': 0, 'formatting-only': 0,
    'docs-only': 0, 'below-size-floor': 0, 'no-surviving-files': 0, 'diff-unavailable': 0,
  };
  const perRepo: CollectReport['perRepo'] = {};

  // --- enumerate every eligible commit across every admitted repo -------------------
  const all: Candidate[] = [];
  for (const r of REPOS) {
    const cands = await enumerate(opts.cloneRoot, r.slug, r.dir, opts.since);
    perRepo[r.slug] = {
      eligible: cands.length,
      agentEligible: cands.filter((c) => c.provenance === 'agent').length,
      selected: 0,
    };
    all.push(...cands);
    console.log(`  ${r.slug}: ${cands.length} eligible commits (${perRepo[r.slug].agentEligible} agent-attested)`);
  }

  // --- select: all agents, seeded sample of humans ---------------------------------
  const rng = mulberry32(seedFrom(opts.seed));
  const shuffle = <T,>(xs: T[]) => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const agents = shuffle(all.filter((c) => c.provenance === 'agent'));
  const humans = shuffle(all.filter((c) => c.provenance === 'human'));

  // Over-draw so post-exclusion attrition and stage-5 matching still leave enough. The
  // exclusion filter historically removes roughly a third of candidates.
  const agentPool = agents.slice(0, Math.ceil(opts.agentTarget * 2.2));
  const humanPool = humans.slice(0, Math.ceil(opts.humanTarget * 2.5));

  mkdirSync(opts.outDir, { recursive: true });

  const kept = { agent: 0, human: 0 };
  const limits = { agent: opts.agentTarget, human: opts.humanTarget };

  const process = async (pool: Candidate[], group: Provenance) => {
    await mapLimit(pool, GIT_CONCURRENCY, async (c) => {
      if (kept[group] >= limits[group]) return;

      const files = await fetchDiff(opts.cloneRoot, c.dir, c.sha);
      if (!files || files.length === 0) {
        drops['diff-unavailable']++;
        return;
      }

      const outcome = applyExclusions(c.subject, files);
      if (!outcome.keep) {
        drops[outcome.reason!]++;
        return;
      }
      if (kept[group] >= limits[group]) return;
      kept[group]++;

      const prov = classify(c.authorName, c.authorEmail, c.body);
      const id = `${c.repo.replace('/', '_')}__${c.prNumber}`;
      const dir = join(opts.outDir, id);
      mkdirSync(dir, { recursive: true });

      let patch = outcome.files.map((f) => f.patch).join('\n');
      if (patch.length > MAX_PATCH_BYTES) patch = `${patch.slice(0, MAX_PATCH_BYTES)}\n… [truncated at ${MAX_PATCH_BYTES} bytes]`;

      // The record: the PR title plus the body that survived into git, with attribution
      // trailers removed (see provenance.stripAttribution for why that removal is required).
      const title = c.subject.replace(/\s*\(#\d+\)\s*$/, '');
      const body = stripAttribution(c.body);
      const record = body ? `# ${title}\n\n${body}\n` : `# ${title}\n`;

      const meta: PrMeta = {
        id,
        repo: c.repo,
        prNumber: c.prNumber,
        sha: c.sha,
        mergedAt: c.date,
        authorName: c.authorName,
        authorEmail: c.authorEmail,
        provenance: prov.provenance,
        evidence: prov.evidence,
        evidenceMarker: prov.marker,
        language: inferLanguage(outcome.files.map((f) => ({ path: f.path, changed: f.added + f.deleted }))),
        changedLines: outcome.changedLines,
        filesChanged: outcome.files.length,
        sizeBucket: bucketOf(outcome.changedLines),
        emptyBody: body.length === 0,
        recordDiffSharedShingles: 0,
        recordShingles: 0,
      };

      writeFileSync(join(dir, 'diff.patch'), patch);
      writeFileSync(join(dir, 'record.md'), record);
      // Measured after both files exist; see guard.measureRecordOverlap for why this is
      // recorded as a corpus property rather than treated as a leak.
      const overlap = measureRecordOverlap(dir);
      meta.recordDiffSharedShingles = overlap.shared;
      meta.recordShingles = overlap.recordShingles;
      writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
      perRepo[c.repo].selected++;
    });
  };

  await process(agentPool, 'agent');
  await process(humanPool, 'human');

  return { perRepo, kept, drops, total: kept.agent + kept.human };
}
