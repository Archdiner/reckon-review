/**
 * Step 9 — retrospective validation. This is what makes it an artifact rather than a poster.
 *
 * THE DESIGN. Build the map as of a date T at least twelve months in the past, using ONLY
 * commits before T. Then look at what happened in each region AFTER T and ask whether the
 * regions the map flagged went on to behave worse than the ones it did not.
 *
 * ── THE COLLIDER, AND WHY THIS FILE IS ORGANISED THE WAY IT IS ─────────────────────────────
 *
 * The first version of this harness compared outcomes between flagged and unflagged regions
 * over the regions that had post-cutoff commits, because every outcome it measured — fix rate,
 * rework rate, fix latency — is a rate over post-T commits and is undefined without them.
 *
 * That conditioning is a COLLIDER, and it invalidates every comparison built on top of it.
 * The chain is short and there is no way around it:
 *
 *     flagging  →  (the region's contributors have stopped)  →  no post-T commits
 *
 * The map flags a region because its contributors stopped committing. Flagging therefore
 * predicts abandonment. Abandonment is exactly what determines whether a region has any post-T
 * activity. So "has post-T activity" is a DESCENDANT OF THE TREATMENT, and restricting the
 * sample to it conditions on a descendant of the treatment. That opens a non-causal path
 * between flagging and everything else correlated with activity, and manufactures association
 * out of nothing — including association pointing the wrong way.
 *
 * Concretely: the eight flagged regions that survived the filter in the four-repo run are
 * precisely the ones somebody picked back up. That is the subset you would expect to look
 * healthiest, and it duly did. The "flagged regions did better" result that came out of it is
 * more likely that artifact than a real anti-prediction, and it is not reported as either.
 *
 * So the conditioned comparisons are KEPT AND LABELLED rather than deleted — deleting them
 * would hide the fact that the obvious analysis gives an answer, and the answer is unusable —
 * and the headline moves to the one comparison that conditions on nothing downstream:
 *
 * ── THE PRIMARY RESULT: DORMANCY, ON THE FULL SAMPLE ───────────────────────────────────────
 *
 * Every region that exists in the map at T is in the denominator, whether or not anything
 * happened to it afterwards. The outcome is binary: did the region receive zero commits in the
 * follow-up window. Nothing downstream of flagging is conditioned on, because the sample is
 * the whole population of regions at T and the outcome is measured on all of them.
 *
 * ── THE OUTCOMES ───────────────────────────────────────────────────────────────────────────
 *
 * All git-only, because the input has to stay a clone. Grouped by what they can actually test.
 *
 * PRIMARY, full sample, conditions on nothing downstream:
 *
 *   DORMANCY       — did the region receive zero commits in the follow-up window. Higher is
 *                    worse. This is the headline.
 *
 * COMPREHENSION-ORIENTED, full sample. The claim the map makes is that nobody understands this
 * code any more. Comprehension loss shows up as work being SLOWED or DISCARDED, not as bugs:
 *
 *   WHOLESALE REWRITE — replacing code rather than changing it is what a team does when nobody
 *                    understands it. Two components, never summed. See `rewriteMeasures`.
 *   CONTRIBUTORS POST-T — distinct identities touching the region after T. LOWER is worse.
 *   TIME TO MERGE  — NOT COMPUTED. See `probeCommitterLag`; the verdict is that it is not
 *                    recoverable from a clone and no proxy in reach is defensible.
 *
 * DEFECT MEASURES, demoted. These were the original outcomes and they test the wrong claim:
 *
 *   FIX RATE       — share of post-T commits marked as a revert, hotfix or regression fix.
 *   REWORK RATE    — share of post-T commits touching a file another commit in the same region
 *                    touched within the previous 30 days.
 *   FIX LATENCY    — median days from a file's first post-T commit to a subsequent fix.
 *
 * A defect is not a comprehension failure. Code nobody understands can be perfectly correct and
 * still be code nobody can change, and the map's claim is about the second thing. These are
 * retained because they were measured and removing a measured null is not honest, but they are
 * labelled as what they are and they are ALSO conditioned on post-T activity, so they carry the
 * collider label too.
 *
 * WHAT A NULL RESULT MEANS, stated before running it. If flagged regions do not show worse
 * outcomes, the map does not predict anything measurable in git and that is worth knowing
 * BEFORE it is attached to ten cold emails. This module is not here to confirm the map. The
 * honest outcome of the exercise is a number either way, and the report prints the null as
 * plainly as it would print a hit.
 *
 * THE LIMITS, which do not go away if the result is positive:
 *
 *   - Flagging is not random assignment. Flagged regions differ from unflagged ones in ways
 *     the map measures (churn, above all) and in ways it does not.
 *   - Commit-message-derived outcomes measure what teams write down, which is the same channel
 *     the record dimension measures. A team that never writes "revert" looks healthy here by
 *     construction. This is why the new outcomes are structural (trees, line counts, identity
 *     counts) rather than lexical wherever that was possible.
 *   - Regions are not independent across a repository, which the cluster bootstrap handles for
 *     variance and cannot handle for confounding.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildMap } from './build.js';
import { readLog, readRepoName, readAuthorRoster } from './gitlog.js';
import { isBot, resolveIdentities } from './identity.js';
import { isExcludedPath } from './filters.js';
import { DEFAULT_THRESHOLDS } from './dimensions.js';
import { regionOf, ROOT } from './regions.js';
import { bootstrapDifference, bootstrapRatio, mean, quantiles, type Interval } from './stats.js';
import type { Commit } from './types.js';

const exec = promisify(execFile);

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MONTH = 30.44 * MS_PER_DAY;
const MAX_BUFFER = 1024 * 1024 * 1024;

/**
 * Commit messages that mark a correction.
 *
 * Deliberately narrow. Broadening it to any message containing "fix" would sweep in every
 * ordinary bug fix in the repository, which is normal engineering rather than evidence that a
 * region is in trouble, and would push both arms toward the same rate.
 */
const FIX_MESSAGE =
  /^(revert\b|revert:|fixup!|hotfix\b)|^(fix|chore|bug)?\s*(\([^)]*\))?\s*:?\s*(revert|hotfix|regression|re-?fix|follow[- ]?up fix|emergency)\b|\b(reverts? commit|regression (introduced|caused) by|broke[n]? by|re-?land|roll ?back)\b/i;

export function isFixCommit(subject: string, body: string): boolean {
  return FIX_MESSAGE.test(subject) || FIX_MESSAGE.test(body.split('\n')[0] ?? '');
}

// ── WHOLESALE REWRITE: THE OPERATIONALISATION, STATED IN FULL ─────────────────────────────────
//
// The claim under test is that nobody understands this code any more. The behavioural signature
// of that is not bugs, it is REPLACEMENT: a team that cannot read a module rewrites it rather
// than editing it. So the measure has to be about how much of the code that existed at T is
// still there at the end of the window, and about whether the post-T churn looks like growth or
// like substitution.
//
// Two components. They are reported side by side and NEVER summed, for the same reason the map
// has dimensions rather than a score: a single rewrite number would hide which of the two fired.
//
//   1. TURNOVER — the share of the region's files present at T that are gone by the end of the
//      window. "Present at T" is the tree at the last commit at or before T, minus excluded
//      (generated / vendored / lockfile) paths, bucketed to regions by the same longest-prefix
//      match the map uses. "Gone" is measured by a single tree-to-tree diff with exhaustive
//      rename detection, and means either
//        - the file was DELETED, or
//        - the file was RENAMED to a path in a DIFFERENT region.
//      A rename that stays inside the region does NOT count. That is the conservative choice:
//      at directory grain, moving a file within a region is reorganisation, whereas moving it
//      out is the code leaving. Higher is worse.
//
//   2. REPLACEMENT — post-T deleted lines in the region, over the region's total line count at
//      T. This asks how much of the region's T-era content the window's churn was large enough
//      to have removed. It is a RATIO OF VOLUMES, not a fraction of a fixed set: a line deleted,
//      restored and deleted again counts twice, so the measure can and does exceed 1.0, and 1.0
//      means "the window deleted as many lines as the region contained". Higher is worse.
//
// The added/deleted line ratio the brief asks for is reported alongside as `addDeleteRatio`, but
// it is explicitly NOT ORIENTED: a ratio near 1 means additions are matched by deletions, which
// is substitution; a ratio far above 1 means the region is growing, which is ordinary healthy
// development; a ratio far below 1 means the region is being stripped out, which is also a
// rewrite of a sort. Neither tail is unambiguously "worse", so it is used as a QUALIFIER on the
// replacement test rather than reported as a difference with a direction.
//
// A region counts as REWRITTEN when either
//
//     turnover >= 0.5                                   (half its files at T are gone), or
//     replacement >= 0.5 AND addDeleteRatio <= 1.5      (the window deleted at least half the
//                                                        region's T-era content, and did so
//                                                        without the additions being dominated
//                                                        by net-new growth)
//
// The second limb's ratio qualifier is what separates "rewritten" from "grew a lot and tidied up
// on the way". 1.5 is a judgement call and is printed with the result so a disagreeing reader
// can see what it was — the same discipline the map applies to its own thresholds.
//
// WHERE THIS BREAKS, stated rather than discovered later:
//   - The tree diff is a comparison of two snapshots and cannot be filtered the way the arms
//     were. A bot commit or an oversized vendor drop inside the window contributes to turnover
//     even though the map excluded exactly those commits when constructing the arms. Arms and
//     outcomes therefore filter ALIKE for the commit-derived measures and UNLIKE for the
//     structural one. There is no cheap fix: numstat cannot distinguish a deletion from a file
//     truncated to zero, and renames are resolved to the new path before the harness sees them,
//     so deletions-by-rename are invisible in the commit stream and only a tree diff sees them.
//   - Turnover is bounded above by activity. A dormant region cannot have turnover, so on the
//     full sample the flagged arm's turnover is mechanically dragged toward zero by the very
//     dormancy that is the headline result. The report says this next to the number: a LOWER
//     flagged turnover on the full sample restates dormancy and is not independent evidence.
const REWRITE_TURNOVER_THRESHOLD = 0.5;
const REWRITE_REPLACEMENT_THRESHOLD = 0.5;
const REWRITE_RATIO_QUALIFIER = 1.5;

/** Which way "worse" points for a metric. Checked before any direction is ever printed. */
export type Orientation = 'higher-is-worse' | 'lower-is-worse' | 'none';

/** One region as it stood at T. The FULL sample — dormant regions included. */
export interface RegionRecord {
  repo: string;
  region: string;
  flagged: boolean;
  /** Commits landing in the region during the follow-up window. Zero means dormant. */
  postCommits: number;
  /** No post-T commits at all. The primary outcome. */
  dormant: boolean;
  /** Distinct post-T contributor identities. Zero for a dormant region. LOWER is worse. */
  contributorsPostT: number;

  /**
   * The region's directory still held at least one non-excluded file in the tree at T.
   *
   * A PRE-TREATMENT covariate: it is a function of history before T, measured at the same
   * instant the flag is, so it is not downstream of flagging and stratifying on it is ordinary
   * covariate adjustment rather than the collider mistake this file exists to avoid. It turned
   * out to matter enormously — see `DormancyResult.extant`. Null when the tree comparison could
   * not be run for the repository at all.
   */
  extantAtT: boolean | null;

  // ---- wholesale rewrite. See the block comment above for the operationalisation. ----
  /** Non-excluded files under the region in the tree at T. The denominator for `turnover`. */
  filesAtT: number;
  /** Of those, deleted or renamed out of the region by the end of the window. */
  filesGone: number;
  /** filesGone / filesAtT. Null when the region had no files at T. Higher is worse. */
  turnover: number | null;
  /** Total lines under the region in the tree at T. The denominator for `replacement`. */
  linesAtT: number;
  linesAddedPostT: number;
  linesDeletedPostT: number;
  /** linesDeletedPostT / linesAtT. Null when linesAtT is 0. May exceed 1. Higher is worse. */
  replacement: number | null;
  /** linesAddedPostT / linesDeletedPostT. Null when nothing was deleted. NOT ORIENTED. */
  addDeleteRatio: number | null;
  /**
   * Null when the region had nothing to rewrite — no files in the tree at T — or when the tree
   * comparison could not be run. NOT false: a region that was already gone before T is not a
   * region that survived the window intact, and scoring it `false` would have counted 20 of the
   * 28 flagged regions in the four-repo run as "not rewritten" when what they were is *already
   * rewritten, before the map was built*.
   */
  rewritten: boolean | null;
}

export interface RegionOutcome {
  repo: string;
  region: string;
  flagged: boolean;
  /** Dimensions as of T, kept so the report can stratify. */
  orphanedShare: number;
  concentration: number;
  commitsPerMonthAtT: number;
  postCommits: number;
  fixRate: number;
  reworkRate: number;
  medianFixLatencyDays: number | null;
}

/** A two-arm comparison of a metric, with the orientation attached so the sign can be checked. */
export interface Comparison {
  metric: string;
  orientation: Orientation;
  /** Whether the sample is the full set of regions at T or only those with post-T activity. */
  conditioned: boolean;
  nFlagged: number;
  nUnflagged: number;
  flaggedMean: number;
  unflaggedMean: number;
  difference: Interval;
  flaggedQuantiles: ReturnType<typeof quantiles>;
  unflaggedQuantiles: ReturnType<typeof quantiles>;
  /** Regions dropped from this metric because it was undefined for them (a null denominator). */
  undefinedFlagged: number;
  undefinedUnflagged: number;
}

/** The headline. Full sample, binary outcome, nothing downstream conditioned on. */
export interface DormancyResult {
  flaggedTotal: number;
  flaggedDormant: number;
  unflaggedTotal: number;
  unflaggedDormant: number;
  /** Null when the arm is empty. Never 0 standing in for "no data". */
  flaggedRate: number | null;
  unflaggedRate: number | null;
  riskRatio: Interval;
  riskDifference: Interval;
  /**
   * THE SENSITIVITY ANALYSIS THAT CHANGES HOW THE HEADLINE READS, and the reason it is computed
   * at all: on the four-repo run, 20 of the 28 flagged regions had NO FILES LEFT in the tree at
   * T. Their directories had already been deleted or moved before the map was built — the map's
   * 60-month window admits a region on the strength of commits that are years old, so a
   * directory that ceased to exist in year two is still a row in year five. An empty directory
   * receiving no commits is arithmetic, not prediction.
   *
   * So the dormancy comparison is repeated over only the regions that still existed at T.
   * `extantAtT` is pre-treatment, so this is covariate adjustment and not a second collider.
   */
  extant: {
    flaggedTotal: number;
    flaggedDormant: number;
    unflaggedTotal: number;
    unflaggedDormant: number;
    flaggedRate: number | null;
    unflaggedRate: number | null;
    riskRatio: Interval;
    riskDifference: Interval;
  };
  /** Regions already empty at T, by arm, and how many of them were dormant. */
  goneBeforeT: { flagged: number; unflagged: number; dormant: number; total: number };
}

/**
 * Evidence for the time-to-merge verdict, measured on the repositories actually in the run.
 *
 * See `probeCommitterLag`. This is deliberately computed rather than asserted, so the claim
 * "not computable" is a measurement about these clones rather than a hunch about git.
 */
export interface MergeLatencyProbe {
  repo: string;
  commits: number;
  nonZeroLag: number;
  shareNonZeroLag: number;
  medianNonZeroLagDays: number | null;
}

export interface ValidationResult {
  repos: string[];
  monthsBack: number;
  followMonths: number;
  asOf: Record<string, string>;
  /** Full sample: every region in the map at T. */
  allRegions: RegionRecord[];
  /** Conditioned sample: only regions with post-T activity. Collider-biased by construction. */
  regions: RegionOutcome[];
  dormancy: DormancyResult;
  /** Full-sample comparisons. Not conditioned on anything downstream of flagging. */
  comprehension: Comparison[];
  /** Conditioned on post-T activity. Collider-biased. Kept and labelled, never deleted. */
  defect: Comparison[];
  /** The comprehension measures recomputed on the conditioned sample, for the same reason. */
  conditionedComprehension: Comparison[];
  /** The same conditioned comparison inside churn strata. Also collider-biased. */
  churnStratified: {
    stratum: string;
    nFlagged: number;
    nUnflagged: number;
    metric: string;
    orientation: Orientation;
    difference: Interval;
  }[];
  mergeLatency: MergeLatencyProbe[];
  notes: string[];
  /** Regions with NO post-T activity, by arm. Reported, never silently excluded. */
  silent: { flagged: number; unflagged: number };
  /** Repos where the tree-diff measures could not be computed, with the reason. */
  structuralGaps: string[];
}

export interface ValidationOpts {
  repos: string[];
  monthsBack: number;
  followMonths: number;
  onProgress?: (msg: string) => void;
}

/**
 * The region a post-T path belongs to, matching what `buildMap` did.
 *
 * `depth` is the map's MAXIMUM region depth, so truncating to it always retains the full region
 * prefix and the walk-up reproduces `regionFor`'s longest-prefix match — with one divergence
 * the first version got wrong. When the walk reaches a single path component that is not a
 * region, `r.includes('/')` is false and the file was dropped, whereas the map sends exactly
 * those paths to `(root)`. That silently understated `(root)`'s post-T activity by 12 file
 * touches out of 124,604 on grafana. Small, but it is a map/harness disagreement, and this
 * harness exists to be trusted.
 */
function regionForPath(path: string, depth: number, regionPaths: Set<string>): string | null {
  let r = regionOf(path, depth);
  while (!regionPaths.has(r) && r.includes('/')) r = r.slice(0, r.lastIndexOf('/'));
  if (regionPaths.has(r)) return r;
  return regionPaths.has(ROOT) ? ROOT : null;
}

function outcomesFor(
  post: Commit[],
  depth: number,
  regionPaths: Set<string>
): Map<string, { commits: Commit[]; fixes: number; rework: number }> {
  const byRegion = new Map<string, { commits: Commit[]; fixes: number; rework: number }>();
  // Last time each file was touched post-T, for the rework window.
  const lastTouch = new Map<string, number>();

  for (const c of [...post].sort((a, b) => a.at - b.at)) {
    // REWORK IS PER REGION, NOT PER COMMIT. The first version computed one boolean for the
    // whole commit — true if ANY file in it was re-touched — and then credited it to EVERY
    // region the commit touched. A repo-wide rename then marked every region as reworked at
    // once: langchain's `libs/langchain/langchain/vectorstores` has exactly one post-T commit,
    // a 1,518-file rename, and scored a rework rate of 1.000 off it. That is why both arms sat
    // at 0.85-1.0 everywhere and the metric barely discriminated.
    const reworkedIn = new Set<string>();
    const regions = new Set<string>();
    for (const f of c.files) {
      if (isExcludedPath(f.path)) continue;
      const r = regionForPath(f.path, depth, regionPaths);
      if (r === null) continue;
      regions.add(r);
      const prev = lastTouch.get(f.path);
      if (prev !== undefined && c.at - prev <= 30 * MS_PER_DAY) reworkedIn.add(r);
      lastTouch.set(f.path, c.at);
    }
    const fix = isFixCommit(c.subject, c.body);
    for (const r of regions) {
      let e = byRegion.get(r);
      if (!e) {
        e = { commits: [], fixes: 0, rework: 0 };
        byRegion.set(r, e);
      }
      e.commits.push(c);
      if (fix) e.fixes++;
      if (reworkedIn.has(r)) e.rework++;
    }
  }
  return byRegion;
}

function fixLatencies(post: Commit[], depth: number, region: string, regionPaths: Set<string>): number[] {
  const firstTouch = new Map<string, number>();
  const out: number[] = [];
  for (const c of [...post].sort((a, b) => a.at - b.at)) {
    const fix = isFixCommit(c.subject, c.body);
    for (const f of c.files) {
      if (isExcludedPath(f.path)) continue;
      let r = regionOf(f.path, depth);
      while (!regionPaths.has(r) && r.includes('/')) r = r.slice(0, r.lastIndexOf('/'));
      if (r !== region) continue;
      const first = firstTouch.get(f.path);
      if (first === undefined) {
        firstTouch.set(f.path, c.at);
      } else if (fix) {
        out.push((c.at - first) / MS_PER_DAY);
      }
    }
  }
  return out;
}

// ── STRUCTURAL MEASURES: TWO EXTRA GIT CALLS PER REPO, BOTH CHEAP ────────────────────────────
//
// `core.quotePath=false` so non-ASCII paths arrive as UTF-8 rather than as C-style octal escapes
// that would not match anything else in the pipeline.

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: repo,
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

/** The last commit on HEAD's history at or before `at`, or null if there is none. */
async function revBefore(repo: string, at: number): Promise<string | null> {
  // `--before` filters the COMMITTER date while everything else in this tool keys off the
  // AUTHOR date. `probeCommitterLag` measures how far apart those are on the repos in the run —
  // on all four study repos the two are identical for 89-99.8% of commits — so the boundary
  // commit this picks is the same one an author-date walk would pick, up to a handful of
  // commits at the edge. That is a real approximation and it is the reason the probe is run.
  const out = (await git(repo, ['rev-list', '-1', `--before=${new Date(at).toISOString()}`, 'HEAD'])).trim();
  return out || null;
}

/** Every non-excluded path in the tree at `sha`, with its line count. Binary files count 0. */
async function treeLines(repo: string, sha: string): Promise<Map<string, number>> {
  // Diffing against the empty tree yields the whole snapshot as "added" lines, which is the
  // cheapest exact way to get per-file line counts. `git ls-tree -l` gives bytes, not lines,
  // and a bytes-to-lines constant would be a fabrication sitting under a headline number.
  const empty = (await git(repo, ['hash-object', '-t', 'tree', '/dev/null'])).trim();
  const raw = await git(repo, ['diff', '--numstat', empty, sha]);
  const out = new Map<string, number>();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const [, a = '0', , p = ''] = m;
    if (isExcludedPath(p)) continue;
    out.set(p, a === '-' ? 0 : Number(a));
  }
  return out;
}

/** Paths present at `a` that are deleted, or renamed, by `b`. Renames carry their destination. */
async function structuralChanges(
  repo: string,
  a: string,
  b: string
): Promise<{ deleted: string[]; renamed: { from: string; to: string }[] }> {
  // `diff.renameLimit=0` lifts git's rename-detection cap. Left at the default it prints
  // "exhaustive rename detection was skipped" on a repository of grafana's size and reports
  // renames as delete+add pairs, which would inflate turnover — on grafana, 2,090 deletions
  // instead of 1,779, a 17% overstatement of the headline component. It costs about five
  // seconds per repository, which is nothing next to being wrong.
  const raw = await git(repo, ['-c', 'diff.renameLimit=0', 'diff', '--name-status', '-M', a, b]);
  const deleted: string[] = [];
  const renamed: { from: string; to: string }[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    const status = parts[0] ?? '';
    if (status.startsWith('D')) {
      if (parts[1]) deleted.push(parts[1]);
    } else if (status.startsWith('R')) {
      // A COPY (status C) is deliberately not here: the original is still in the tree, so the
      // code that was in the region has not left it.
      if (parts[1] && parts[2]) renamed.push({ from: parts[1], to: parts[2] });
    }
  }
  return { deleted, renamed };
}

/**
 * TIME FROM FIRST BRANCH COMMIT TO MERGE — the probe behind the "not computable" verdict.
 *
 * The tool reads `git log --no-merges`, so merge commits are not in the data at all, and a plain
 * clone carries no pull-request records, no branch creation times and no review events. The only
 * candidate proxy that lives in a clone is the AUTHOR-DATE to COMMITTER-DATE lag: on a
 * rebase-merge workflow the author date is preserved from when the commit was written and the
 * committer date is stamped when it lands on the trunk, so the gap is the time the change spent
 * in review.
 *
 * This function measures whether that gap exists. It reports the share of commits with any
 * non-zero lag at all. The verdict the report prints is driven by this number, not by an
 * assumption — see `formatValidationReport`.
 */
async function probeCommitterLag(repo: string, name: string): Promise<MergeLatencyProbe> {
  const raw = await git(repo, ['log', '--no-merges', '--format=%at %ct']);
  const lags: number[] = [];
  let commits = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [at, ct] = line.split(' ').map(Number);
    if (!Number.isFinite(at) || !Number.isFinite(ct)) continue;
    commits++;
    const d = (ct as number) - (at as number);
    if (d !== 0) lags.push(d);
  }
  lags.sort((x, y) => x - y);
  return {
    repo: name,
    commits,
    nonZeroLag: lags.length,
    shareNonZeroLag: commits ? lags.length / commits : 0,
    medianNonZeroLagDays: lags.length ? lags[Math.floor(lags.length / 2)]! / 86400 : null,
  };
}

/** Build a two-arm comparison, dropping regions where the metric is undefined. */
function compare(
  metric: string,
  orientation: Orientation,
  conditioned: boolean,
  flaggedVals: (number | null)[],
  unflaggedVals: (number | null)[]
): Comparison {
  const a = flaggedVals.filter((v): v is number => v !== null && Number.isFinite(v));
  const b = unflaggedVals.filter((v): v is number => v !== null && Number.isFinite(v));
  return {
    metric,
    orientation,
    conditioned,
    nFlagged: a.length,
    nUnflagged: b.length,
    flaggedMean: mean(a),
    unflaggedMean: mean(b),
    difference: bootstrapDifference(a, b),
    flaggedQuantiles: quantiles(a),
    unflaggedQuantiles: quantiles(b),
    undefinedFlagged: flaggedVals.length - a.length,
    undefinedUnflagged: unflaggedVals.length - b.length,
  };
}

export async function runValidation(opts: ValidationOpts): Promise<ValidationResult> {
  const log = opts.onProgress ?? (() => {});
  const regions: RegionOutcome[] = [];
  const allRegions: RegionRecord[] = [];
  const asOfByRepo: Record<string, string> = {};
  const notes: string[] = [];
  const structuralGaps: string[] = [];
  const mergeLatency: MergeLatencyProbe[] = [];
  let silentFlagged = 0;
  let silentUnflagged = 0;

  for (const repo of opts.repos) {
    const name = await readRepoName(repo);
    log(`${name}: building the map as of ${opts.monthsBack} months ago`);

    const all = await readLog({ repo });
    if (all.length === 0) {
      notes.push(`${name}: no commits read, skipped.`);
      continue;
    }
    // Not Math.max(...array): the spread throws RangeError above ~125k elements, and a full
    // clone of a large repository exceeds that. grafana is at 52k today.
    let headAt = -Infinity;
    for (const c of all) if (c.at > headAt) headAt = c.at;
    const T = headAt - opts.monthsBack * MS_PER_MONTH;
    const followEnd = Math.min(headAt, T + opts.followMonths * MS_PER_MONTH);
    asOfByRepo[name] = new Date(T).toISOString().slice(0, 10);

    // The map is built through the SAME builder the product path uses, with asOf set to T.
    // A validation that ran through a different builder would be validating a different tool.
    const { map } = await buildMap({ repo, asOf: T, coverage: null, onProgress: () => {} });
    if (map.regions.length === 0) {
      notes.push(`${name}: no regions as of T, skipped.`);
      continue;
    }

    // APPLY THE MAP'S OWN SIZE CAP TO THE OUTCOME WINDOW. buildMap excludes commits touching
    // more than maxFilesPerCommit files, on the grounds that one vendor drop or repo-wide
    // rename dominates every metric. The outcome side did not, so the same 1,518-file rename
    // that was excluded when constructing the arms was counted at full weight when scoring
    // them. Arms and outcomes must filter alike.
    const post = all.filter(
      (c) =>
        c.at >= T &&
        c.at <= followEnd &&
        !isBot(c.authorName, c.authorEmail) &&
        c.files.length <= DEFAULT_THRESHOLDS.maxFilesPerCommit
    );
    log(`${name}: ${map.regions.length} regions at T, ${map.regions.filter((r) => r.flagged).length} flagged, ${post.length} commits after`);

    const regionPaths = new Set(map.regions.map((r) => r.path));
    const flaggedPaths = new Set(map.regions.filter((r) => r.flagged).map((r) => r.path));
    const depth = map.report.regionDepth;
    const outcomes = outcomesFor(post, depth, regionPaths);

    // CONTRIBUTOR COUNTS GO THROUGH identity.ts, which is the only module in the tool that ever
    // sees a name or an address and which returns a truncated hash. The count that reaches the
    // report is a count of opaque keys; no name can reach the output because none is held here.
    // The roster is read over the FULL history rather than up to T, because identity clustering
    // unions transitively and a commit outside the range can be the only bridge between two
    // aliases of one person — the same reasoning build.ts records.
    const roster = (await readAuthorRoster(repo))
      .map((r) => ({ authorName: r.name, authorEmail: r.email }))
      .filter((r) => !isBot(r.authorName, r.authorEmail));
    const ids = resolveIdentities(roster);

    const contributorsByRegion = new Map<string, Set<string>>();
    const addedByRegion = new Map<string, number>();
    const deletedByRegion = new Map<string, number>();
    for (const c of post) {
      const who = ids.keyFor(c.authorName, c.authorEmail);
      for (const f of c.files) {
        if (isExcludedPath(f.path)) continue;
        const r = regionForPath(f.path, depth, regionPaths);
        if (r === null) continue;
        let s = contributorsByRegion.get(r);
        if (!s) {
          s = new Set();
          contributorsByRegion.set(r, s);
        }
        s.add(who);
        addedByRegion.set(r, (addedByRegion.get(r) ?? 0) + f.added);
        deletedByRegion.set(r, (deletedByRegion.get(r) ?? 0) + f.deleted);
      }
    }

    // ---- structural measures: the tree at T against the tree at the end of the window ----
    let filesAtTByRegion: Map<string, number> | null = null;
    let linesAtTByRegion: Map<string, number> | null = null;
    let goneByRegion: Map<string, number> | null = null;
    try {
      const shaT = await revBefore(repo, T);
      const shaEnd = await revBefore(repo, followEnd);
      if (!shaT || !shaEnd) {
        structuralGaps.push(`${name}: no commit on HEAD's history at one of the window boundaries.`);
      } else {
        log(`${name}: reading the tree at T and diffing it against the end of the window`);
        const tree = await treeLines(repo, shaT);
        const { deleted, renamed } = await structuralChanges(repo, shaT, shaEnd);

        filesAtTByRegion = new Map();
        linesAtTByRegion = new Map();
        goneByRegion = new Map();
        const regionOfPath = new Map<string, string>();
        for (const [p, lines] of tree) {
          const r = regionForPath(p, depth, regionPaths);
          if (r === null) continue;
          regionOfPath.set(p, r);
          filesAtTByRegion.set(r, (filesAtTByRegion.get(r) ?? 0) + 1);
          linesAtTByRegion.set(r, (linesAtTByRegion.get(r) ?? 0) + lines);
        }
        const markGone = (p: string) => {
          const r = regionOfPath.get(p);
          if (r === undefined) return;
          goneByRegion!.set(r, (goneByRegion!.get(r) ?? 0) + 1);
        };
        for (const p of deleted) markGone(p);
        for (const { from, to } of renamed) {
          const src = regionOfPath.get(from);
          if (src === undefined) continue;
          const dst = regionForPath(to, depth, regionPaths);
          // Renamed WITHIN the region is reorganisation, not the code leaving. See the
          // operationalisation block above.
          if (dst !== src) markGone(from);
        }
      }
    } catch (e) {
      // A structural failure must not silently become a zero. Zeros here would read as "nothing
      // was rewritten", which is a finding, and this is the absence of one.
      structuralGaps.push(`${name}: tree comparison failed (${e instanceof Error ? e.message : String(e)}).`);
      filesAtTByRegion = null;
    }

    mergeLatency.push(await probeCommitterLag(repo, name));

    for (const r of map.regions) {
      const o = outcomes.get(r.path);
      const n = o?.commits.length ?? 0;
      const flagged = flaggedPaths.has(r.path);

      // ---- the FULL SAMPLE record. Every region at T lands here, dormant or not. ----
      const filesAtT = filesAtTByRegion?.get(r.path) ?? 0;
      const linesAtT = linesAtTByRegion?.get(r.path) ?? 0;
      const filesGone = goneByRegion?.get(r.path) ?? 0;
      const structural = filesAtTByRegion !== null;
      const added = addedByRegion.get(r.path) ?? 0;
      const deleted = deletedByRegion.get(r.path) ?? 0;
      const extantAtT = structural ? filesAtT > 0 : null;
      const turnover = structural && filesAtT > 0 ? filesGone / filesAtT : null;
      const replacement = structural && linesAtT > 0 ? deleted / linesAtT : null;
      const addDeleteRatio = deleted > 0 ? added / deleted : null;
      // Null, not false, when there was nothing in the region to rewrite. See the field comment.
      const rewritten =
        !structural || filesAtT === 0
          ? null
          : (turnover !== null && turnover >= REWRITE_TURNOVER_THRESHOLD) ||
            (replacement !== null &&
              replacement >= REWRITE_REPLACEMENT_THRESHOLD &&
              addDeleteRatio !== null &&
              addDeleteRatio <= REWRITE_RATIO_QUALIFIER);

      allRegions.push({
        repo: name,
        region: r.path,
        flagged,
        postCommits: n,
        dormant: n === 0,
        contributorsPostT: contributorsByRegion.get(r.path)?.size ?? 0,
        extantAtT,
        filesAtT,
        filesGone,
        turnover,
        linesAtT,
        linesAddedPostT: added,
        linesDeletedPostT: deleted,
        replacement,
        addDeleteRatio,
        rewritten,
      });

      // THE SELECTION PROBLEM AT THE HEART OF THIS TEST, found by running it.
      //
      // The first version required 5 post-T commits before a region counted, on the reasonable
      // ground that a rate computed from two commits is noise. On grafana that floor excluded
      // ALL FOUR flagged regions and left 54 unflagged ones, so the comparison had an empty arm
      // and reported a difference of exactly zero with a zero-width interval — a null that was
      // an artifact of the filter rather than a finding about the map.
      //
      // The floor is now 1, and that is still a conditioning step, not a fix: see the collider
      // discussion at the top of this file. Everything computed from `regions` below is
      // conditioned on a descendant of the treatment and is reported as secondary for that
      // reason. The uncontaminated comparison is the dormancy result, computed from
      // `allRegions`, which every region above reaches.
      if (n === 0) {
        if (flagged) silentFlagged++;
        else silentUnflagged++;
        continue;
      }
      const lat = fixLatencies(post, depth, r.path, regionPaths);
      lat.sort((a, b) => a - b);
      regions.push({
        repo: name,
        region: r.path,
        flagged,
        orphanedShare: r.orphanedShare,
        concentration: r.concentration,
        commitsPerMonthAtT: r.commitsPerMonth,
        postCommits: n,
        fixRate: (o?.fixes ?? 0) / n,
        reworkRate: (o?.rework ?? 0) / n,
        medianFixLatencyDays: lat.length ? lat[Math.floor(lat.length / 2)]! : null,
      });
    }
  }

  // ── THE PRIMARY RESULT ──────────────────────────────────────────────────────────────────
  const allFlagged = allRegions.filter((r) => r.flagged);
  const allUnflagged = allRegions.filter((r) => !r.flagged);
  const dormF: number[] = allFlagged.map((r) => (r.dormant ? 1 : 0));
  const dormU: number[] = allUnflagged.map((r) => (r.dormant ? 1 : 0));
  // The sensitivity analysis: the same comparison over regions that still existed at T.
  const extF = allFlagged.filter((r) => r.extantAtT === true);
  const extU = allUnflagged.filter((r) => r.extantAtT === true);
  const eDormF: number[] = extF.map((r) => (r.dormant ? 1 : 0));
  const eDormU: number[] = extU.map((r) => (r.dormant ? 1 : 0));
  const goneRegions = allRegions.filter((r) => r.extantAtT === false);

  const dormancy: DormancyResult = {
    flaggedTotal: allFlagged.length,
    flaggedDormant: dormF.reduce((a, b) => a + b, 0),
    unflaggedTotal: allUnflagged.length,
    unflaggedDormant: dormU.reduce((a, b) => a + b, 0),
    flaggedRate: allFlagged.length ? mean(dormF) : null,
    unflaggedRate: allUnflagged.length ? mean(dormU) : null,
    riskRatio: bootstrapRatio(dormF, dormU),
    riskDifference: bootstrapDifference(dormF, dormU),
    extant: {
      flaggedTotal: extF.length,
      flaggedDormant: eDormF.reduce((a, b) => a + b, 0),
      unflaggedTotal: extU.length,
      unflaggedDormant: eDormU.reduce((a, b) => a + b, 0),
      flaggedRate: extF.length ? mean(eDormF) : null,
      unflaggedRate: extU.length ? mean(eDormU) : null,
      riskRatio: bootstrapRatio(eDormF, eDormU),
      riskDifference: bootstrapDifference(eDormF, eDormU),
    },
    goneBeforeT: {
      flagged: goneRegions.filter((r) => r.flagged).length,
      unflagged: goneRegions.filter((r) => !r.flagged).length,
      dormant: goneRegions.filter((r) => r.dormant).length,
      total: goneRegions.length,
    },
  };
  if (dormancy.goneBeforeT.flagged > 0) {
    notes.push(
      `${dormancy.goneBeforeT.flagged} of the ${dormancy.flaggedTotal} flagged regions had no files ` +
        'left in the tree at T — their directories were deleted or moved before the map was even ' +
        'built, because the 60-month window admits a region on the strength of commits that are ' +
        'years old. Section 1 reports the dormancy comparison with and without them.'
    );
  }

  // ── COMPREHENSION-ORIENTED OUTCOMES, FULL SAMPLE ────────────────────────────────────────
  const comprehension: Comparison[] = [
    compare(
      'wholesale rewrite — share of regions classified rewritten',
      'higher-is-worse',
      false,
      allFlagged.map((r) => (r.rewritten === null ? null : r.rewritten ? 1 : 0)),
      allUnflagged.map((r) => (r.rewritten === null ? null : r.rewritten ? 1 : 0))
    ),
    compare(
      'wholesale rewrite — turnover (files at T deleted or moved out of the region)',
      'higher-is-worse',
      false,
      allFlagged.map((r) => r.turnover),
      allUnflagged.map((r) => r.turnover)
    ),
    compare(
      'wholesale rewrite — replacement (post-T deleted lines / lines at T)',
      'higher-is-worse',
      false,
      allFlagged.map((r) => r.replacement),
      allUnflagged.map((r) => r.replacement)
    ),
    compare(
      'lines added / lines deleted post-T',
      'none',
      false,
      allFlagged.map((r) => r.addDeleteRatio),
      allUnflagged.map((r) => r.addDeleteRatio)
    ),
    compare(
      'distinct contributors post-T',
      'lower-is-worse',
      false,
      allFlagged.map((r) => r.contributorsPostT),
      allUnflagged.map((r) => r.contributorsPostT)
    ),
  ];

  // ── DEFECT MEASURES, DEMOTED AND CONDITIONED ────────────────────────────────────────────
  const flagged = regions.filter((r) => r.flagged);
  const unflagged = regions.filter((r) => !r.flagged);
  const silent = { flagged: silentFlagged, unflagged: silentUnflagged };

  const defectMetrics: { key: 'fixRate' | 'reworkRate'; label: string }[] = [
    { key: 'fixRate', label: 'fix / revert rate' },
    { key: 'reworkRate', label: 'rework rate (file re-touched within 30 days)' },
  ];
  const defect = defectMetrics.map((m) =>
    compare(m.label, 'higher-is-worse', true, flagged.map((r) => r[m.key]), unflagged.map((r) => r[m.key]))
  );

  // The comprehension measures again, on the conditioned sample. This is the comparison that
  // answers "when someone DOES touch a flagged region, is it rewritten?" — the question the
  // outreach actually wants — and it is collider-biased, so it is reported in the secondary
  // section with the label attached and no direction claimed from it.
  const activeKeys = new Set(regions.map((r) => `${r.repo}\x00${r.region}`));
  const activeAll = allRegions.filter((r) => activeKeys.has(`${r.repo}\x00${r.region}`));
  const actF = activeAll.filter((r) => r.flagged);
  const actU = activeAll.filter((r) => !r.flagged);
  const conditionedComprehension: Comparison[] = [
    compare(
      'wholesale rewrite — share of regions classified rewritten',
      'higher-is-worse',
      true,
      actF.map((r) => (r.rewritten === null ? null : r.rewritten ? 1 : 0)),
      actU.map((r) => (r.rewritten === null ? null : r.rewritten ? 1 : 0))
    ),
    compare(
      'wholesale rewrite — turnover',
      'higher-is-worse',
      true,
      actF.map((r) => r.turnover),
      actU.map((r) => r.turnover)
    ),
    compare(
      'wholesale rewrite — replacement',
      'higher-is-worse',
      true,
      actF.map((r) => r.replacement),
      actU.map((r) => r.replacement)
    ),
    compare(
      'distinct contributors post-T',
      'lower-is-worse',
      true,
      actF.map((r) => r.contributorsPostT),
      actU.map((r) => r.contributorsPostT)
    ),
  ];

  // Churn is the obvious confound: the map flags on churn, and a busier region has more
  // opportunities to contain a fix commit. Splitting at the median churn at T does not remove
  // the confound, and it does nothing at all about the collider — the stratified comparison is
  // computed on the same conditioned sample and inherits every problem it has.
  const churnSorted = [...regions].sort((a, b) => a.commitsPerMonthAtT - b.commitsPerMonthAtT);
  const medianChurn = churnSorted.length
    ? churnSorted[Math.floor(churnSorted.length / 2)]!.commitsPerMonthAtT
    : 0;
  const churnStratified: ValidationResult['churnStratified'] = [];
  for (const [label, pick] of [
    ['below median churn at T', (r: RegionOutcome) => r.commitsPerMonthAtT <= medianChurn],
    ['above median churn at T', (r: RegionOutcome) => r.commitsPerMonthAtT > medianChurn],
  ] as const) {
    const f = flagged.filter(pick);
    const u = unflagged.filter(pick);
    for (const m of defectMetrics) {
      churnStratified.push({
        stratum: label,
        nFlagged: f.length,
        nUnflagged: u.length,
        metric: m.label,
        orientation: 'higher-is-worse',
        difference: bootstrapDifference(f.map((r) => r[m.key]), u.map((r) => r[m.key])),
      });
    }
  }

  if (allFlagged.length === 0) {
    notes.push(
      'NO REGION WAS FLAGGED AT T IN ANY REPOSITORY, so there is no treatment arm and nothing ' +
        'in this document is a comparison. Read every table as "not computed".'
    );
  } else if (flagged.length === 0 && silentFlagged > 0) {
    notes.push(
      `ALL ${silentFlagged} FLAGGED REGIONS WENT DORMANT. That is the headline result rather than ` +
        'a missing-data problem, and it is reported as such above. It does mean every comparison ' +
        'conditioned on post-T activity has an empty arm; those are printed as "not computed", ' +
        'never as "no effect".'
    );
  } else if (flagged.length < 10) {
    notes.push(
      `Only ${flagged.length} flagged regions had any post-T activity. Beyond being collider-biased, ` +
        'that arm is too small to lean on: report the direction, not the interval, and add ' +
        'repositories before citing it.'
    );
  }
  if (structuralGaps.length) {
    notes.push(
      'The tree-comparison measures (turnover, replacement, rewrite) are missing for at least one ' +
        'repository; the affected regions are excluded from those rows rather than counted as zero, ' +
        'and the denominators printed with each row show how many remain.'
    );
  }

  return {
    repos: opts.repos,
    monthsBack: opts.monthsBack,
    followMonths: opts.followMonths,
    asOf: asOfByRepo,
    allRegions,
    regions,
    dormancy,
    comprehension,
    defect,
    conditionedComprehension,
    churnStratified,
    mergeLatency,
    notes,
    silent,
    structuralGaps,
  };
}

const p3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : 'not computed');
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/**
 * A ZERO-WIDTH INTERVAL IS NOT A PRECISE ANSWER, and it must never be typeset as one.
 *
 * `0.000 [0.000, 0.000]` is the most misleading thing this report can print: it reads as an
 * exact null measured to three decimal places, and it is produced by the opposite situation —
 * an arm in which every region has the same value, so every bootstrap resample is identical and
 * the interval collapses. It happens whenever the treatment arm records zero events, which is
 * common here because the flagged arm is small. The report says which of the two it is looking
 * at, every time, rather than leaving the reader to guess from the width.
 */
function degenerate(iv: Interval, nFlagged: number): string {
  if (iv.n === 0 || !Number.isFinite(iv.lo) || !Number.isFinite(iv.hi)) return '';
  if (iv.hi - iv.lo > 0) return '';
  return (
    ' **This interval has zero width, which is not precision.** Every region in one arm carries ' +
    `the same value, so every resample of it is identical; with only ${nFlagged} region` +
    `${nFlagged === 1 ? '' : 's'} in the flagged arm that is a small-sample artifact and not a ` +
    'measurement. Read it as "no variation to bootstrap", never as an exact null.'
  );
}

/**
 * THE COLLIDER CAVEAT, in one place so it cannot drift between the sections that carry it.
 *
 * Every conditioned comparison in the report is introduced by this text or points at it.
 */
const COLLIDER_CAVEAT = [
  '> **These comparisons are collider-biased. They are secondary, they are descriptive, and they',
  '> are not evidence in either direction.**',
  '>',
  '> They are computed only over regions that received at least one commit after T. Having post-T',
  '> activity is not a pre-existing property of a region — it is a CONSEQUENCE of the thing being',
  '> tested. The map flags a region because its contributors stopped committing; a region whose',
  '> contributors stopped receives no commits; so post-T activity sits downstream of flagging:',
  '>',
  '> >  flagging  →  the region\'s contributors have stopped  →  no post-T commits',
  '>',
  '> Restricting the sample to regions with post-T activity therefore conditions on a DESCENDANT',
  '> OF THE TREATMENT. That is a collider: it opens a non-causal path between flagging and',
  '> everything correlated with activity, and it can manufacture an association — including one',
  '> pointing the wrong way — where none exists in the population.',
  '>',
  '> The surviving flagged regions are precisely the ones somebody picked back up, which is the',
  '> subset you would expect to look healthiest. So a result here reading "flagged regions did',
  '> better" is at least as likely to be that selection artifact as a real anti-prediction, and it',
  '> must not be cited as either. The only comparison in this document free of this problem is the',
  '> dormancy result at the top, which uses the full sample of regions at T.',
].join('\n');

/** The sign check, done once, with the orientation consulted rather than assumed. */
function verdictLine(c: Comparison): string {
  if (c.nFlagged === 0 || c.nUnflagged === 0) {
    return (
      '> **Not computed.** One arm is empty, so this difference is a placeholder and not a ' +
      'measurement. See the notes.'
    );
  }
  if (c.orientation === 'none') {
    return (
      '> **No orientation.** Neither direction of this measure is unambiguously worse — a region ' +
      'can be growing, shrinking or substituting — so it is reported descriptively and no ' +
      'direction is claimed from it. It qualifies the replacement test above; it is not a test.'
    );
  }
  // A zero-width interval that happens to miss zero would otherwise be read out as a confident
  // finding. It is the opposite: it means one arm had no variation left to resample.
  if (Number.isFinite(c.difference.lo) && c.difference.hi - c.difference.lo === 0) {
    return (
      '> **No direction claimed.** The bootstrap interval has zero width — one arm carries a ' +
      'single value across all of its regions, so there was no variation to resample. That is a ' +
      'small-sample artifact, not a precise result.'
    );
  }
  const crosses = c.difference.lo <= 0 && c.difference.hi >= 0;
  if (crosses) {
    return (
      '> The interval crosses zero. On this evidence the flag does not predict this outcome. ' +
      'Note that a CI straddling zero is not evidence of equivalence — it may mean the ' +
      'comparison is underpowered, which the region counts above will show.'
    );
  }
  // THE SIGN MUST BE CHECKED AGAINST THE METRIC'S OWN ORIENTATION, and an earlier version did
  // not check it at all: it printed "excludes zero in the predicted direction" for ANY interval
  // that missed zero, so a pooled fix-rate difference of -0.007 — flagged regions doing BETTER —
  // was rendered as a confirmation. That is the single worst thing this file could do, because
  // it turns an artifact built to be capable of failing into one that cannot. Not every outcome
  // here points the same way either: `distinct contributors post-T` is LOWER-is-worse, so the
  // predicted sign for it is negative and a naive `> 0` test would invert it.
  const predicted = c.orientation === 'higher-is-worse' ? 1 : -1;
  const observed = c.difference.estimate > 0 ? 1 : -1;
  const worseWord = c.orientation === 'higher-is-worse' ? 'higher' : 'lower';
  return observed === predicted
    ? `> The interval excludes zero in the predicted direction: flagged regions came out ${worseWord}, ` +
        'which is worse for this metric.'
    : '> **The interval excludes zero in the WRONG direction: flagged regions did BETTER than ' +
        'unflagged ones on this metric.** This is evidence against the map, not for it. Do not ' +
        'cite it in support of the flagging rule.';
}

function comparisonBlock(c: Comparison, L: string[]): void {
  const orient =
    c.orientation === 'higher-is-worse'
      ? 'higher is worse'
      : c.orientation === 'lower-is-worse'
      ? 'LOWER is worse'
      : 'no worse/better direction';
  L.push(`### ${c.metric}`);
  L.push('');
  L.push(`Orientation: **${orient}**. Regions contributing: ${c.nFlagged} flagged, ${c.nUnflagged} not flagged.`);
  if (c.undefinedFlagged || c.undefinedUnflagged) {
    L.push('');
    L.push(
      `Excluded as undefined for this metric (a zero denominator, not a zero value): ` +
        `${c.undefinedFlagged} flagged, ${c.undefinedUnflagged} not flagged.`
    );
  }
  L.push('');
  L.push('| arm | n | p10 | p25 | median | p75 | p90 | mean |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  const row = (label: string, n: number, q: ReturnType<typeof quantiles>, m: number) =>
    n === 0
      ? `| ${label} | 0 | not computed | not computed | not computed | not computed | not computed | not computed |`
      : `| ${label} | ${n} | ${p3(q.p10)} | ${p3(q.p25)} | ${p3(q.p50)} | ${p3(q.p75)} | ${p3(q.p90)} | ${p3(m)} |`;
  L.push(row('flagged', c.nFlagged, c.flaggedQuantiles, c.flaggedMean));
  L.push(row('not flagged', c.nUnflagged, c.unflaggedQuantiles, c.unflaggedMean));
  L.push('');
  L.push(
    c.nFlagged === 0 || c.nUnflagged === 0
      ? 'Difference (flagged − not): **not computed** — one arm is empty.'
      : `Difference (flagged − not): **${p3(c.difference.estimate)}** ` +
          `95% CI [${p3(c.difference.lo)}, ${p3(c.difference.hi)}], cluster bootstrap over regions.` +
          degenerate(c.difference, c.nFlagged)
  );
  L.push('');
  L.push(verdictLine(c));
  L.push('');
}

export function formatValidationReport(r: ValidationResult): string {
  const L: string[] = [];
  const d = r.dormancy;
  const activeFlagged = r.regions.filter((x) => x.flagged).length;
  const activeUnflagged = r.regions.length - activeFlagged;

  L.push('# Retrospective validation — does a flag predict anything?');
  L.push('');
  L.push(
    `The map was rebuilt as of ${r.monthsBack} months before each repository's HEAD, using only ` +
      `commits before that date, and outcomes were measured over the following ${r.followMonths} months.`
  );
  L.push('');
  L.push(`Repositories: ${Object.entries(r.asOf).map(([k, v]) => `${k} (T=${v})`).join(', ') || 'none'}`);
  L.push(
    `Regions in the map at T: **${r.allRegions.length}** — ${d.flaggedTotal} flagged, ` +
      `${d.unflaggedTotal} not. This is the full sample and the denominator for the headline result.`
  );
  L.push(
    `Of those, ${r.regions.length} received any commit after T (${activeFlagged} flagged, ` +
      `${activeUnflagged} not). Comparisons restricted to that subset are secondary and appear last.`
  );
  L.push('');

  // ── 1. THE HEADLINE ──────────────────────────────────────────────────────────────────────
  L.push('## 1. Headline: flagged regions go dormant');
  L.push('');
  L.push(
    '**This is the one comparison in this document that conditions on nothing downstream of ' +
      'flagging.** The denominator is every region that existed in the map at T, and the outcome ' +
      'is measured on all of them. Nothing is dropped for being quiet, and "nobody touched it" is ' +
      'recorded as an outcome rather than as missing data.'
  );
  L.push('');
  L.push('Outcome: the region received **zero** commits in the follow-up window. Higher is worse.');
  L.push('');
  L.push('| arm | regions at T | went dormant | dormancy rate |');
  L.push('| --- | --- | --- | --- |');
  L.push(
    `| flagged | ${d.flaggedTotal} | ${d.flaggedDormant} | ` +
      `${d.flaggedRate === null ? 'not computed' : pct(d.flaggedRate)} |`
  );
  L.push(
    `| not flagged | ${d.unflaggedTotal} | ${d.unflaggedDormant} | ` +
      `${d.unflaggedRate === null ? 'not computed' : pct(d.unflaggedRate)} |`
  );
  L.push('');
  if (d.flaggedTotal === 0 || d.unflaggedTotal === 0) {
    L.push(
      '> **Not computed.** One arm has no regions at all, so neither the ratio nor the difference ' +
        'means anything. See the notes.'
    );
    L.push('');
  } else {
    const rr = d.riskRatio;
    const rd = d.riskDifference;
    L.push(
      `**Risk ratio (flagged / not flagged): ${p3(rr.estimate)}**` +
        (rr.n === 0
          ? ' — not computed; the comparison arm has no dormant regions, so the ratio is undefined.'
          : ` 95% CI [${p3(rr.lo)}, ${p3(rr.hi)}]` +
            (rr.discarded
              ? `, from ${5000 - rr.discarded} of 5,000 resamples — ${rr.discarded} were discarded ` +
                'because the comparison arm resampled to zero dormant regions and the ratio was ' +
                'undefined on them. A large discard count means the upper bound is not trustworthy.'
              : ', cluster bootstrap over regions, no resamples discarded.') +
          degenerate(rr, d.flaggedTotal))
    );
    L.push('');
    L.push(
      `**Risk difference (flagged − not flagged): ${p3(rd.estimate)}** ` +
        `95% CI [${p3(rd.lo)}, ${p3(rd.hi)}], cluster bootstrap over regions.` +
        degenerate(rd, d.flaggedTotal)
    );
    L.push('');
    const crosses = rd.lo <= 0 && rd.hi >= 0;
    L.push(
      crosses
        ? '> The risk difference crosses zero: on this evidence a flag does not predict dormancy either.'
        : rd.estimate > 0
        ? '> The interval excludes zero in the predicted direction: flagged regions went dormant ' +
          'at a higher rate, which is worse.'
        : '> **The interval excludes zero in the WRONG direction: flagged regions went dormant ' +
          'LESS often than unflagged ones.** That is evidence against the map, not for it.'
    );
    L.push('');
  }
  // ── THE SENSITIVITY ANALYSIS. It changes how the headline reads and it goes next to it. ──
  const g = d.goneBeforeT;
  const e = d.extant;
  if (g.total > 0) {
    L.push('### 1a. Sensitivity: most of the flagged arm was already gone at T');
    L.push('');
    L.push(
      `**${g.flagged} of the ${d.flaggedTotal} flagged regions had no files left in the tree at T** ` +
        `(against ${g.unflagged} of ${d.unflaggedTotal} unflagged). Their directories had already ` +
        'been deleted or moved before the map was built. The map\'s 60-month window admits a region ' +
        'on the strength of commits that are years old, so a directory that ceased to exist in year ' +
        'two is still a row in year five — and a region with no files cannot receive commits. ' +
        `${g.dormant} of those ${g.total} already-empty regions are dormant, which is arithmetic ` +
        'rather than prediction.'
    );
    L.push('');
    L.push(
      'So the dormancy comparison is repeated over only the regions that still existed at T. ' +
        'Whether a region\'s directory exists at T is a function of history **before** T, measured ' +
        'at the same instant the flag is, so it is not downstream of flagging — stratifying on it is ' +
        'ordinary covariate adjustment and not a second collider.'
    );
    L.push('');
    L.push('| arm | regions still extant at T | went dormant | dormancy rate |');
    L.push('| --- | --- | --- | --- |');
    L.push(
      `| flagged | ${e.flaggedTotal} | ${e.flaggedDormant} | ` +
        `${e.flaggedRate === null ? 'not computed' : pct(e.flaggedRate)} |`
    );
    L.push(
      `| not flagged | ${e.unflaggedTotal} | ${e.unflaggedDormant} | ` +
        `${e.unflaggedRate === null ? 'not computed' : pct(e.unflaggedRate)} |`
    );
    L.push('');
    if (e.flaggedTotal === 0 || e.unflaggedTotal === 0) {
      L.push(
        '> **Not computed.** One arm has no extant regions at all, which is itself the finding: ' +
          'read it with the counts above and not as a null.'
      );
    } else {
      L.push(
        `Risk ratio: **${p3(e.riskRatio.estimate)}**` +
          (e.riskRatio.n === 0
            ? ' — not computed; the comparison arm resampled to no dormant regions, so the ratio is undefined.'
            : ` 95% CI [${p3(e.riskRatio.lo)}, ${p3(e.riskRatio.hi)}]` +
              (e.riskRatio.discarded
                ? ` (${e.riskRatio.discarded} of 5,000 resamples discarded for a zero denominator)`
                : '')) +
          `. Risk difference: **${p3(e.riskDifference.estimate)}** ` +
          `95% CI [${p3(e.riskDifference.lo)}, ${p3(e.riskDifference.hi)}].` +
          degenerate(e.riskRatio, e.flaggedTotal) +
          degenerate(e.riskDifference, e.flaggedTotal)
      );
      L.push('');
      const eCrosses = e.riskDifference.lo <= 0 && e.riskDifference.hi >= 0;
      L.push(
        eCrosses
          ? '> **The headline does not survive this adjustment.** Among regions that still existed ' +
              'at T the interval crosses zero, so the dormancy result is carried by regions whose ' +
              'code had already been removed before the map was built. Note that this arm is small ' +
              '— the adjustment discards most of the flagged regions — so this is not evidence of ' +
              'equivalence either; it is a loss of the evidence, which is a different thing and a ' +
              'reason not to cite the headline without this table beside it.'
          : e.riskDifference.estimate > 0
          ? '> The headline survives the adjustment: among regions that still existed at T, flagged ' +
              'regions still went dormant more often.'
          : '> **Among regions that still existed at T the difference reverses: flagged regions went ' +
              'dormant LESS often.** The headline is carried entirely by regions whose code had ' +
              'already been removed before the map was built. Do not cite the headline alone.'
      );
    }
    L.push('');
  }

  L.push('**The honest caveat, which has to travel with the number.**');
  L.push('');
  L.push(
    'This is close to mechanical. The map flags a region for having contributors who stopped ' +
      'committing, and a region whose contributors stopped then receives no commits — which is ' +
      'nearly the same statement made twice. It is a real predictive finding, and what it predicts ' +
      'is **dormancy**: the ownership signal does identify, a year ahead, code that is about to go ' +
      'quiet. That is worth something to a reader deciding where to get things written down while ' +
      'someone can still write them.'
  );
  L.push('');
  if (g.total > 0) {
    // The denominator here is the number of DORMANT regions, not the number of already-empty
    // ones — printing g.total gave "69 of the 69", which quietly dropped the three dormant
    // regions that did still have files and overstated how complete the explanation is.
    const dormantTotal = d.flaggedDormant + d.unflaggedDormant;
    L.push(
      `And it is *more* mechanical than that sentence admits, which is what section 1a is for: ` +
        `${g.dormant} of the ${dormantTotal} dormant regions across both arms had no files in the ` +
        'tree at T at all. For those, "received no commits in the following year" is not a prediction ' +
        'that came true, it is a description of a directory that no longer existed. Read the ' +
        'headline number as an upper bound and the extant-only table as the part of it that is ' +
        'about live code.'
    );
    L.push('');
  }
  L.push(
    'It is **not** evidence that flagged regions produce worse work when someone does touch them. ' +
      'That is the claim the outreach would want, and nothing in this document supports it — the ' +
      'comparisons that would test it are all conditioned on post-T activity and are collider-biased ' +
      'for exactly the reason this result exists. See section 4.'
  );
  L.push('');
  L.push(
    'Resampling is over regions, not over repositories. Regions within one repository share a ' +
      'release cycle and a team, so the true interval is wider than the printed one.'
  );
  L.push('');

  // ── 2. COMPREHENSION-ORIENTED OUTCOMES ───────────────────────────────────────────────────
  L.push('## 2. Comprehension-oriented outcomes (full sample)');
  L.push('');
  L.push(
    'The map claims that nobody understands this code any more. Comprehension loss shows up as ' +
      'work being **slowed or discarded**, not as defects — code nobody understands can be ' +
      'perfectly correct and still be code nobody can change. These measures are computed on the ' +
      'full sample of regions at T, so they are not collider-biased, though see the coupling ' +
      'warning below.'
  );
  L.push('');
  L.push('**How wholesale rewrite is operationalised**, so a disagreeing reader can see the choices:');
  L.push('');
  L.push(
    '- *Turnover* — of the non-excluded files under the region in the tree at T, the share that ' +
      'are gone by the end of the window. "Gone" means deleted, or renamed to a path in a ' +
      '**different** region; a rename that stays inside the region is reorganisation and does not ' +
      'count. Measured by one tree-to-tree diff with exhaustive rename detection enabled.'
  );
  L.push(
    '- *Replacement* — post-T deleted lines in the region over the region\'s total line count at T. ' +
      'A ratio of volumes, not a fraction of a fixed set: a line deleted, restored and deleted ' +
      'again counts twice, so it can exceed 1.0. A value of 1.0 means the window deleted as many ' +
      'lines as the region contained.'
  );
  L.push(
    `- *Rewritten* — a region counts as rewritten when turnover ≥ ${REWRITE_TURNOVER_THRESHOLD}, ` +
      `**or** when replacement ≥ ${REWRITE_REPLACEMENT_THRESHOLD} and the added/deleted line ratio ` +
      `is ≤ ${REWRITE_RATIO_QUALIFIER}. The ratio qualifier is what separates a rewrite from a region ` +
      'that grew a lot and tidied up on the way. These three numbers are judgement calls and are ' +
      'printed here rather than buried, on the same principle as the map\'s own thresholds.'
  );
  L.push('');
  L.push(
    '**Where it breaks.** The tree diff compares two snapshots and cannot be filtered the way the ' +
      'arms were, so a bot commit or an oversized vendor drop inside the window contributes to ' +
      'turnover even though the map excluded exactly those commits when building the arms. There is ' +
      'no cheap fix: numstat cannot tell a deletion from a file truncated to zero, and renames are ' +
      'resolved to their new path before this harness sees them, so only a tree diff sees a ' +
      'deletion-by-rename at all.'
  );
  L.push('');
  L.push(
    '**Coupling warning, which must be read with every row in this section.** Turnover and ' +
      'replacement are bounded above by activity: a dormant region cannot have its files rewritten, ' +
      'because nobody committed. On the full sample the flagged arm is therefore dragged toward ' +
      'zero on these measures by the very dormancy that is the headline result. A **lower** flagged ' +
      'rewrite rate here restates section 1 and is not independent evidence that flagged code is ' +
      'healthy. The version of this comparison that would answer "when someone does touch it" is ' +
      'in section 4, and is collider-biased.'
  );
  L.push('');
  for (const c of r.comprehension) comparisonBlock(c, L);

  L.push('### Time from first branch commit to merge — NOT COMPUTABLE, and not estimated');
  L.push('');
  L.push(
    'This was asked for and it is not in the data. The tool reads `git log --no-merges`, so merge ' +
      'commits are not in the corpus at all, and a plain clone carries no pull-request records, no ' +
      'branch creation times and no review events. There is no branch-to-merge interval to measure.'
  );
  L.push('');
  L.push(
    'The one candidate proxy that lives inside a clone is the **author-date to committer-date lag**: ' +
      'on a rebase-merge workflow the author date is preserved from when the commit was written and ' +
      'the committer date is stamped when it lands on the trunk, so the gap would be time spent in ' +
      'review. That proxy was measured on the repositories in this run rather than assumed:'
  );
  L.push('');
  if (r.mergeLatency.length === 0) {
    L.push('| repository | commits | with non-zero lag | share |');
    L.push('| --- | --- | --- | --- |');
    L.push('| — | not computed | not computed | not computed |');
  } else {
    L.push('| repository | commits | with non-zero lag | share | median non-zero lag (days) |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const m of r.mergeLatency) {
      L.push(
        `| ${m.repo} | ${m.commits} | ${m.nonZeroLag} | ${pct(m.shareNonZeroLag)} | ` +
          `${m.medianNonZeroLagDays === null ? 'not computed' : m.medianNonZeroLagDays.toFixed(2)} |`
      );
    }
  }
  L.push('');
  const worst = r.mergeLatency.reduce<MergeLatencyProbe | null>(
    (acc, m) => (acc === null || m.shareNonZeroLag > acc.shareNonZeroLag ? m : acc),
    null
  );
  const best = r.mergeLatency.reduce<MergeLatencyProbe | null>(
    (acc, m) => (acc === null || m.shareNonZeroLag < acc.shareNonZeroLag ? m : acc),
    null
  );
  L.push(
    '**Verdict: not computable from a clone, and no proxy here is defensible.** ' +
      (worst && best
        ? `The lag is exactly zero for the large majority of commits in every repository in this run ` +
          `— the share carrying any lag at all ranges from ${pct(best.shareNonZeroLag)} (${best.repo}) ` +
          `to ${pct(worst.shareNonZeroLag)} (${worst.repo}). `
        : '') +
      'GitHub\'s squash and rebase merge buttons rewrite both dates to the same instant, so the ' +
      'measure is structurally zero for almost every commit and a per-region median or mean of it ' +
      'would be a median or mean of zeros.'
  );
  L.push('');
  L.push(
    'Worse than being empty, it is not empty in a neutral way. The share carrying any lag varies by ' +
      'more than an order of magnitude across repositories, which means the quantity it tracks is ' +
      'the repository\'s **merge configuration**, not its review latency — the same failure mode the ' +
      'record dimension guards against with the squash check, where a metric computed from commit ' +
      'messages measures the merge button rather than any author. A per-region average of that would ' +
      'be a number that moves when a maintainer changes a repository setting, presented as evidence ' +
      'about the people who work there. So no time-to-merge column is reported. An honest gap is ' +
      'worth more than a bad proxy, and closing it needs the forge API, which this tool deliberately ' +
      'does not use.'
  );
  L.push('');

  // ── 3. DEFECT MEASURES ───────────────────────────────────────────────────────────────────
  L.push('## 3. Defect measures (demoted, and collider-biased)');
  L.push('');
  L.push(
    '**These do not test the map\'s claim.** Fix rate and rework rate are DEFECT measures, and the ' +
      'claim under test is about comprehension, not correctness. Code nobody understands can be ' +
      'perfectly correct and still be code nobody can change. They are kept because they were ' +
      'measured and deleting a measured null is not honest, and they are demoted below section 2 ' +
      'because they answer a question nobody asked of this tool.'
  );
  L.push('');
  L.push(
    'They are **also collider-biased**: both are rates over post-T commits and are undefined without ' +
      'them, so they are computed only on regions that survived into the follow-up window. The full ' +
      'explanation is in section 4 and applies here unchanged.'
  );
  L.push('');
  const pcF = quantiles(r.regions.filter((x) => x.flagged).map((x) => x.postCommits));
  const pcU = quantiles(r.regions.filter((x) => !x.flagged).map((x) => x.postCommits));
  for (const c of r.defect) {
    comparisonBlock(c, L);
    // A rate computed from one post-T commit is typeset identically to one from 870 unless the
    // denominators are shown. Half the flagged arm in the first four-repo run had 1-4 commits,
    // where a fix rate of exactly 0 is close to arithmetically forced.
    L.push(
      `Post-T commits per region — flagged: ${activeFlagged === 0 ? 'not computed (empty arm)' : `median ${pcF.p50.toFixed(0)} (p10 ${pcF.p10.toFixed(0)}, p90 ${pcF.p90.toFixed(0)})`}; ` +
        `not flagged: ${activeUnflagged === 0 ? 'not computed (empty arm)' : `median ${pcU.p50.toFixed(0)} (p10 ${pcU.p10.toFixed(0)}, p90 ${pcU.p90.toFixed(0)})`}. ` +
        'A rate from a single-figure denominator is not a measurement.'
    );
    L.push('');
  }

  // ── 4. THE CONDITIONED, COLLIDER-BIASED COMPARISONS ──────────────────────────────────────
  L.push('## 4. Secondary: everything conditioned on post-T activity');
  L.push('');
  L.push(COLLIDER_CAVEAT);
  L.push('');
  L.push(
    `Sample for this section: ${r.regions.length} regions with at least one post-T commit — ` +
      `${activeFlagged} flagged, ${activeUnflagged} not. The ${r.silent.flagged} flagged and ` +
      `${r.silent.unflagged} unflagged regions that went dormant are excluded here **by ` +
      'construction, not by choice** — the metrics are undefined without commits — which is the ' +
      'whole problem, and is why section 1 rather than this section carries the result.'
  );
  L.push('');
  L.push('### 4a. Comprehension outcomes, restricted to regions someone touched');
  L.push('');
  L.push(
    'This is the comparison the outreach actually wants — "when someone does touch a flagged ' +
      'region, is it rewritten?" — and it is the one that cannot be trusted. Reported for ' +
      'completeness, with no direction claimed from it.'
  );
  L.push('');
  for (const c of r.conditionedComprehension) comparisonBlock(c, L);

  L.push('### 4b. Defect measures stratified by churn at T');
  L.push('');
  L.push(
    'Churn is the obvious confound: the map flags partly on churn, and a busier region has more ' +
      'opportunities to contain a fix commit. Splitting at the median does not remove the confound, ' +
      'and it does nothing whatsoever about the collider — these strata are cut from the same ' +
      'activity-conditioned sample and inherit every problem it has.'
  );
  L.push('');
  L.push('| stratum | metric | orientation | flagged n | unflagged n | difference | 95% CI |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of r.churnStratified) {
    // An empty arm produced `0.000 [0.000, 0.000]`, which reads as a precise null rather than
    // as nothing at all. The caveat existed only in the main tables.
    const cell =
      s.nFlagged === 0 || s.nUnflagged === 0
        ? 'not computed | one arm empty'
        : `${p3(s.difference.estimate)} | [${p3(s.difference.lo)}, ${p3(s.difference.hi)}]`;
    L.push(
      `| ${s.stratum} | ${s.metric} | higher is worse | ${s.nFlagged} | ${s.nUnflagged} | ${cell} |`
    );
  }
  L.push('');

  L.push('## What this cannot establish');
  L.push('');
  L.push('- Flagging is not random assignment. Flagged regions differ from unflagged ones in ways');
  L.push('  the map measures and in ways it does not, so this is an association and not an effect.');
  L.push('- The dormancy result is close to a restatement of the flagging rule. It is a prediction');
  L.push('  about activity, not about quality, and section 1 says so at the point of use.');
  L.push('- Most of the dormant regions in both arms had already been deleted from the tree before T,');
  L.push('  so the headline is substantially a statement about the map\'s 60-month window admitting');
  L.push('  directories that no longer exist. Section 1a adjusts for it; the adjusted arm is small.');
  L.push('- The defect outcomes are derived from commit messages, which is the same channel the record');
  L.push('  dimension measures. A team that never writes "revert" looks healthy here by construction.');
  L.push('  The section 2 outcomes are structural — trees, line counts, identity counts — to avoid this,');
  L.push('  and pay for it by being coupled to activity instead.');
  L.push('- Time from branch to merge is not in a clone at all, and is reported as not computed rather');
  L.push('  than proxied. See section 2.');
  L.push('- Public repositories are not private codebases, and their review culture is stronger.');
  L.push('- No individual is named anywhere in this document. Contributor counts are counts of opaque');
  L.push('  identity keys produced by `identity.ts`, which is the only module that ever sees a name.');
  L.push('');
  if (r.structuralGaps.length) {
    L.push('## Structural measures unavailable');
    L.push('');
    for (const g of r.structuralGaps) L.push(`- ${g}`);
    L.push('');
  }
  if (r.notes.length) {
    L.push('## Notes');
    L.push('');
    for (const n of r.notes) L.push(`- ${n}`);
    L.push('');
  }
  return L.join('\n');
}
