/**
 * Step 7 — percentile calibration against the study corpus.
 *
 * This is where the study pays for itself. A raw coverage number is meaningless to a reader:
 * nobody has an intuition for whether 0.34 is good. A position in a known distribution is
 * immediately understood, and the distribution is one nobody else has.
 *
 * THE CORPUS: 1,000 merged pull requests from Grafana, Airflow, Supabase, LangChain and
 * Prisma, scored for the share of mechanism questions their written record answers explicitly,
 * with the production question generator and independent scoring. Derived from
 * `study/results/per-pr-scores.csv` rather than copied, with the source commit recorded, so a
 * reader can rebuild it.
 *
 * ── THE CORRECTION THE BUILD SPEC NEEDS ───────────────────────────────────────────────────
 *
 * The spec asks for the output line "this region sits in the bottom decile of record
 * coverage". That sentence cannot be said honestly against this corpus, and the reason is a
 * finding rather than a technicality:
 *
 *   55.7% OF THE 1,000 PRs SCORE EXACTLY ZERO.
 *
 * Deciles 1 through 5 are all 0.0. There is no bottom decile to sit in — a region with no
 * explicit answers is tied with more than half the corpus, and any statement that distinguishes
 * decile 1 from decile 5 is describing sampling noise in a tie. This is the same bimodality the
 * study insists on when it refuses to lead with means: the mass is at the ends.
 *
 * So the tool reports MIDRANK percentiles (the standard treatment of ties: a value tied with a
 * block gets the middle of that block's rank range) and phrases the output as "lower than or
 * tied with N% of 1,000 merged pull requests". It never says "decile" for a value inside the
 * zero mass, because that would be a precision the data does not have.
 *
 * A consequence worth stating rather than hiding: the midrank percentile of a zero-coverage
 * region is ~27.9, so an "undocumented" threshold set below that could NEVER fire on a region
 * whose sampled commits explained nothing at all. That is why the default sits just above it
 * (see DEFAULT_THRESHOLDS.coveragePercentile) — a stated reason, not a round number.
 *
 * ── WHAT THE COMPARISON IS AND IS NOT ─────────────────────────────────────────────────────
 *
 * UNIT MISMATCH, STATED UP FRONT. The study scores a PULL REQUEST RECORD — description plus
 * commit messages. This tool scores COMMIT MESSAGES ONLY, because a clone is the whole
 * dependency and PR descriptions are not in it. The two are close but not identical, and the
 * direction of the difference is knowable: a commit-only record is a SUBSET of a PR record, so
 * a region's percentile against this corpus is biased LOW. A region that looks bad may be
 * partly an artifact of the missing channel; a region that looks fine is fine a fortiori.
 * Squash detection removes the worst version of this, not all of it.
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
