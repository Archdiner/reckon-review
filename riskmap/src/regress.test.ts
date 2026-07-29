/**
 * Regression-machinery tests.
 *
 * The estimators here are implemented by hand in plain TypeScript, so the arithmetic is the thing
 * most likely to be quietly wrong — and a quietly wrong slope would be reported to a reader as a
 * finding about their codebase. Every case below is one whose right answer can be worked out
 * without the code: a known slope, a known confound, a constant predictor, a stratum structure
 * whose within-band answer differs from its pooled one in a direction that can be reasoned about.
 *
 * The last of those is the one that matters. If `withinBandSlope` silently fell back to the
 * unadjusted slope, every "churn-adjusted" number in the report would be an unadjusted number
 * with a different label, and nothing else in the pipeline would notice.
 */

import { churnBandsOf, withinBandSlope } from './regress.js';
import { bootstrapStatistic, olsSlope, pearson, sd } from './stats.js';

let failures = 0;
function ok(name: string, cond: boolean) {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}
const near = (a: number | null, b: number, eps = 1e-9) => a !== null && Math.abs(a - b) < eps;

console.log('regression tests');

// ---- OLS ----------------------------------------------------------------------------------
{
  const xs = [1, 2, 3, 4, 5];
  const ys = xs.map((x) => 3 * x + 7);
  ok('exact line recovers its slope', near(olsSlope(xs, ys), 3));
  ok('exact line correlates at 1', near(pearson(xs, ys), 1, 1e-12));
  ok('a constant predictor has no slope, and says so', olsSlope([2, 2, 2], [1, 2, 3]) === null);
  ok('a constant predictor has no correlation, and does not print 0', Number.isNaN(pearson([2, 2, 2], [1, 2, 3])));
  ok('one observation is not a slope', olsSlope([1], [1]) === null);
  ok('sd of a constant is zero', sd([4, 4, 4]) === 0);
}

// ---- within-band pooling ------------------------------------------------------------------
{
  // Two bands. Inside each, y = -1 * x. Between bands, the band means move UP with x, hard enough
  // that the unadjusted slope is positive. Adjustment must recover the negative within-band slope;
  // an estimator that ignored the bands would report roughly +1.
  const rows = [
    { band: 0, x: 0, y: 10 },
    { band: 0, x: 1, y: 9 },
    { band: 0, x: 2, y: 8 },
    { band: 1, x: 10, y: 40 },
    { band: 1, x: 11, y: 39 },
    { band: 1, x: 12, y: 38 },
  ];
  const un = olsSlope(rows.map((r) => r.x), rows.map((r) => r.y));
  ok('the unadjusted slope is dragged positive by the between-band confound', un !== null && un > 2);
  ok('the within-band slope recovers the true −1', near(withinBandSlope(rows), -1, 1e-9));
}
{
  // Equivalence check against the definition: with a single band, the within estimator IS OLS.
  const rows = [
    { band: 0, x: 1, y: 2 },
    { band: 0, x: 2, y: 5 },
    { band: 0, x: 4, y: 6 },
    { band: 0, x: 7, y: 11 },
  ];
  const a = withinBandSlope(rows);
  const b = olsSlope(rows.map((r) => r.x), rows.map((r) => r.y));
  ok('one band reduces exactly to OLS', a !== null && b !== null && Math.abs(a - b) < 1e-12);
}
{
  const rows = [
    { band: 0, x: 1, y: 1 },
    { band: 1, x: 5, y: 9 },
  ];
  ok('bands of one contribute nothing, so the estimand does not exist', withinBandSlope(rows) === null);
  ok('a predictor constant inside every band yields null, not zero', withinBandSlope([
    { band: 0, x: 1, y: 1 },
    { band: 0, x: 1, y: 4 },
    { band: 1, x: 9, y: 2 },
    { band: 1, x: 9, y: 7 },
  ]) === null);
}

// ---- banding ------------------------------------------------------------------------------
{
  const b = churnBandsOf([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 10);
  ok('ten distinct values cut into ten bands, in order', b.join(',') === '0,1,2,3,4,5,6,7,8,9');
  const tied = churnBandsOf([0, 0, 0, 0, 5, 6, 7, 8, 9, 10], 10);
  ok('tied values never straddle a band boundary', tied[0] === tied[1] && tied[1] === tied[2] && tied[2] === tied[3]);
  ok('banding is order-preserving for untied values', tied[4]! < tied[9]!);
  ok('an empty sample bands to nothing', churnBandsOf([], 10).length === 0);
  const shuffled = churnBandsOf([9, 3, 7, 1], 2);
  ok('bands follow the value, not the input position', shuffled[3]! === 0 && shuffled[0]! === 1);
}

// ---- cluster bootstrap --------------------------------------------------------------------
{
  const units = Array.from({ length: 200 }, (_, i) => ({ x: i, y: 2 * i }));
  const iv = bootstrapStatistic(units, (s) => olsSlope(s.map((u) => u.x), s.map((u) => u.y)), 400, 7);
  ok('bootstrap point estimate is the sample statistic', near(iv.estimate, 2, 1e-9));
  ok('a deterministic relation gives a tight interval', Math.abs(iv.hi - iv.lo) < 1e-6);
  ok('bootstrap reports the unit count', iv.n === 200);

  const same = bootstrapStatistic(units, (s) => olsSlope(s.map((u) => u.x), s.map((u) => u.y)), 400, 7);
  ok('the same seed reproduces the same interval', same.lo === iv.lo && same.hi === iv.hi);

  // Resampling must keep the pair together. If it did not, the estimate on a real association
  // would collapse toward zero — this is that check, on data with noise so the two differ.
  const noisy = units.map((u, i) => ({ x: u.x, y: u.y + (i % 7) * 13 }));
  const kept = bootstrapStatistic(noisy, (s) => olsSlope(s.map((u) => u.x), s.map((u) => u.y)), 400, 7);
  ok('the association survives resampling of whole units', kept.lo > 1.5 && kept.hi < 2.5);

  const undef = bootstrapStatistic(
    [{ x: 1, y: 1 }, { x: 1, y: 2 }],
    (s) => olsSlope(s.map((u) => u.x), s.map((u) => u.y)),
    50,
    7
  );
  ok('an undefined statistic is not coerced to a number', !Number.isFinite(undef.estimate));
}

console.log(failures === 0 ? 'regression tests passed' : `${failures} FAILURES`);
if (failures > 0) process.exit(1);
