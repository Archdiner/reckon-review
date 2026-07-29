/**
 * Uncertainty, done the way the study does it.
 *
 * CLUSTER BOOTSTRAP OVER REGIONS, not over commits. A region contributes many post-T commits
 * and they are anything but independent — they share authors, a subsystem and a release cycle.
 * Resampling commits would shrink every interval by roughly the square root of the cluster size
 * and manufacture significance out of nothing. The unit of resampling is the unit of
 * assignment, which here is the region.
 *
 * REPORT DISTRIBUTIONS, NOT MEANS. The same discipline the study applies to bimodal record
 * scores applies here: outcome rates across regions are skewed, and a difference of means can
 * describe no actual region. `quantiles()` exists so the report can lead with the shape.
 */

/** Deterministic PRNG, so a validation run reproduces. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const k = (sorted.length - 1) * p;
  const f = Math.floor(k);
  const c = Math.min(f + 1, sorted.length - 1);
  return sorted[f]! + (sorted[c]! - sorted[f]!) * (k - f);
}

export function quantiles(xs: number[]): { p10: number; p25: number; p50: number; p75: number; p90: number } {
  const s = [...xs].sort((a, b) => a - b);
  return {
    p10: quantile(s, 0.1),
    p25: quantile(s, 0.25),
    p50: quantile(s, 0.5),
    p75: quantile(s, 0.75),
    p90: quantile(s, 0.9),
  };
}

export interface Interval {
  estimate: number;
  lo: number;
  hi: number;
  n: number;
  /**
   * Bootstrap resamples thrown away because the statistic was undefined on them — only ever
   * non-zero for `bootstrapRatio`, where a resample can land a denominator of exactly zero.
   * Reported rather than hidden: an interval built from 4,000 of 5,000 resamples is a different
   * object from one built from all of them, and the reader should be able to see which they have.
   */
  discarded?: number;
}

/**
 * Bootstrap the difference in means between two independent groups of regions.
 *
 * Both groups are resampled with replacement at the region level. Returns a percentile
 * interval, which is the right choice here because the statistic is a difference of means over
 * a small, skewed sample and a normal approximation would understate the tails.
 */
export function bootstrapDifference(
  a: number[],
  b: number[],
  iterations = 5000,
  seed = 20260729
): Interval {
  const rng = mulberry32(seed);
  const estimate = mean(a) - mean(b);
  if (a.length === 0 || b.length === 0) return { estimate: 0, lo: 0, hi: 0, n: 0 };

  const diffs: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sa = 0;
    for (let j = 0; j < a.length; j++) sa += a[Math.floor(rng() * a.length)]!;
    let sb = 0;
    for (let j = 0; j < b.length; j++) sb += b[Math.floor(rng() * b.length)]!;
    diffs.push(sa / a.length - sb / b.length);
  }
  diffs.sort((x, y) => x - y);
  return {
    estimate,
    lo: quantile(diffs, 0.025),
    hi: quantile(diffs, 0.975),
    n: a.length + b.length,
  };
}

/**
 * Bootstrap the RATIO of means between two independent groups of regions — a risk ratio when
 * the inputs are 0/1 indicators, which is the use this exists for.
 *
 * Same resampling scheme as `bootstrapDifference`: with replacement, at the region level,
 * percentile interval. The ratio is reported alongside the difference rather than instead of it
 * because they fail in opposite ways — a ratio is unstable when the baseline is small and a
 * difference hides how large the effect is relative to that baseline.
 *
 * ZERO DENOMINATORS ARE DISCARDED, NOT EMITTED AS Infinity. A resample of the comparison arm can
 * contain no events at all, especially when the baseline rate is low and the arm is small. The
 * ratio is then undefined, and the two obvious alternatives are both wrong: `Infinity` poisons
 * the sort and drags the upper bound to infinity, and continuity corrections (adding 0.5 to
 * every cell) silently change the estimand. So the resample is dropped and the count of drops is
 * returned in `discarded`, which lets the report say how much of the interval is missing. If a
 * large share was discarded the upper bound is not trustworthy and the reader can see that.
 *
 * Assumes non-negative inputs, which is what a ratio of rates is defined over.
 */
export function bootstrapRatio(
  a: number[],
  b: number[],
  iterations = 5000,
  seed = 20260729
): Interval {
  const rng = mulberry32(seed);
  const mb = mean(b);
  const estimate = mb === 0 ? Number.NaN : mean(a) / mb;
  // n === 0 is the caller's "not computed" signal, exactly as in bootstrapDifference. NaN rather
  // than 0 for the estimate, because a printed 0.000 risk ratio is a claim and this is not one.
  if (a.length === 0 || b.length === 0 || mb === 0) {
    return { estimate, lo: Number.NaN, hi: Number.NaN, n: 0, discarded: 0 };
  }

  const ratios: number[] = [];
  let discarded = 0;
  for (let i = 0; i < iterations; i++) {
    let sa = 0;
    for (let j = 0; j < a.length; j++) sa += a[Math.floor(rng() * a.length)]!;
    let sb = 0;
    for (let j = 0; j < b.length; j++) sb += b[Math.floor(rng() * b.length)]!;
    if (sb === 0) {
      discarded++;
      continue;
    }
    ratios.push(sa / a.length / (sb / b.length));
  }
  if (ratios.length === 0) {
    return { estimate, lo: Number.NaN, hi: Number.NaN, n: 0, discarded };
  }
  ratios.sort((x, y) => x - y);
  return {
    estimate,
    lo: quantile(ratios, 0.025),
    hi: quantile(ratios, 0.975),
    n: a.length + b.length,
    discarded,
  };
}
