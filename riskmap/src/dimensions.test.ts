/**
 * Dimension, squash and calibration tests.
 *
 * The squash tests are the ones that matter commercially: reporting a documentation
 * catastrophe on a repo that squashes to the title is the failure that would discredit the map
 * fastest, because the reader knows their own merge settings and this tool does not.
 */

import { computeRegion, applyFlags, inactiveIdentities, DEFAULT_THRESHOLDS, rankRegions, resolveChurnThreshold, effectiveRule } from './dimensions.js';
import { detectSquashConvention, recordUsableForFlags } from './squash.js';
import { midrankPercentile, shareBelow, loadCalibration, describePercentile } from './calibration.js';
import { isFixCommit } from './validate.js';
import type { Commit, Edit } from './types.js';

let failures = 0;
function ok(name: string, cond: boolean) {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-01T00:00:00Z');

function edit(sha: string, who: string, at = NOW, path = 'src/a.ts'): Edit {
  return { sha, who, at, path, added: 5, deleted: 1 };
}
function commit(sha: string, subject: string, body = '', at = NOW, agent = false): Commit {
  return { sha, authorName: 'n', authorEmail: 'e', at, subject, body, files: [], agentTrailer: agent, bot: false };
}

console.log('dimension tests');

{
  const cutoff = NOW - 365 * DAY;
  const inactive = inactiveIdentities(
    [
      { who: 'gone', at: NOW - 500 * DAY },
      { who: 'here', at: NOW - 10 * DAY },
      { who: 'moved', at: NOW - 400 * DAY },
      { who: 'moved', at: NOW - 5 * DAY },
    ],
    cutoff
  );
  ok('a contributor with only old commits is inactive', inactive.has('gone'));
  ok('a recent contributor is active', !inactive.has('here'));
  ok('THE MOVED-TEAMS CASE: a recent commit anywhere keeps them active', !inactive.has('moved'));
}

{
  // THE HEADLINE IS LAST-TOUCH FILE SHARE. Four files: three last touched by someone inactive,
  // one by an active contributor. The commit counts deliberately point the OTHER way — the
  // active contributor made most of the commits — so the two measures cannot be confused.
  const edits = [
    edit('c1', 'gone', NOW, 'src/a.ts'),
    edit('c2', 'gone', NOW, 'src/b.ts'),
    edit('c3', 'gone', NOW, 'src/c.ts'),
    edit('c4', 'here', NOW, 'src/d.ts'),
    edit('c5', 'here', NOW, 'src/d.ts'),
    edit('c6', 'here', NOW, 'src/d.ts'),
  ];
  const lastToucher = new Map([
    ['src/a.ts', 'gone'], ['src/b.ts', 'gone'], ['src/c.ts', 'gone'], ['src/d.ts', 'here'],
  ]);
  const r = computeRegion(
    { region: 'src', edits, commits: [], whoOf: new Map(), lastToucher, extant: true, departed: new Set(['gone']) },
    new Set(['gone']),
    24,
    DEFAULT_THRESHOLDS
  );
  ok('THE HEADLINE: orphaned share is the share of FILES last touched by an inactive contributor', Math.abs(r.orphanedShare - 0.75) < 1e-9);
  ok('the old commit-share measure is kept separately and disagrees here', Math.abs(r.orphanedCommitShare - 0.5) < 1e-9);
  ok('concentration is the largest single share of commits', Math.abs(r.concentration - 0.5) < 1e-9);
  ok('contributor counts are reported', r.contributors === 2 && r.inactiveContributors === 1);
}

{
  // THE CELL THE MAP EXISTS TO FIND: a region under active development whose files were mostly
  // last written by people who have gone. Commit-share orphaning scores this at 0.09 and cannot
  // express it; last-touch file share scores it at 0.75.
  const edits = [
    edit('old1', 'gone', NOW, 'src/a.ts'),
    edit('old2', 'gone', NOW, 'src/b.ts'),
    edit('old3', 'gone', NOW, 'src/c.ts'),
    ...Array.from({ length: 10 }, (_, i) => edit(`new${i}`, 'here', NOW, 'src/d.ts')),
  ];
  const lastToucher = new Map([
    ['src/a.ts', 'gone'], ['src/b.ts', 'gone'], ['src/c.ts', 'gone'], ['src/d.ts', 'here'],
  ]);
  const r = computeRegion(
    { region: 'src', edits, commits: [], whoOf: new Map(), lastToucher, extant: true, departed: new Set(['gone']) },
    new Set(['gone']),
    24,
    DEFAULT_THRESHOLDS
  );
  ok('THE BUSY-AND-ORPHANED CELL: file share stays high while the region is active', r.orphanedShare === 0.75);
  ok('commit share is diluted by the activity, which is why it was replaced', r.orphanedCommitShare < 0.25);
}

{
  // One contributor making one wide commit must not outvote three people making one each.
  const edits = [
    edit('wide', 'solo', NOW, 'src/a.ts'),
    edit('wide', 'solo', NOW, 'src/b.ts'),
    edit('wide', 'solo', NOW, 'src/c.ts'),
    edit('n1', 'p1'),
    edit('n2', 'p2'),
    edit('n3', 'p3'),
  ];
  const r = computeRegion({ region: 'src', edits, commits: [], whoOf: new Map(), lastToucher: new Map(), extant: true, departed: new Set(['gone']) }, new Set(), NOW, DEFAULT_THRESHOLDS);
  ok('THE WIDE-COMMIT CASE: one commit counts once however many files it touched', Math.abs(r.concentration - 0.25) < 1e-9);
}

{
  const commits = [
    commit('a', 'Fix the thing', '', NOW - 400 * DAY),
    commit('b', 'Another', 'rebase and fixing test', NOW - 10 * DAY),
    commit(
      'c',
      'Real one',
      'This changes the retry policy so a 429 backs off exponentially rather than failing fast, because the upstream limit is per-minute and a burst was exhausting it.',
      NOW - 200 * DAY
    ),
  ];
  const r = computeRegion(
    { region: 'src', edits: [edit('a', 'w'), edit('b', 'w'), edit('c', 'w')], commits, whoOf: new Map(), lastToucher: new Map(), extant: true, departed: new Set(['gone']) },
    new Set(),
    NOW,
    DEFAULT_THRESHOLDS
  );
  ok('last substantive explanation ignores chatter', r.lastSubstantiveExplanation === NOW - 200 * DAY);
}

{
  const base = computeRegion({ region: 'r', edits: [edit('c1', 'gone')], commits: [], whoOf: new Map(), lastToucher: new Map(), extant: true, departed: new Set(['gone']) }, new Set(['gone']), NOW, DEFAULT_THRESHOLDS);
  const hot = { ...base, commitsPerMonth: 10, concentration: 0.9, recordCoveragePercentile: 5 };
  const hot4 = { ...hot, orphanedShare: 0.9 };
  ok('four tests clearing flags the region', applyFlags(hot4, DEFAULT_THRESHOLDS, true, 2).flags.length === 4);
  ok('the record test is skipped when the record is unusable', applyFlags(hot4, DEFAULT_THRESHOLDS, false, 2).flags.length === 3);
  const cold = { ...base, commitsPerMonth: 0.1, concentration: 0.2, recordCoveragePercentile: 90 };
  ok('a region clearing one test does not flag', !applyFlags(cold, DEFAULT_THRESHOLDS, true, 2).flagged);

  // THE DEAD-CODE CASE: heavily orphaned, one dominant author, and quiet precisely BECAUSE it
  // was abandoned. This MUST NOT flag. An earlier rule surfaced exactly these — grafana's two
  // superseded subsystems at 0.3 and 0.5 commits a month — and a reader's correct reaction is
  // "so what". Nobody needs to understand code that is on its way out.
  const abandoned = { ...base, orphanedShare: 0.9, concentration: 0.8, commitsPerMonth: 0.2 };
  ok('THE DEAD-CODE CASE: orphaned and concentrated but quiet does NOT flag', !applyFlags(abandoned, DEFAULT_THRESHOLDS, false, 8).flagged);

  // THE CELL THE MAP IS FOR: the same ownership profile, still moving.
  const live = { ...base, orphanedShare: 0.9, concentration: 0.8, commitsPerMonth: 12 };
  ok('THE LIVE-AND-ORPHANED CELL: the same region, still moving, DOES flag', applyFlags(live, DEFAULT_THRESHOLDS, false, 8).flagged);

  // Churn alone is a busy region, not a risk.
  const justBusy = { ...base, orphanedShare: 0.1, concentration: 0.1, commitsPerMonth: 50 };
  ok('churn without an ownership signal does not flag', !applyFlags(justBusy, DEFAULT_THRESHOLDS, false, 8).flagged);

  // Churn and low coverage without an ownership signal describe a busy, terse region — which
  // is not what this artifact is about, and must not flag.
  const busy = { ...base, orphanedShare: 0.1, concentration: 0.1, commitsPerMonth: 50, recordCoveragePercentile: 2 };
  ok('churn plus low coverage without ownership does NOT flag', !applyFlags(busy, DEFAULT_THRESHOLDS, true, 8).flagged);

  // With the record dimension unscored only three tests exist, so a literal three-of-four
  // would silently become unanimity. The requirement adapts instead.
  // THE SELECTION BUG: the requirement must NOT depend on how much happened to be measurable.
  // An earlier version needed 2 of 3 unscored and 3 of 4 scored, so the same region could flag
  // only when the tool had FAILED to measure it. Scoring must only ever add evidence.
  const same = { ...base, orphanedShare: 0.9, concentration: 0.9, commitsPerMonth: 12 };
  const unscored = applyFlags(same, DEFAULT_THRESHOLDS, false, 8);
  const scoredGood = applyFlags({ ...same, recordCoverage: 0.9, recordCoveragePercentile: 95 }, DEFAULT_THRESHOLDS, true, 8);
  ok('THE SELECTION BUG: scoring coverage does not change whether a region flags', unscored.flagged === scoredGood.flagged && unscored.flagged);
}

{
  const mk = (cpm: number) => ({
    ...computeRegion({ region: 'r', edits: [edit('c1', 'w')], commits: [], whoOf: new Map(), lastToucher: new Map(), extant: true, departed: new Set(['gone']) }, new Set(), NOW, DEFAULT_THRESHOLDS),
    commitsPerMonth: cpm,
  });
  ok(
    'the churn threshold is the repo median, not an absolute',
    Math.abs(resolveChurnThreshold([mk(1), mk(8), mk(50)], DEFAULT_THRESHOLDS) - 8) < 1e-9
  );
  ok(
    'a quiet repo falls back to the absolute floor',
    resolveChurnThreshold([mk(0.1), mk(0.2), mk(0.3)], DEFAULT_THRESHOLDS) === DEFAULT_THRESHOLDS.commitsPerMonth
  );
}

{
  const mk = (p: string, o: number, c: number) => ({
    ...computeRegion({ region: p, edits: [edit('x', 'w')], commits: [], whoOf: new Map(), lastToucher: new Map(), extant: true, departed: new Set(['gone']) }, new Set(), NOW, DEFAULT_THRESHOLDS),
    orphanedShare: o,
    commitsPerMonth: c,
    flagged: true,
  });
  const ranked = rankRegions([mk('a', 0.5, 100), mk('b', 0.9, 1), mk('c', 0.9, 50)]);
  ok('ranked by orphaned share, then churn', ranked.map((r) => r.path).join(',') === 'c,b,a');
}

console.log('\nsquash tests');

{
  // THE SQUASH CASE: every commit is a title with a PR number and no body.
  const squashed = Array.from({ length: 200 }, (_, i) => commit(`s${i}`, `Do a thing (#${1000 + i})`, ''));
  const v = detectSquashConvention(squashed);
  ok('THE SQUASH CASE: title-only history marks the record unavailable', v.availability === 'unavailable');
  ok('the unavailable verdict does not contribute to flags', !recordUsableForFlags(v));
  ok('the verdict explains itself in the output', /squash-on-merge/.test(v.note));
}

{
  const rich = Array.from({ length: 200 }, (_, i) =>
    commit(
      `r${i}`,
      `Change ${i}`,
      'This rewires the cache invalidation so a write to the parent key also drops the derived keys, which previously went stale for the full TTL.'
    )
  );
  const v = detectSquashConvention(rich);
  ok('a history with real bodies is available', v.availability === 'available');
  ok('recordUsableForFlags agrees', recordUsableForFlags(v));
}

{
  // The middle band: bodies exist but rarely.
  const mixed = [
    ...Array.from({ length: 30 }, (_, i) =>
      commit(`g${i}`, `Change ${i}`, 'This alters the batching window so a slow consumer cannot stall the producer, because the queue was unbounded and grew without limit under backpressure.')
    ),
    ...Array.from({ length: 170 }, (_, i) => commit(`b${i}`, `Thing (#${i})`, '')),
  ];
  const v = detectSquashConvention(mixed);
  ok('a thin-but-nonzero body rate is low-confidence, not unavailable', v.availability === 'low-confidence');
  ok('low confidence does not contribute to flags either', !recordUsableForFlags(v));
}

ok('no commits at all is unavailable rather than a crash', detectSquashConvention([]).availability === 'unavailable');

console.log('\ncalibration tests');

{
  const sorted = [0, 0, 0, 0, 0, 0.5, 0.6, 0.7, 0.8, 1];
  ok('midrank of the tie block is its middle', Math.abs(midrankPercentile(sorted, 0) - 25) < 1e-9);
  ok('strictly-below reports the tie floor', shareBelow(sorted, 0) === 0);
  ok('midrank of the top value', Math.abs(midrankPercentile(sorted, 1) - 95) < 1e-9);
  ok('a value not present interpolates by rank', Math.abs(midrankPercentile(sorted, 0.55) - 60) < 1e-9);
}

{
  const cal = loadCalibration();
  ok('the calibration file loads', cal !== null);
  if (cal) {
    // THE COMPARISON SET IS SUBSTANTIVE-ONLY, and that is the correction. This tool scores only
    // substantive commits, so comparing against a corpus that also holds 164 empty and 125 trivial
    // records made every percentile 8-17 points too flattering — a bias opposite in sign to the
    // "biased low" hedge the tool used to ship, and larger.
    ok('percentiles use the substantive-only set, not all 1,000 PRs', cal.n === 711 && cal.sorted.length === 711);
    ok('the unrestricted distribution is retained so the restriction is checkable', (cal.sortedAll?.length ?? 0) === 1000);
    ok('the scoring mode is recorded, having previously been mislabelled', cal.scoringMode === 'paired');
    ok('THE ZERO MASS SURVIVES THE RESTRICTION: over a third still score zero', cal.shareAtZero > 0.35 && cal.shareAtZero < 0.45);
    ok('and it shrank, which is exactly why percentiles were too flattering', cal.shareAtZero < (cal.shareAtZeroAll ?? 1));
    ok(
      'the undocumented threshold still sits just above the zero mass in the corrected set',
      midrankPercentile(cal.sorted, 0) < DEFAULT_THRESHOLDS.coveragePercentile &&
        DEFAULT_THRESHOLDS.coveragePercentile - midrankPercentile(cal.sorted, 0) < 6
    );
    ok(
      'the restriction really does move a percentile by a lot',
      midrankPercentile(cal.sortedAll ?? [], 0.1) - midrankPercentile(cal.sorted, 0.1) > 8
    );
    ok('the phrasing says tied rather than ranked inside the zero mass', /tie/.test(describePercentile(cal, 0)));
    ok('the phrasing avoids the word decile', !/decile/.test(describePercentile(cal, 0)));
  }
}

console.log('\nfix-commit detection');

ok('a revert is a fix commit', isFixCommit('Revert "Add caching"', ''));
ok('a hotfix is a fix commit', isFixCommit('hotfix: restore the health endpoint', ''));
ok('a regression reference is a fix commit', isFixCommit('Correct the offset', 'Regression introduced by abc123.'));
ok('an ordinary bug fix is NOT a fix commit', !isFixCommit('fix: handle empty input', 'Guards against a nil map.'));
ok('a feature is not a fix commit', !isFixCommit('Add pagination to the search API', ''));


console.log('\nregression tests for defects found in review');

{
  // The page must print the rule that RAN, not the configured minFlags. The shipped grafana
  // example said "at least 3 of these tests" above two rows carrying two chips each.
  const withRecord = effectiveRule(DEFAULT_THRESHOLDS, true);
  const withoutRecord = effectiveRule(DEFAULT_THRESHOLDS, false);
  ok('the requirement is uniform whether or not coverage was scored', withRecord.need === withoutRecord.need && withRecord.need === 2);
  ok('available tests are still reported so the page can say what was measurable', withRecord.available === 4 && withoutRecord.available === 3);
}

{
  // Churn must divide by the observed span, not the configured window. An 18-month repo was
  // having every rate divided by 60.
  const edits = Array.from({ length: 20 }, (_, i) => edit(`c${i}`, 'w'));
  const short = computeRegion({ region: 'r', edits, commits: [], whoOf: new Map(), lastToucher: new Map(), extant: true, departed: new Set(['gone']) }, new Set(), 18, DEFAULT_THRESHOLDS);
  const long = computeRegion({ region: 'r', edits, commits: [], whoOf: new Map(), lastToucher: new Map(), extant: true, departed: new Set(['gone']) }, new Set(), 60, DEFAULT_THRESHOLDS);
  ok('THE YOUNG-REPO CASE: churn uses the observed span', Math.abs(short.commitsPerMonth - 20 / 18) < 1e-9);
  ok('a longer span gives a lower rate for the same commits', long.commitsPerMonth < short.commitsPerMonth);
}

{
  // THE DELETED-DIRECTORY CASE, which contaminated both the map and its validation. A region
  // built entirely from commits to files that no longer exist scored the same as a live one,
  // and then — being deleted — received no further commits, which the harness read as a
  // correct prediction of dormancy. Extancy is a precondition, not a threshold.
  const seed = computeRegion({ region: 'r', edits: [edit('c1', 'gone')], commits: [], whoOf: new Map(), lastToucher: new Map(), extant: true, departed: new Set(['gone']) }, new Set(['gone']), 24, DEFAULT_THRESHOLDS);
  const live = { ...seed, orphanedShare: 0.9, concentration: 0.8, commitsPerMonth: 12, extant: true };
  const deleted = { ...live, extant: false };
  ok('THE DELETED-DIRECTORY CASE: a region with no files left cannot flag', !applyFlags(deleted, DEFAULT_THRESHOLDS, false, 8).flagged);
  ok('the same region, still present, does flag', applyFlags(live, DEFAULT_THRESHOLDS, false, 8).flagged);
  ok('the dimensions are still computed and shown for a deleted region', applyFlags(deleted, DEFAULT_THRESHOLDS, false, 8).flags.length === 3);
}

console.log(failures === 0 ? '\nall dimension tests passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
