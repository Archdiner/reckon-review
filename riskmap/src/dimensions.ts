/**
 * Step 4 — the dimensions, and step 7 — ranking.
 *
 * SHOW DIMENSIONS, NOT A COMPOSITE SCORE. A single risk number invites an argument about
 * weights and hides the reason a region surfaced. Worse, it is unfalsifiable in the one
 * conversation that matters: a reader who disagrees with a composite has nothing to point at.
 * So the components are computed, displayed, and ranked on a simple stated rule, and nothing
 * anywhere multiplies them together.
 *
 * DEPARTURE IS AN INFERENCE, NOT A FACT, and the phrasing throughout is INACTIVITY. No commits
 * in twelve months is a proxy: people go on leave, change teams, move to another repository in
 * the same company, or work under an identity this tool failed to merge. Every use of it is
 * aggregated to a region, never attached to a person, and the output says "contributors" and
 * "have not committed" rather than "left".
 *
 * WHY ACTIVITY IS A REPO-WIDE QUESTION. A contributor counts as active if they committed
 * ANYWHERE in the repository inside the inactivity window, not just in the region under
 * examination. Someone who moved from `billing/` to `search/` has not stopped being available
 * to explain `billing/`, and scoring them as gone would flag every region anyone ever moved
 * away from — which on a healthy codebase is most of them.
 */

import { classifyRecord } from './vendor/triviality.js';
import { isLowMeaningPath } from './filters.js';
import type { Commit, Edit, FlagName, Region, Thresholds } from './types.js';

export const DEFAULT_THRESHOLDS: Thresholds = {
  inactivityMonths: 12,
  /**
   * SIXTY MONTHS, NOT THE TWENTY-FOUR THE SPEC SUGGESTED, and the change is measured rather
   * than preferred.
   *
   * A trailing window truncates the orphan signal, because a contributor can only look inactive
   * if their work sits far enough back in the window to predate the 12-month cutoff. Run against
   * grafana/grafana both ways: at 24 months the maximum orphaned share across 44 regions is
   * 0.14 and the median is 0.035 — no region can flag, and the map says nothing. At 84 months
   * the maximum is 0.88 and the median is 0.23, and the regions that surface are the abandoned
   * ones a maintainer would name.
   *
   * That is not a tuning difference. "The people who understood this are gone" is a multi-year
   * phenomenon, and a two-year window cannot see it by construction: it can only ever contain
   * two years of contributors, nearly all of whom are still around. 60 months is the compromise
   * — long enough for the signal, short enough that the clone stays cheap.
   */
  windowMonths: 60,
  orphanedShare: 0.5,
  concentration: 0.5,
  /**
   * Absolute floor only. The operative churn threshold is the MEDIAN region churn of the
   * repository being mapped, computed at run time — see `resolveChurnThreshold`. A fixed
   * commits-per-month bar means something completely different on a repo with 200 commits a
   * year and one with 20,000: on grafana the median region already runs at 8 commits a month,
   * so a bar of 2 marks four fifths of the repository as hot and the dimension stops
   * discriminating.
   */
  commitsPerMonth: 1,
  /**
   * Set just above the calibration corpus's zero mass, not to a round number.
   *
   * 55.7% of the 1,000 study PRs score exactly zero explicit answers, so a zero-coverage
   * region's midrank percentile is 27.85. Any threshold below that could never fire on a
   * region whose sampled commits explained nothing at all, which would make the dimension
   * decorative. See calibration.ts for the full argument.
   */
  coveragePercentile: 30,
  minFlags: 3,
  regionMinCommits: 15,
  maxFilesPerCommit: 300,
};

const MS_PER_MONTH = 30.44 * 24 * 60 * 60 * 1000;

export function monthsBefore(at: number, months: number): number {
  return at - months * MS_PER_MONTH;
}

/**
 * Contributors with no commit anywhere in the repo since the cutoff.
 *
 * Computed from the UNWINDOWED, UNFILTERED-BY-REGION commit set on purpose: the question is
 * "is this person still around", and the evidence for that is any commit at all.
 */
export function inactiveIdentities(
  allCommits: { who: string; at: number }[],
  cutoff: number
): Set<string> {
  const lastSeen = new Map<string, number>();
  for (const c of allCommits) {
    const prev = lastSeen.get(c.who);
    if (prev === undefined || c.at > prev) lastSeen.set(c.who, c.at);
  }
  const out = new Set<string>();
  for (const [who, at] of lastSeen) if (at < cutoff) out.add(who);
  return out;
}

export interface RegionInput {
  region: string;
  edits: Edit[];
  /** Commits touching the region, deduplicated, with the message material. */
  commits: Commit[];
  /** The `who` key per commit sha, so message-level and edit-level agree. */
  whoOf: Map<string, string>;
}

/**
 * The five git-only dimensions. Record coverage is added later by coverage.ts, because it is
 * the only one that needs a model and the map has to be worth sending without it.
 */
export function computeRegion(
  input: RegionInput,
  inactive: Set<string>,
  asOf: number,
  t: Thresholds
): Region {
  const { region, edits, commits } = input;

  const shas = new Set(edits.map((e) => e.sha));
  const nCommits = shas.size;

  // Weight by COMMITS TOUCHING THE REGION, not by lines and not by (commit, file) rows.
  // Lines would let one reformat outweigh a year of considered work; per-file rows would let
  // a single wide commit outvote everyone. A commit is the unit a person decided to make.
  const byWho = new Map<string, Set<string>>();
  for (const e of edits) {
    let s = byWho.get(e.who);
    if (!s) {
      s = new Set();
      byWho.set(e.who, s);
    }
    s.add(e.sha);
  }

  const contributors = byWho.size;
  let inactiveContributors = 0;
  let orphanedCommits = 0;
  let largest = 0;
  for (const [who, s] of byWho) {
    if (inactive.has(who)) {
      inactiveContributors++;
      orphanedCommits += s.size;
    }
    if (s.size > largest) largest = s.size;
  }

  const linesChanged = edits.reduce((n, e) => n + e.added + e.deleted, 0);
  const months = Math.max(1, t.windowMonths);

  let agentCommits = 0;
  let lastSubstantive: number | null = null;
  for (const c of commits) {
    if (c.agentTrailer) agentCommits++;
    // `classifyRecord` reads a record as "title then body", which is exactly a commit message.
    const tier = classifyRecord(`${c.subject}\n${c.body}`).tier;
    if (tier === 'substantive' && (lastSubstantive === null || c.at > lastSubstantive)) {
      lastSubstantive = c.at;
    }
  }

  return {
    path: region,
    commits: nCommits,
    edits: edits.length,
    linesChanged,
    contributors,
    inactiveContributors,
    orphanedShare: nCommits ? orphanedCommits / nCommits : 0,
    concentration: nCommits ? largest / nCommits : 0,
    commitsPerMonth: nCommits / months,
    linesPerMonth: linesChanged / months,
    agentDensity: commits.length ? agentCommits / commits.length : 0,
    lastSubstantiveExplanation: lastSubstantive,
    recordCoverage: null,
    recordCoveragePercentile: null,
    recordCommitsScored: 0,
    flags: [],
    flagged: false,
  };
}

/**
 * Step 7 — flagging.
 *
 * A region flags when it clears at least `minFlags` of four independent tests. Three of four
 * is the default: two is most of a large repository and four is almost nothing, and a rule
 * that fires on everything and a rule that fires on nothing are equally useless for triage.
 *
 * The thresholds are PUBLISHED IN THE OUTPUT. A reader who disagrees with them can see exactly
 * what they were, and arguing about where the line sits is a conversation about their
 * codebase — which is the conversation this artifact exists to start.
 *
 * `undocumented` is only ever tested when the record dimension is trustworthy for this
 * repository. On a repo that squashes to the title, a low coverage number measures the merge
 * button, and flagging on it would be the single fastest way to lose a reader who knows their
 * own merge settings.
 */
export function applyFlags(
  r: Region,
  t: Thresholds,
  recordUsable: boolean,
  churnThreshold: number
): Region {
  const flags: FlagName[] = [];
  if (r.orphanedShare >= t.orphanedShare) flags.push('orphaned');
  if (r.concentration >= t.concentration) flags.push('concentrated');
  if (r.commitsPerMonth >= churnThreshold) flags.push('hot');
  if (
    recordUsable &&
    r.recordCoveragePercentile !== null &&
    r.recordCoveragePercentile <= t.coveragePercentile
  ) {
    flags.push('undocumented');
  }

  // An OWNERSHIP signal is necessary, not merely one vote among four.
  //
  // The spec's rule was "at least three of the four", and running it revealed two ways that
  // rule fails. First, `hot` and `orphaned` are anti-correlated by construction — a region
  // under active development has active contributors — so demanding both is close to demanding
  // a contradiction, and on grafana at 84 months it flagged nothing at all while `cue` and
  // `.circleci` sat at 0.88 and 0.81 orphaned with one dominant author each. Second, when
  // record coverage has not been scored only three tests exist, so "three of four" silently
  // becomes unanimity.
  //
  // So the rule is: at least `minFlags` of the AVAILABLE tests, and at least one of them must
  // be an ownership test. Churn and documentation amplify an ownership problem; on their own
  // they describe a busy or a terse region, which is not what this artifact is about.
  //
  // "Available" means the test COULD have fired for this region, which is not the same as the
  // repository's squash convention permitting it: with `--coverage` off, no region has a
  // coverage value at all, so counting the record test as available silently raises the bar to
  // three of three and flags nothing. That is how grafana reported zero flagged regions while
  // `pkg/framework` sat at 0.85 orphaned and 0.80 concentrated.
  const ownership = flags.includes('orphaned') || flags.includes('concentrated');
  const recordTested = recordUsable && r.recordCoveragePercentile !== null;
  const available = recordTested ? 4 : 3;
  const need = Math.max(2, Math.min(t.minFlags, available - 1));
  return { ...r, flags, flagged: ownership && flags.length >= need };
}

/**
 * The operative churn threshold: the median region churn of this repository, floored.
 *
 * Repo-relative rather than absolute, because "hot" only means anything next to the rest of the
 * same codebase. Published in the output like every other threshold.
 */
export function resolveChurnThreshold(regions: Region[], t: Thresholds): number {
  if (regions.length === 0) return t.commitsPerMonth;
  const sorted = regions.map((r) => r.commitsPerMonth).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return Math.max(t.commitsPerMonth, median);
}

/**
 * Sort flagged regions by orphaned share, then by churn.
 *
 * Orphaned share leads because it is the headline dimension and the one the reader cannot get
 * anywhere else; churn breaks ties because a region nobody touches is lower risk than a hot
 * one with the same ownership profile.
 */
export function rankRegions(regions: Region[]): Region[] {
  return regions
    .filter((r) => r.flagged)
    .sort((a, b) => b.orphanedShare - a.orphanedShare || b.commitsPerMonth - a.commitsPerMonth);
}

/** Regions dominated by migrations/fixtures paths, which flag on churn and mean little. */
export function isLowMeaningRegion(region: string, edits: Edit[]): boolean {
  if (edits.length === 0) return false;
  const low = edits.filter((e) => isLowMeaningPath(e.path)).length;
  return low / edits.length >= 0.5 || isLowMeaningPath(`${region}/`);
}
