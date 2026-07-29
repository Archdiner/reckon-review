/**
 * Step 7 — percentile calibration against the study corpus.
 *
 * This is where the study pays for itself. A raw coverage number is meaningless to a reader:
 * nobody has an intuition for whether 0.34 is good. A position in a known distribution is
 * immediately understood, and the distribution is one nobody else has.
 *
 * THE CORPUS: 1,000 merged pull requests from Grafana, Airflow, Supabase, LangChain and
 * Prisma, scored for the share of mechanism questions their written record answers explicitly,
 * with the production question generator. Derived from `study/results/per-pr-scores.csv` rather
 * than copied, with the source commit recorded, so a reader can rebuild it. That file is the
 * PAIRED stage-4 run; an earlier version of the calibration file claimed independent scoring and
 * was simply wrong about its own provenance.
 *
 * ── THE CORRECTION THE BUILD SPEC NEEDS ───────────────────────────────────────────────────
 *
 * The spec asks for the output line "this region sits in the bottom decile of record
 * coverage". That sentence cannot be said honestly against this corpus, and the reason is a
 * finding rather than a technicality:
 *
 *   38.4% OF THE COMPARISON SET SCORES EXACTLY ZERO — and 55.7% of the unrestricted corpus did.
 *
 * The bottom three deciles are 0.0. There is no bottom decile to sit in — a region with no
 * explicit answers is tied with well over a third of the set, and any statement distinguishing
 * decile 1 from decile 3 is describing sampling noise in a tie. This is the same bimodality the
 * study insists on when it refuses to lead with means: the mass is at the ends.
 *
 * So the tool reports MIDRANK percentiles (the standard treatment of ties: a value tied with a
 * block gets the middle of that block's rank range) and phrases the output as "lower than or
 * tied with N% of 1,000 merged pull requests". It never says "decile" for a value inside the
 * zero mass, because that would be a precision the data does not have.
 *
 * A consequence worth stating rather than hiding: the midrank percentile of a zero-coverage
 * region is 19.2 in the corrected set, so an "undocumented" threshold set below that could NEVER
 * fire on a region whose sampled commits explained nothing at all. That is why the default sits just above it
 * (see DEFAULT_THRESHOLDS.coveragePercentile) — a stated reason, not a round number.
 *
 * ── WHAT THE COMPARISON IS AND IS NOT ─────────────────────────────────────────────────────
 *
 * ── A CORRECTION: THE UNIT MISMATCH HEDGE WAS WRONG IN PREMISE AND IN SIGN ────────────────
 *
 * This file used to carry: "the study scores a PR record — description plus commit messages —
 * while this tool scores commit messages only, so a region's percentile is biased LOW."
 *
 * BOTH HALVES WERE FALSE, and measuring it is what showed that.
 *
 * The premise is false. `study/src/stage1_collect.ts` builds its record from `%s` and `%b` of
 * `git log --no-merges` — subject and body of one squash commit. `coverage.ts` builds its record
 * from `${c.subject}\n\n${c.body}`: THE SAME TWO FIELDS OF THE SAME COMMAND. All five corpus
 * repositories were admitted precisely because descriptions survive their merge button, so where
 * a squash body holds the description, this tool reads it. There is no missing channel to correct
 * for. The two arms are not subset and superset; they are the same arm.
 *
 * And the measurable bias runs the OTHER WAY, from a source the hedge never mentioned. This tool
 * scores only commits graded SUBSTANTIVE, while the corpus distribution also contains 164 empty
 * and 125 trivial records that drag it down. Comparing a substantive-only measurement against a
 * distribution that includes them made every percentile 8 to 17 points TOO FLATTERING — the
 * opposite sign to the retracted hedge, comparable magnitude, and requiring no assumption about
 * missing channels at all.
 *
 * So percentiles are now computed against the SUBSTANTIVE-ONLY distribution (n=711), which is the
 * like-for-like set. The unrestricted distribution stays in the file so the restriction can be
 * checked rather than taken on trust.
 *
 * What remains genuinely unknown: for a repository that does NOT squash, this tool reads one
 * commit's message and generates questions from one commit's diff, so numerator and denominator
 * both narrow and the net direction is not knowable a priori. That is a conditional the squash
 * detector already computes per repository, and it belongs there rather than in a blanket hedge.
 *
 * WHY REGIONS OF DIFFERENT SIZES ARE COMPARED WITHOUT NORMALISING. Because the study measured
 * that they can be. Record coverage is flat across a tenfold range of change size — under 3
 * points of movement in either provenance arm, against 25-26 points for a measure that does
 * respond to size. Coverage does not have to be normalised for size because it does not vary
 * with it. That is a defensible design decision rather than a hand-wave, and it is only
 * available because someone measured it.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { CalibrationInfo } from './types.js';

export interface Calibration extends CalibrationInfo {
  measure: string;
  /** 'paired' — see the file's scoringModeNote. Recorded because it was previously mislabelled. */
  scoringMode?: string;
  /** 'substantive' — the like-for-like comparison set. See below. */
  comparisonSet?: string;
  /** The unrestricted distribution, kept so the restriction is checkable rather than asserted. */
  sortedAll?: number[];
  shareAtZeroAll?: number;
  nAll?: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  /** Share of the corpus scoring exactly zero. The reason deciles are not usable. */
  shareAtZero: number;
  sorted: number[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(HERE, '..', 'calibration', 'study-coverage.json');

export function loadCalibration(path = DEFAULT_PATH): Calibration | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Calibration;
}

/**
 * Midrank percentile of `value` within the corpus, in [0,100].
 *
 * Ties take the middle of their rank block, which is what makes the zero mass report as ~27.9
 * rather than as either 0 (maximally alarming, and unfair) or 55.7 (maximally reassuring, and
 * equally unfair). Neither extreme is a description of the data.
 */
export function midrankPercentile(sorted: number[], value: number): number {
  if (sorted.length === 0) return 0;
  let below = 0;
  let equal = 0;
  for (const v of sorted) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  return ((below + equal / 2) / sorted.length) * 100;
}

/** Share of the corpus strictly below `value`, in [0,100]. Reported alongside for context. */
export function shareBelow(sorted: number[], value: number): number {
  if (sorted.length === 0) return 0;
  let below = 0;
  for (const v of sorted) if (v < value) below++;
  return (below / sorted.length) * 100;
}

/**
 * The sentence that goes on the page.
 *
 * Deliberately avoids "decile" whenever the value sits inside a tie block large enough that a
 * decile would be fiction — which for this corpus means any value at or near zero.
 */
export function describePercentile(cal: Calibration, value: number): string {
  const p = midrankPercentile(cal.sorted, value);
  const tied = cal.sorted.filter((v) => v === value).length / cal.sorted.length;
  const n = cal.sorted.length.toLocaleString('en-US');

  if (tied >= 0.1) {
    return (
      `lower than or tied with ${p.toFixed(0)}% of ${n} merged pull requests from five large ` +
      `open-source projects — ${(tied * 100).toFixed(0)}% of that corpus scores exactly the same, ` +
      'so this is a position in a tie rather than a rank'
    );
  }
  return `lower than ${p.toFixed(0)}% of ${n} merged pull requests from five large open-source projects`;
}
