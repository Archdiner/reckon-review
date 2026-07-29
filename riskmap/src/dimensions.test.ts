/**
 * Dimension, squash and calibration tests.
 *
 * The squash tests are the ones that matter commercially: reporting a documentation
 * catastrophe on a repo that squashes to the title is the failure that would discredit the map
 * fastest, because the reader knows their own merge settings and this tool does not.
 */

import { computeRegion, applyFlags, inactiveIdentities, DEFAULT_THRESHOLDS, rankRegions, resolveChurnThreshold } from './dimensions.js';
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
  // 3 commits from an inactive contributor, 1 from an active one.
  const edits = [edit('c1', 'gone'), edit('c2', 'gone'), edit('c3', 'gone'), edit('c4', 'here')];
  const r = computeRegion(
    { region: 'src', edits, commits: [], whoOf: new Map() },
    new Set(['gone']),
    NOW,
    DEFAULT_THRESHOLDS
  );
  ok('orphaned share counts commits, not contributors', Math.abs(r.orphanedShare - 0.75) < 1e-9);
  ok('concentration is the largest single share', Math.abs(r.concentration - 0.75) < 1e-9);
  ok('contributor counts are reported', r.contributors === 2 && r.inactiveContributors === 1);
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
  const r = computeRegion({ region: 'src', edits, commits: [], whoOf: new Map() }, new Set(), NOW, DEFAULT_THRESHOLDS);
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
    { region: 'src', edits: [edit('a', 'w'), edit('b', 'w'), edit('c', 'w')], commits, whoOf: new Map() },
    new Set(),
    NOW,
    DEFAULT_THRESHOLDS
  );
  ok('last substantive explanation ignores chatter', r.lastSubstantiveExplanation === NOW - 200 * DAY);
}

{
  const base = computeRegion({ region: 'r', edits: [edit('c1', 'gone')], commits: [], whoOf: new Map() }, new Set(['gone']), NOW, DEFAULT_THRESHOLDS);
  const hot = { ...base, commitsPerMonth: 10, concentration: 0.9, recordCoveragePercentile: 5 };
  ok('four tests clearing flags the region', applyFlags(hot, DEFAULT_THRESHOLDS, true, 2).flags.length === 4);
  ok('the record test is skipped when the record is unusable', applyFlags(hot, DEFAULT_THRESHOLDS, false, 2).flags.length === 3);
  const cold = { ...base, commitsPerMonth: 0.1, concentration: 0.2, recordCoveragePercentile: 90 };
  ok('a region clearing one test does not flag', !applyFlags(cold, DEFAULT_THRESHOLDS, true, 2).flagged);

  // THE ABANDONED-REGION CASE, which the spec's "three of four" rule could not express:
  // heavily orphaned, one dominant author, and quiet precisely BECAUSE it was abandoned.
  const abandoned = { ...base, orphanedShare: 0.9, concentration: 0.8, commitsPerMonth: 0.2 };
  ok('THE ABANDONED-REGION CASE: orphaned + concentrated flags even when quiet', applyFlags(abandoned, DEFAULT_THRESHOLDS, false, 8).flagged);

  // Churn and low coverage without an ownership signal describe a busy, terse region — which
  // is not what this artifact is about, and must not flag.
  const busy = { ...base, orphanedShare: 0.1, concentration: 0.1, commitsPerMonth: 50, recordCoveragePercentile: 2 };
  ok('churn plus low coverage without ownership does NOT flag', !applyFlags(busy, DEFAULT_THRESHOLDS, true, 8).flagged);

  // With the record dimension unscored only three tests exist, so a literal three-of-four
  // would silently become unanimity. The requirement adapts instead.
  const twoOfThree = { ...base, orphanedShare: 0.9, concentration: 0.9, commitsPerMonth: 0.1 };
  ok('the requirement adapts when only three tests are available', applyFlags(twoOfThree, DEFAULT_THRESHOLDS, false, 8).flagged);
}

{
  const mk = (cpm: number) => ({
    ...computeRegion({ region: 'r', edits: [edit('c1', 'w')], commits: [], whoOf: new Map() }, new Set(), NOW, DEFAULT_THRESHOLDS),
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
    ...computeRegion({ region: p, edits: [edit('x', 'w')], commits: [], whoOf: new Map() }, new Set(), NOW, DEFAULT_THRESHOLDS),
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
    ok('it carries the full corpus', cal.n === 1000 && cal.sorted.length === 1000);
    ok('THE ZERO-INFLATION FACT: over half the corpus scores zero', cal.shareAtZero > 0.5);
    ok('the bottom five deciles are all zero, so "decile" is unusable', cal.deciles.slice(0, 5).every((d) => d === 0));
    ok(
      'a zero-coverage region reports a percentile above the undocumented threshold floor',
      midrankPercentile(cal.sorted, 0) > 25 && midrankPercentile(cal.sorted, 0) < DEFAULT_THRESHOLDS.coveragePercentile
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

console.log(failures === 0 ? '\nall dimension tests passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
