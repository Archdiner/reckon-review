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
import { readCommitDiff } from './gitlog.js';
import { diffDigest } from './vendor/diff-digest.js';
import { classifyRecord } from './vendor/triviality.js';
import type { Commit, Region } from './types.js';

/** Fewer scored commits than this and the region reports no coverage at all. */
export const MIN_COMMITS_FOR_COVERAGE = 3;

export class LeakageError extends Error {}

/** Unified-diff syntax that must never appear in a scorer prompt. */
const DIFF_SYNTAX = /^(diff --git |index [0-9a-f]{7,}|@@ -\d|\+\+\+ |--- )/m;

function assertNoDiffInScorerPrompt(prompt: string): void {
  if (DIFF_SYNTAX.test(prompt)) {
    throw new LeakageError(
      'A scorer prompt contained raw diff syntax. The scorer must judge the record alone; if it ' +
        'can see the code it will score what the code says rather than what the author wrote.'
    );
  }
}

function assertRecordNotInQuestionPrompt(prompt: string, message: string): void {
  // The question generator receives the diff and nothing else. A commit message that is a
  // subset of the diff is legitimate (a docs commit adds the prose it describes), so the check
  // is on distinctive CONSECUTIVE runs rather than on any overlap — the study made exactly this
  // mistake once and its correction is the reason this is worded this way.
  //
  // THE FIRST VERSION OF THIS GUARD COULD NOT FIRE. It filtered short words OUT of the message
  // and then searched the prompt for the joined remainder, so the shingle it looked for did not
  // occur even in the message it was built from. Handing it the commit message verbatim as the
  // "prompt" passed. A guard that cannot fire is worse than no guard, because it is read as
  // evidence. Shingles are now consecutive runs of the ORIGINAL text, normalised only for
  // whitespace and case.
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, ' ').trim();
  const hay = norm(prompt);
  const words = norm(message).split(' ').filter(Boolean);
  if (words.length < 8) return;
  for (let i = 0; i + 8 <= words.length; i++) {
    const shingle = words.slice(i, i + 8).join(' ');
    // A run of pure path/identifier tokens can legitimately appear in both.
    if (/^[\w./-]+( [\w./-]+)*$/.test(shingle) && !/[a-z]{3,} [a-z]{3,} [a-z]{3,}/.test(shingle)) continue;
    if (hay.includes(shingle)) {
      throw new LeakageError(
        `A question-generation input contained an 8-word run from the commit message: "${shingle.slice(0, 80)}". ` +
          'Questions must come from the diff alone or the record is being scored against itself.'
      );
    }
  }
}

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
  onProgress?: (msg: string) => void;
}

export interface CoverageResult {
  /** Region path → mean explicit rate in [0,1]. */
  coverage: Map<string, number>;
  scored: Map<string, number>;
  questionsAsked: number;
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
  const coverage = new Map<string, number>();
  const scored = new Map<string, number>();
  let questionsAsked = 0;

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
    let explicit = 0;
    let total = 0;
    let usedCommits = 0;

    for (const c of sample) {
      let diff: string;
      try {
        diff = await readCommitDiff(opts.repo, c.sha);
      } catch {
        continue;
      }
      if (!diff.trim()) continue;

      const record = `${c.subject}\n\n${c.body}`.trim();

      // Same digest the product uses, so every changed file is represented rather than the
      // first few thousand characters. Without it, questions about a wide commit come from its
      // opening files and systematically miss the tail, which would depress coverage for
      // reasons that have nothing to do with how the author wrote.
      // Guard the INPUT. The earlier version only inspected decompose's OUTPUT, after the call
      // had already been made — so a leak into the generator prompt was unobservable by the
      // thing whose error message claimed to be checking exactly that.
      const digest = diffDigest(diff);
      assertRecordNotInQuestionPrompt(digest, record);

      let questions: { question: string }[];
      try {
        const out = await decompose(digest, opts.genBackend);
        questions = out.ok ? out.decisions : [];
      } catch (e) {
        if (e instanceof LeakageError) throw e;
        continue;
      }
      if (questions.length === 0) continue;

      for (const q of questions) {
        assertRecordNotInQuestionPrompt(q.question, record);
      }

      usedCommits++;
      for (const q of questions) {
        const s = await scoreOne(opts.backend, q.question, record);
        total++;
        questionsAsked++;
        if (s === 2) explicit++;
      }
    }

    if (usedCommits < MIN_COMMITS_FOR_COVERAGE || total === 0) {
      opts.onProgress?.(`${region}: only ${usedCommits} commits produced questions — no coverage reported`);
      continue;
    }
    coverage.set(region, explicit / total);
    scored.set(region, usedCommits);
    opts.onProgress?.(
      `${region}: ${(100 * explicit / total).toFixed(1)}% explicit over ${total} questions from ${usedCommits} commits`
    );
  }

  return { coverage, scored, questionsAsked };
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
