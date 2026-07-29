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
