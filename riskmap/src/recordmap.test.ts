/**
 * Record-map tests.
 *
 * The interval and the greying rule are the load-bearing parts. On a table, an estimate from three
 * commits is visibly an estimate from three commits. On a heatmap it is a confident block of
 * colour, indistinguishable from one backed by fifty — which is the exact failure mode this whole
 * artifact has to avoid, so it is the part that gets tested hardest.
 */

import { wilson, MIN_SCORED_COMMITS, MAX_CI_HALF_WIDTH, DEFAULT_PER_REGION } from './recordmap.js';

let failures = 0;
function ok(name: string, cond: boolean) {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

console.log('record-map interval tests');

{
  // The case the normal approximation gets wrong, and the case that matters most: a region that
  // explained nothing. The naive interval runs below zero and understates the uncertainty.
  const w = wilson(0, 16);
  ok('a 0-of-16 region has a lower bound of exactly 0, not below it', w.lo === 0);
  ok('and an upper bound that is NOT 0 — 16 questions cannot rule out real coverage', w.hi > 0.15);
  ok('the upper bound stays inside [0,1]', w.hi <= 1);
}

{
  const w = wilson(16, 16);
  ok('a 16-of-16 region has an upper bound of exactly 1', w.hi === 1);
  ok('and a lower bound well below 1', w.lo < 0.9 && w.lo > 0.7);
}

{
  // Width must shrink as the denominator grows, or the interval is not doing its job.
  const few = wilson(2, 8);
  const many = wilson(25, 100);
  ok('the same rate on more questions gives a tighter interval', many.hi - many.lo < few.hi - few.lo);
}

{
  const w = wilson(8, 16);
  ok('a mid-scale estimate brackets its point estimate', w.lo < 0.5 && w.hi > 0.5);
}

ok('a zero denominator returns the whole range rather than dividing by zero', wilson(0, 0).lo === 0 && wilson(0, 0).hi === 1);

console.log('\nthe greying rule');

{
  // THE CASE THIS ARTIFACT EXISTS TO NOT SHIP: three commits, a tidy-looking rate, and an
  // interval so wide the colour would be meaningless.
  const thin = wilson(1, 9);
  const half = (thin.hi - thin.lo) / 2;
  ok('THE THIN-CELL CASE: a 1-of-9 estimate exceeds the interval-width limit', half > MAX_CI_HALF_WIDTH);
  ok('the commit floor is above the coverage floor, so thin cells grey before they colour', MIN_SCORED_COMMITS > 3);
}

{
  // And a genuinely usable cell must NOT be greyed, or the map goes uniformly grey and says
  // nothing — the opposite failure and just as useless.
  const solid = wilson(12, 40);
  const half = (solid.hi - solid.lo) / 2;
  ok('a 12-of-40 estimate is inside the interval-width limit', half <= MAX_CI_HALF_WIDTH);
}

{
  // The boundary worth pinning: how many questions does it take to earn colour at the worst rate
  // for interval width, which is p = 0.5?
  let n = 4;
  while (n < 500) {
    const w = wilson(Math.round(n / 2), n);
    if ((w.hi - w.lo) / 2 <= MAX_CI_HALF_WIDTH) break;
    n++;
  }
  console.log(`        (a p=0.5 region needs ${n} questions to earn colour at the current limit)`);
  ok('the limit is reachable at a realistic sample size', n <= 60);
}

{
  // The sampling budget must actually clear the interval limit at the observed question yield,
  // or the default ships a map that is mostly grey. Measured yield on grafana: ~3.2 questions per
  // commit. This pins the two constants together so raising one without the other fails here.
  const YIELD = 3.2;
  const q = Math.floor(DEFAULT_PER_REGION * YIELD);
  const w = wilson(Math.round(q / 2), q);
  ok(
    `THE BUDGET MATCHES THE LIMIT: ${DEFAULT_PER_REGION} commits yields ~${q} questions, inside the width limit`,
    (w.hi - w.lo) / 2 <= MAX_CI_HALF_WIDTH
  );
  const qLow = Math.floor(5 * YIELD);
  const wLow = wilson(Math.round(qLow / 2), qLow);
  ok('and the old 5-commit budget did NOT clear it — which is why the default moved', (wLow.hi - wLow.lo) / 2 > MAX_CI_HALF_WIDTH);
}

console.log(failures === 0 ? '\nall record-map tests passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
