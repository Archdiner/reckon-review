/**
 * THE RECORD SWEEP — the same measurement across many repositories.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────
 *
 * Every coverage number on disk came from ONE repository. A single-repository finding invites
 * exactly one reply — "that is grafana, not us" — and there is no answer to it from inside a
 * one-repository dataset. The body-density gate already runs across 24 repositories and shows that
 * most of them CAN be measured; this closes the gap by actually measuring them.
 *
 * It also changes what the data can support. With one repository, the spread across its areas is
 * the only variation there is, and it is impossible to say whether an area at 10% is unusual for
 * that project or unusual full stop. With twenty, between-repository and within-repository variance
 * are separable, and "this area is in the bottom decile ACROSS PROJECTS" becomes a sentence someone
 * can check.
 *
 * ── THE BUDGET DECISION, WHICH IS THE WHOLE DESIGN ────────────────────────────────────────
 *
 * Model calls are the binding constraint, and there are two ways to spend a fixed budget per
 * repository: thin estimates everywhere, or solid estimates on the largest areas. The first is
 * tempting because it produces a complete-looking page. It was measured, and it does not work: at 5
 * sampled commits per area, 82% of cells fail the interval rule and get greyed. A page of grey is
 * not a cheaper map.
 *
 * So the sweep caps AREAS and keeps DEPTH: the largest `maxRegions` areas by lines changed, at the
 * full per-area sample. Both numbers are recorded per repository, and the count of unscored areas
 * traves with the map, so nobody reads a top slice as a whole tree.
 *
 * ── DISK, WHICH IS THE OTHER CONSTRAINT ───────────────────────────────────────────────────
 *
 * A shallow clone of a large repository runs to 1-3 GB and there are twenty of them. Clones the
 * sweep creates are DELETED after scoring; clones that already existed are left alone, because they
 * belong to someone else's run. Peak disk is therefore one clone, not twenty.
 *
 * ── RESUMABILITY, WHICH IS NOT OPTIONAL AT THIS LENGTH ────────────────────────────────────
 *
 * This is a multi-hour job making tens of thousands of model calls. A repository whose JSON already
 * exists is skipped, so an interrupted run resumes where it stopped rather than paying twice. A
 * repository that fails is recorded as a failure and the sweep continues: losing nineteen scored
 * repositories to a transport error on the twentieth would be a pure waste with no analytical
 * justification.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LlmBackend } from '@reckon/core';
import { buildRecordMap, type RecordMap } from './recordmap.js';
import { parseRepoList, freeBytes, CLONE_SINCE, MIN_FREE_BYTES, DiskSpaceError, type RepoSpec } from './sweep.js';

const exec = promisify(execFile);

export interface RecordSweepOpts {
  reposFile: string;
  clonesDir: string;
  outDir: string;
  backend: LlmBackend;
  genBackend: LlmBackend;
  perRegion: number;
  maxRegions: number;
  concurrency: number;
  /** Re-score repositories that already have a JSON on disk. Off by default; the point is resuming. */
  force?: boolean;
  cloneTimeoutMs?: number;
  onProgress?: (m: string) => void;
}

export interface RecordSweepRow {
  repo: string;
  spec: string;
  status: 'scored' | 'refused' | 'failed' | 'skipped-empty';
  /** Present when scored. */
  overallRate?: number;
  explicit?: number;
  questions?: number;
  regionsScored?: number;
  regionsDropped?: number;
  colouredCells?: number;
  substantiveBodyShare?: number;
  commitsAnalysed?: number;
  seconds?: number;
  reason?: string;
}

const slugOf = (repo: string): string => repo.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--git-dir'], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

/**
 * One repository, end to end. Returns the row and whether this call created the clone (so the
 * caller knows whether deleting it is its business).
 */
async function scoreOne(
  spec: RepoSpec,
  opts: RecordSweepOpts,
  log: (m: string) => void
): Promise<{ row: RecordSweepRow; map: RecordMap | null; createdClone: string | null }> {
  const started = Date.now();
  const dir = join(opts.clonesDir, spec.dirName);
  let createdClone: string | null = null;

  if (!(await isGitRepo(dir))) {
    if (existsSync(dir)) {
      return {
        row: { repo: spec.ownerName ?? spec.spec, spec: spec.spec, status: 'failed', reason: `${dir} exists and is not a git repository` },
        map: null,
        createdClone: null,
      };
    }
    const free = await freeBytes(opts.clonesDir);
    if (free < MIN_FREE_BYTES) {
      throw new DiskSpaceError(
        `only ${(free / 1024 ** 3).toFixed(1)}G free and a shallow clone runs to 1-3G. Stopping before ` +
          `${spec.spec}; repositories already scored are on disk and will be skipped on the next run.`
      );
    }
    log(`cloning ${spec.url}`);
    try {
      await exec('git', ['clone', `--shallow-since=${CLONE_SINCE}`, spec.url, dir], {
        timeout: opts.cloneTimeoutMs ?? 15 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (e) {
      const why = e instanceof Error ? e.message.split('\n')[0] : String(e);
      return {
        row: { repo: spec.ownerName ?? spec.spec, spec: spec.spec, status: 'failed', reason: `clone failed: ${why}` },
        map: null,
        createdClone: null,
      };
    }
    if (!(await isGitRepo(dir))) {
      // A repository with no commits in the shallow window clones "successfully" and empty. Scoring
      // it would report zero areas as though that were a finding.
      return {
        row: { repo: spec.ownerName ?? spec.spec, spec: spec.spec, status: 'skipped-empty', reason: 'clone produced no history in the window' },
        map: null,
        createdClone: dir,
      };
    }
    createdClone = dir;
  } else {
    log(`reusing existing clone at ${dir}`);
  }

  const map = await buildRecordMap({
    repo: dir,
    backend: opts.backend,
    genBackend: opts.genBackend,
    perRegion: opts.perRegion,
    maxRegions: opts.maxRegions,
    concurrency: opts.concurrency,
    onProgress: (m) => log(`  ${m}`),
  });

  const seconds = (Date.now() - started) / 1000;
  if (map.refused) {
    return {
      row: {
        repo: map.repo,
        spec: spec.spec,
        status: 'refused',
        substantiveBodyShare: map.squash.substantiveBodyShare,
        commitsAnalysed: map.commitsAnalysed,
        seconds,
        reason: `body density ${(map.squash.substantiveBodyShare * 100).toFixed(1)}% is below the floor`,
      },
      map,
      createdClone,
    };
  }

  return {
    row: {
      repo: map.repo,
      spec: spec.spec,
      status: 'scored',
      ...(map.overall
        ? { overallRate: map.overall.rate, explicit: map.overall.explicit, questions: map.overall.total }
        : {}),
      regionsScored: map.cells.length,
      regionsDropped: map.regionsDropped ?? 0,
      colouredCells: map.cells.filter((c) => c.greyReason === null).length,
      substantiveBodyShare: map.squash.substantiveBodyShare,
      commitsAnalysed: map.commitsAnalysed,
      seconds,
    },
    map,
    createdClone,
  };
}

export async function runRecordSweep(opts: RecordSweepOpts): Promise<RecordSweepRow[]> {
  const log = opts.onProgress ?? (() => {});
  const specs = parseRepoList(readFileSync(opts.reposFile, 'utf8'));
  const mapsDir = join(opts.outDir, 'repos');
  mkdirSync(mapsDir, { recursive: true });

  const rows: RecordSweepRow[] = [];
  for (const [i, spec] of specs.entries()) {
    const name = spec.ownerName ?? spec.spec;
    const jsonPath = join(mapsDir, `${slugOf(spec.dirName)}.json`);
    if (!opts.force && existsSync(jsonPath)) {
      log(`[${i + 1}/${specs.length}] ${name}: already scored, skipping`);
      try {
        const prev = JSON.parse(readFileSync(jsonPath, 'utf8')) as RecordMap;
        rows.push({
          repo: prev.repo,
          spec: spec.spec,
          status: prev.refused ? 'refused' : 'scored',
          ...(prev.overall
            ? { overallRate: prev.overall.rate, explicit: prev.overall.explicit, questions: prev.overall.total }
            : {}),
          regionsScored: prev.cells.length,
          regionsDropped: prev.regionsDropped ?? 0,
          colouredCells: prev.cells.filter((c) => c.greyReason === null).length,
          substantiveBodyShare: prev.squash.substantiveBodyShare,
          commitsAnalysed: prev.commitsAnalysed,
        });
      } catch {
        log(`  (existing ${jsonPath} is unreadable; delete it to re-score)`);
      }
      continue;
    }

    log(`[${i + 1}/${specs.length}] ${name}`);
    let created: string | null = null;
    try {
      const r = await scoreOne(spec, opts, log);
      created = r.createdClone;
      rows.push(r.row);
      if (r.map) writeFileSync(jsonPath, `${JSON.stringify(r.map, null, 2)}\n`);
      log(
        `  ${r.row.status}` +
          (r.row.overallRate !== undefined
            ? ` — ${(r.row.overallRate * 100).toFixed(1)}% over ${r.row.questions} questions, ` +
              `${r.row.colouredCells}/${r.row.regionsScored} cells usable`
            : ` — ${r.row.reason ?? ''}`)
      );
    } catch (e) {
      if (e instanceof DiskSpaceError) throw e;
      const why = e instanceof Error ? e.message.split('\n')[0] : String(e);
      log(`  FAILED — ${why}`);
      rows.push({ repo: name, spec: spec.spec, status: 'failed', reason: why });
    } finally {
      // Only clones this sweep created. An existing clone belongs to another run.
      if (created) {
        log(`  removing ${created}`);
        rmSync(created, { recursive: true, force: true });
      }
      // The rows file is rewritten after every repository, not at the end, so an interrupted run
      // still leaves a readable summary of what it got through.
      writeFileSync(join(opts.outDir, 'sweep-rows.json'), `${JSON.stringify(rows, null, 2)}\n`);
    }
  }
  return rows;
}

/** Load every per-repository map a sweep has written, for pooling. */
export function loadSweepMaps(outDir: string): RecordMap[] {
  const dir = join(outDir, 'repos');
  if (!existsSync(dir)) return [];
  const out: RecordMap[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as RecordMap);
    } catch {
      // A half-written file from a killed run is skipped rather than crashing the pool.
    }
  }
  return out;
}

export function formatRecordSweepReport(rows: RecordSweepRow[]): string {
  const L: string[] = [];
  const scored = rows.filter((r) => r.status === 'scored');
  const refused = rows.filter((r) => r.status === 'refused');
  const failed = rows.filter((r) => r.status === 'failed' || r.status === 'skipped-empty');

  L.push('# Record coverage across repositories');
  L.push('');
  L.push(
    `${scored.length} scored, ${refused.length} refused by the body-density gate, ${failed.length} not measured.`
  );
  L.push('');

  if (scored.length > 0) {
    const pooledExplicit = scored.reduce((a, r) => a + (r.explicit ?? 0), 0);
    const pooledQuestions = scored.reduce((a, r) => a + (r.questions ?? 0), 0);
    L.push(
      `Pooled: **${((100 * pooledExplicit) / Math.max(1, pooledQuestions)).toFixed(1)}% of ` +
        `${pooledQuestions.toLocaleString('en-US')} mechanism questions** are answered explicitly by the ` +
        'commits that made the change.'
    );
    L.push('');
    L.push('| repository | coverage | questions | areas scored | usable cells | areas not scored | body density |');
    L.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const r of [...scored].sort((a, b) => (b.overallRate ?? 0) - (a.overallRate ?? 0))) {
      L.push(
        `| \`${r.repo}\` | **${((r.overallRate ?? 0) * 100).toFixed(1)}%** | ${r.questions ?? 0} | ` +
          `${r.regionsScored ?? 0} | ${r.colouredCells ?? 0} | ${r.regionsDropped ?? 0} | ` +
          `${((r.substantiveBodyShare ?? 0) * 100).toFixed(0)}% |`
      );
    }
    L.push('');
    const rates = scored.map((r) => r.overallRate ?? 0).sort((a, b) => a - b);
    L.push(
      `Between-repository spread: ${(rates[0]! * 100).toFixed(1)}% to ${(rates[rates.length - 1]! * 100).toFixed(1)}%. ` +
        'That range is the reason a single-repository number could not be generalised, and the reason ' +
        'this sweep exists.'
    );
    L.push('');
  }

  if (refused.length > 0) {
    L.push('## Refused, and that is the correct output');
    L.push('');
    L.push(
      'These repositories squash to a title often enough that a coverage number would be measuring ' +
        'the merge button rather than any author. The tool draws nothing.'
    );
    L.push('');
    L.push('| repository | body density |');
    L.push('| --- | --- |');
    for (const r of refused) L.push(`| \`${r.repo}\` | ${((r.substantiveBodyShare ?? 0) * 100).toFixed(1)}% |`);
    L.push('');
  }

  if (failed.length > 0) {
    L.push('## Not measured');
    L.push('');
    for (const r of failed) L.push(`- \`${r.repo}\` — ${r.reason ?? r.status}`);
    L.push('');
  }

  L.push('## What this is');
  L.push('');
  L.push(
    'Questions are generated from the diff alone by the production generator; a second model scores ' +
      'the commit record against them and never sees the code. A tripped separation guard aborts the ' +
      'run. "Explicit" means the record answers the question outright, not that a reader could infer it.'
  );
  L.push('');
  L.push(
    'Each repository contributes its largest areas at full sampling depth rather than every area ' +
      'thinly: at 5 sampled commits per area, 82% of cells fail the interval rule and are greyed, so a ' +
      'thin-everywhere sweep would have produced a page of grey. The count of unscored areas is in the ' +
      'table above and in each per-repository JSON.'
  );
  return `${L.join('\n')}\n`;
}
