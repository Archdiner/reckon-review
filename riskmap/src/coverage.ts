/**
 * Step 6 — record coverage.
 *
 * The dimension nobody else can produce, and the direct link back to the study.
 *
 * For a sample of commits in each region: generate mechanism questions FROM THE DIFF using the
 * production `decompose()`, then score THE COMMIT MESSAGE against them. The region's coverage
 * is the share of questions its records answer explicitly.
 *
 * WHY THE PRODUCTION GENERATOR. The study measured the world with the instrument the product
 * ships, so its distribution is a claim about Reckon's own question generator rather than about
 * a research prompt nothing else uses. Calibrating against that distribution with a DIFFERENT
 * generator would compare two measurements and call it a percentile. Same instrument, or the
 * calibration is void.
 *
 * INFORMATION SEPARATION, inherited from the study and enforced the same way. Two ways to void
 * this measurement: let the commit message reach the question generator, or let the diff reach
 * the scorer. Both are asserted below and both abort the run rather than warn — a run that
 * continued past a leak would produce numbers indistinguishable from clean ones.
 *
 * SAMPLING. Scoring every commit in a large repository is thousands of model calls for a
 * number that stabilises quickly, so each region samples up to `perRegion` commits. The sample
 * is SEEDED and drawn from commits that survive the same filters as everything else, and the
 * count actually scored is reported per region so a reader can see how thin it is. A region
 * that cannot supply the minimum is reported with no coverage rather than with a number
 * computed from two commits.
 */

import type { LlmBackend } from '@reckon/core';
import { decompose } from '@reckon/core';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertDerivedFromDiff, assertNoRawDiff, LeakageError } from './vendor/guard.js';
import { readCommitDiff } from './gitlog.js';
import { diffDigest } from './vendor/diff-digest.js';
import { classifyRecord } from './vendor/triviality.js';
import type { Commit, Region } from './types.js';

/** Fewer scored commits than this and the region reports no coverage at all. */
export const MIN_COMMITS_FOR_COVERAGE = 3;

export { LeakageError };

/** The scorer must judge the record alone; the study's check is used verbatim. */
function assertNoDiffInScorerPrompt(prompt: string): void {
  assertNoRawDiff(prompt, 'coverage/scorer-input');
}

/**
 * Does the RECORD ITSELF contain raw diff syntax — before any prompt is built around it?
 *
 * ── WHY THIS DISTINCTION EXISTS, AND WHY IT IS NOT A WEAKENING OF THE GUARD ────────────────
 *
 * The scorer-side guard tripped on a real sweep, on `tailwindlabs/tailwindcss`. The cause was checked
 * before anything was changed: seven commits in that repository have a PASTED DIFF IN THEIR COMMIT
 * MESSAGE — bot commits that quote a diff of generated CSS. So the diff text was in the record, put
 * there by the author, and it had not leaked out of this pipeline at all.
 *
 * The invariant the guard encodes is that THE SCORER MUST NEVER SEE DIFF TEXT. Skipping such a commit
 * upholds that invariant exactly — the prompt is never built, never sent. What changes is the blast
 * radius: one unscorable commit is dropped and counted, instead of a whole repository's measurement
 * being discarded. A record that quotes its own diff cannot be scored fairly in either direction, so
 * it is not scorable data, and that is a different fact from a defect in this code.
 *
 * WHAT IS DELIBERATELY NOT DONE: stripping the diff out of the record and scoring the remainder. That
 * would silently change the object being measured, and the number it produced would not be the
 * coverage of any record that exists.
 *
 * A LEAK CAUSED BY THIS PIPELINE IS STILL FATAL. If the record is clean and the assembled prompt is
 * not, the diff got in here, and `scoreOne`'s assertion aborts the run as it always has. The two cases
 * are now distinguishable, which they were not before.
 *
 * The test is the VENDORED ASSERTION ITSELF, caught rather than reimplemented, so this classifier and
 * the guard can never disagree about what counts as diff syntax.
 */
function recordContainsRawDiff(record: string): boolean {
  try {
    assertNoRawDiff(record, 'coverage/record-precheck');
    return false;
  } catch (e) {
    if (e instanceof LeakageError) return true;
    throw e;
  }
}

/**
 * Containment is delegated to the study's audited guard rather than reimplemented.
 *
 * THREE ATTEMPTS AT THIS FAILED BEFORE VENDORING IT. The first could not fire at all — it
 * filtered short words out of the message and searched for a shingle absent even from the
 * message it came from. The second fired on "when enabled, objects are uploaded without an acl",
 * a commit that added a doc comment saying what its message says, which is shared content and
 * not a leak. The third fired on `diffDigest`'s own synthetic header, which by construction is
 * not in the diff.
 *
 * The study hit all three walls first and its guard already handles them: it strips digest
 * markers, and it scopes shingles to a single line because the digest drops context lines, so a
 * shingler crossing newlines manufactures sequences absent from the source and the assertion
 * fails on every large change.
 *
 * THE INVARIANT WAS VERIFIED TO STILL APPLY HERE BEFORE ADOPTING IT, rather than assumed:
 * `git show --format=` emits zero occurrences of the commit subject, so generation in this
 * pipeline is diff-only exactly as it is in the study. The guard was never reporting that the
 * two contexts differ.
 */

const SCORER_SYSTEM =
  'You judge whether a written record answers a specific question about a code change. ' +
  'You have NOT seen the code and must not speculate about it. Answer with a single digit.\n\n' +
  '0 — nothing in the text bears on the question\n' +
  '1 — the text gestures at it but does not state it\n' +
  '2 — the text states it clearly enough to act on without reading the code\n\n' +
  'Reply with the digit alone.';

async function scoreOne(backend: LlmBackend, question: string, record: string): Promise<number> {
  const user = `QUESTION\n${question}\n\nWRITTEN RECORD\n${record}\n\nScore (0, 1 or 2):`;
  assertNoDiffInScorerPrompt(user);
  const raw = await backend.complete(SCORER_SYSTEM, user, {});
  const m = raw.match(/[012]/);
  return m ? Number(m[0]) : 0;
}

/**
 * Bounded-concurrency map, preserving input order in the output.
 *
 * Coverage was fully sequential — one region at a time, one commit at a time, one question at a
 * time — which put a 68-region repository at roughly eight hours for the sample size the
 * uncertainty rule actually requires. Every one of those calls is network-bound and independent,
 * so the wall clock was almost entirely idle waiting. Ordering is preserved because the seeded
 * sample must produce identical output whatever order the responses arrive in.
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Deterministic shuffle, so a rerun on the same clone scores the same commits. */
function seededPick<T>(items: T[], n: number, seed: string): T[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const scored = items.map((item, i) => {
    let x = (h ^ i) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 2246822507) >>> 0;
    return { item, k: x };
  });
  scored.sort((a, b) => a.k - b.k);
  return scored.slice(0, n).map((s) => s.item);
}

export interface CoverageOpts {
  repo: string;
  backend: LlmBackend;
  genBackend: LlmBackend;
  perRegion: number;
  /** Commits larger than this are skipped: the diff would blow the digest budget. */
  maxFilesPerCommit: number;
  /** Parallel in-flight model calls. Network-bound, so this is nearly linear. */
  concurrency?: number;
  onProgress?: (msg: string) => void;
}

/**
 * Per-region coverage, WITH THE COUNTS THE ESTIMATE RESTS ON.
 *
 * The rate alone is not enough for a heatmap. Every coloured cell is an estimate from a handful
 * of sampled commits, and a table makes that visible while a heatmap does not — a region scored
 * off three commits gets the same confident block of colour as one scored off fifty. So the
 * numerator and denominator travel with the rate, and the renderer greys anything too thin
 * instead of colouring it.
 */
export interface RegionCoverage {
  /** Questions answered explicitly (rubric score 2). */
  explicit: number;
  /** Questions asked. The denominator for the interval. */
  total: number;
  /** Commits that actually produced questions. */
  commits: number;
  rate: number;
}

export interface CoverageResult {
  /** Region path → mean explicit rate in [0,1]. */
  coverage: Map<string, number>;
  scored: Map<string, number>;
  /** Region path → the full estimate with its counts. */
  detail: Map<string, RegionCoverage>;
  questionsAsked: number;
  /** Sampled commits set aside because their own message quotes a diff, so no prompt was ever built. */
  unscorableRecords: number;
}

/**
 * Score record coverage for every region.
 *
 * Only SUBSTANTIVE commits are candidates for the sample. That is not a quality filter applied
 * to the result — it is the same distinction the study draws, and the reason is that a commit
 * whose message is its subject alone has no record to score, so including it would measure the
 * repository's commit-granularity convention rather than its documentation. Regions whose
 * commits are overwhelmingly non-substantive surface through the squash verdict instead, which
 * is the honest place for that signal.
 */
export async function computeCoverage(
  regionsOf: Map<string, Commit[]>,
  opts: CoverageOpts
): Promise<CoverageResult> {
  const guardDir = join(tmpdir(), `riskmap-guard-${process.pid}`);
  const coverage = new Map<string, number>();
  const scored = new Map<string, number>();
  const detail = new Map<string, RegionCoverage>();
  let questionsAsked = 0;
  // Commits whose own message quotes a diff. Counted rather than silently dropped: it is a property of
  // the repository's commit conventions and a reader should be able to see how much was set aside.
  let unscorableRecords = 0;

  const conc = Math.max(1, opts.concurrency ?? 8);

  for (const [region, commits] of regionsOf) {
    const candidates = commits.filter(
      (c) =>
        c.files.length <= opts.maxFilesPerCommit &&
        classifyRecord(`${c.subject}\n${c.body}`).tier === 'substantive'
    );
    if (candidates.length < MIN_COMMITS_FOR_COVERAGE) {
      opts.onProgress?.(`${region}: ${candidates.length} scorable commits, below the floor — no coverage reported`);
      continue;
    }

    const sample = seededPick(candidates, opts.perRegion, region);

    // One task per sampled commit, run with bounded concurrency. Each returns its own tallies
    // rather than mutating shared counters, so the result does not depend on completion order —
    // a seeded sample has to produce the same numbers whatever order the network replies in.
    const perCommit = await mapLimit(sample, conc, async (c) => {
      let diff: string;
      try {
        diff = await readCommitDiff(opts.repo, c.sha);
      } catch {
        return null;
      }
      if (!diff.trim()) return null;

      const record = `${c.subject}\n\n${c.body}`.trim();

      // A record that quotes its own diff is not scorable. Dropped and counted here, before a prompt
      // exists — see `recordContainsRawDiff` for why this upholds the guard rather than relaxing it.
      if (recordContainsRawDiff(record)) return { unscorable: 'record-quotes-its-own-diff' as const };

      // Same digest the product uses, so every changed file is represented rather than the first
      // few thousand characters. Guard the INPUT: an earlier version inspected decompose's OUTPUT
      // after the call had already been made, so a leak into the generator prompt was invisible to
      // the very check whose error message claimed to be testing for it.
      const digest = diffDigest(diff);
      // Per-commit staging dir, because the vendored assertion reads the diff from a directory and
      // concurrent commits must not overwrite each other's diff.patch.
      const dir = join(guardDir, c.sha.slice(0, 12));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'diff.patch'), diff);
      assertDerivedFromDiff(dir, digest, `coverage/${c.sha.slice(0, 8)}`);

      let questions: { question: string }[];
      try {
        const out = await decompose(digest, opts.genBackend);
        questions = out.ok ? out.decisions : [];
      } catch (e) {
        if (e instanceof LeakageError) throw e;
        return null;
      }
      if (questions.length === 0) return null;

      const scores = await mapLimit(questions, conc, (q) => scoreOne(opts.backend, q.question, record));
      return { total: scores.length, explicit: scores.filter((x) => x === 2).length };
    });

    let explicit = 0;
    let total = 0;
    let usedCommits = 0;
    for (const r of perCommit) {
      if (!r) continue;
      if ('unscorable' in r) {
        unscorableRecords++;
        continue;
      }
      usedCommits++;
      total += r.total;
      explicit += r.explicit;
    }
    questionsAsked += total;

    if (usedCommits < MIN_COMMITS_FOR_COVERAGE || total === 0) {
      opts.onProgress?.(`${region}: only ${usedCommits} commits produced questions — no coverage reported`);
      continue;
    }
    coverage.set(region, explicit / total);
    scored.set(region, usedCommits);
    detail.set(region, { explicit, total, commits: usedCommits, rate: explicit / total });
    opts.onProgress?.(
      `${region}: ${(100 * explicit / total).toFixed(1)}% explicit over ${total} questions from ${usedCommits} commits`
    );
  }

  rmSync(guardDir, { recursive: true, force: true });
  if (unscorableRecords > 0) {
    opts.onProgress?.(
      `${unscorableRecords} sampled commits set aside: their own message quotes a diff, so the scorer ` +
        'could not judge the text alone'
    );
  }
  return { coverage, scored, detail, questionsAsked, unscorableRecords };
}

/** Attach coverage and its percentile to the regions. */
export function applyCoverage(
  regions: Region[],
  result: CoverageResult,
  percentileOf: (v: number) => number
): Region[] {
  return regions.map((r) => {
    const cov = result.coverage.get(r.path);
    if (cov === undefined) return r;
    return {
      ...r,
      recordCoverage: cov,
      recordCoveragePercentile: percentileOf(cov),
      recordCommitsScored: result.scored.get(r.path) ?? 0,
    };
  });
}
