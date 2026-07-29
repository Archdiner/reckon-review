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

/** Sample standard deviation (n−1). Zero for a constant or a single observation. */
export function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

/**
 * Pearson correlation. NaN when either variable is constant, which is a real answer — an
 * undefined correlation — and must not be printed as 0.000, because a printed zero is the claim
 * "measured, and there is nothing there".
 */
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return Number.NaN;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return Number.NaN;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Ordinary least squares slope of y on x, with no intercept term needed because both series are
 * centred inside. Returns null when x has no variation, which is the honest answer: with a
 * constant predictor there is no slope to estimate and any number returned would be invented.
 */
export function olsSlope(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  if (sxx === 0) return null;
  return sxy / sxx;
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
 * CLUSTER BOOTSTRAP OF AN ARBITRARY STATISTIC OVER REGIONS.
 *
 * `bootstrapDifference` and `bootstrapRatio` both assume the statistic is a function of two
 * arms of numbers. A regression coefficient is not: it is a function of the WHOLE sample of
 * regions, each carrying a predictor and an outcome and a stratum label, and the resampling has
 * to keep those together. Resampling the columns independently would destroy the association
 * being estimated — it is the null hypothesis, computed by accident.
 *
 * So the unit resampled here is the region RECORD, not a number. Same discipline as the other
 * two: with replacement, at the region level, percentile interval, because the statistic is a
 * ratio of sums over a small skewed sample and a normal approximation would understate the tails.
 *
 * UNDEFINED RESAMPLES ARE DISCARDED, NOT COERCED. A resample can land with no variation in the
 * predictor, or with every observation inside one stratum, and the statistic is then genuinely
 * undefined. `stat` returns null for those and the resample is dropped, exactly as
 * `bootstrapRatio` drops a zero denominator; the count comes back in `discarded` so the reader
 * can see how much of the interval is missing. A high discard count is itself the finding — it
 * means the estimate rests on a handful of influential regions.
 */
export function bootstrapStatistic<T>(
  units: T[],
  stat: (sample: T[]) => number | null,
  iterations = 2000,
  seed = 20260729
): Interval {
  const point = stat(units);
  if (units.length === 0 || point === null || !Number.isFinite(point)) {
    return { estimate: point === null ? Number.NaN : point, lo: Number.NaN, hi: Number.NaN, n: units.length, discarded: 0 };
  }
  const rng = mulberry32(seed);
  const draws: number[] = [];
  let discarded = 0;
  const buf: T[] = new Array(units.length);
  for (let i = 0; i < iterations; i++) {
    for (let j = 0; j < units.length; j++) buf[j] = units[Math.floor(rng() * units.length)]!;
    const v = stat(buf);
    if (v === null || !Number.isFinite(v)) {
      discarded++;
      continue;
    }
    draws.push(v);
  }
  if (draws.length === 0) {
    return { estimate: point, lo: Number.NaN, hi: Number.NaN, n: units.length, discarded };
  }
  draws.sort((a, b) => a - b);
  return {
    estimate: point,
    lo: quantile(draws, 0.025),
    hi: quantile(draws, 0.975),
    n: units.length,
    discarded,
  };
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
