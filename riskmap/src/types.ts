/**
 * The shapes the map is built out of.
 *
 * One rule governs every type here: CODE IS THE PRIMARY OBJECT AND PEOPLE ARE AN ATTRIBUTE OF
 * REGIONS. There is no `Contributor` record with a name on it that survives past the rollup,
 * and nothing downstream of `Region` can name an individual even by accident, because the
 * identity is reduced to an opaque key before it reaches a region and the key never leaves.
 *
 * The moment this reads as a report on individuals it becomes an HR object and it dies.
 */

/** One (commit, file) row — the grain everything is computed from. */
export interface Edit {
  sha: string;
  /** Opaque, stable identity key. NEVER a name, NEVER an email. See identity.ts. */
  who: string;
  /** Author date, epoch ms. Author rather than committer: rebases rewrite the committer. */
  at: number;
  path: string;
  added: number;
  deleted: number;
}

/** One commit, after parsing and before it is exploded into edits. */
export interface Commit {
  sha: string;
  authorName: string;
  authorEmail: string;
  at: number;
  subject: string;
  body: string;
  files: { path: string; added: number; deleted: number }[];
  /** Carries an agent `Co-authored-by:` / generated-with trailer. */
  agentTrailer: boolean;
  /** Author matched a bot pattern. Excluded from every metric; counted in the report. */
  bot: boolean;
}

export type DropReason =
  | 'bot-author'
  | 'oversized-commit'
  | 'no-surviving-files'
  | 'outside-window';

export interface ExtractReport {
  repo: string;
  headSha: string;
  /** Analysis date: HEAD's author date, NOT wall clock. See gitlog.ts for why. */
  asOf: number;
  windowMonths: number;
  /** Months of history actually observed. Churn divides by this, not by windowMonths. */
  spanMonths: number;
  commitsSeen: number;
  commitsKept: number;
  dropped: Record<DropReason, number>;
  /** Paths removed by the file filter, by class. Reported, never silent. */
  pathsExcluded: Record<string, number>;
  identitiesBeforeMerge: number;
  identitiesAfterMerge: number;
  /** Directory depth the regions were cut at, and how that depth was chosen. */
  regionDepth: number;
  regionDepthFallback: boolean;
  /** One entry per split iteration: which region was split and the resulting count. */
  regionSplits: { step: number; split: string | null; regions: number }[];
}

/** Whether the record dimension can be trusted for this repo at all. */
export type RecordAvailability = 'available' | 'low-confidence' | 'unavailable';

export interface SquashVerdict {
  availability: RecordAvailability;
  /** Share of sampled recent commits carrying a body beyond the subject. */
  substantiveBodyShare: number;
  sampled: number;
  note: string;
}

export interface Region {
  /** Directory path. The unit of analysis — see regions.ts on why not files. */
  path: string;
  commits: number;
  edits: number;
  linesChanged: number;
  /** Distinct contributor identities touching the region in the window. */
  contributors: number;
  /** Of those, how many have no commit ANYWHERE in the repo in the inactivity window. */
  inactiveContributors: number;
  /**
   * Of the inactive ones, how many were SUBSTANTIAL — embedded enough that their leaving means
   * something. The rest are drive-bys, and on this corpus they are roughly 70% of all inactive
   * identities. Only these count toward the orphan signal.
   */
  departedContributors: number;

  // ---- the dimensions. Displayed as components, never summed into a score. ----
  /**
   * THE HEADLINE. Of the files in this region, the share whose MOST RECENT change was made by
   * a contributor now inactive repo-wide. [0,1]
   *
   * This replaced a commit-share measure, and the replacement is the difference between
   * measuring dormancy and measuring risk. Commit share puts recent commits by active people in
   * the same denominator, so activity mechanically dilutes orphaning and the two are
   * anti-correlated BY CONSTRUCTION — no threshold and no window can produce a region that is
   * both busy and orphaned. Measured on grafana across 24/36/60-month windows and with the
   * orphan and churn windows decoupled: the busy-and-orphaned cell was empty every time.
   *
   * Last-touch file share asks the knowledge question instead — of the code that is here now,
   * how much was last written by someone who has gone — and a region can score high on it while
   * under active development, because recent commits touch only part of the file set.
   */
  orphanedShare: number;
  /** The old commit-share measure, kept as a secondary reading. [0,1] */
  orphanedCommitShare: number;
  /** Share of region commits from the single largest contributor. [0,1] */
  concentration: number;
  /** Commits per month over the churn window. */
  commitsPerMonth: number;
  /** Lines changed per month over the churn window. */
  linesPerMonth: number;
  /** Share of region commits carrying an agent trailer. [0,1] Context, not quality. */
  agentDensity: number;
  /** Epoch ms of the most recent commit whose message classifies as substantive; null if none. */
  lastSubstantiveExplanation: number | null;

  // ---- record coverage, populated only when the scorer has run ----
  /** Mean explicit rate over scored commits, [0,1]. Null when unavailable or not run. */
  recordCoverage: number | null;
  /** Percentile of `recordCoverage` against the study corpus. Null when coverage is null. */
  recordCoveragePercentile: number | null;
  recordCommitsScored: number;

  // ---- ranking ----
  /**
   * Whether any file under this region still exists in the tree being analysed.
   *
   * A region can be assembled entirely from commits to files deleted long ago. Such a region
   * cannot be at risk — there is nothing left to understand — and flagging it produced the two
   * grafana rows (`pkg/framework`, `pkg/coremodel`) that a reader correctly dismissed. It also
   * contaminated the validation: 20 of 28 flagged regions had no files at the cutoff, 82 of 83
   * already-empty regions were dormant by arithmetic, and restricting to extant regions
   * collapsed the headline dormancy effect from 20/28-vs-67/253 to 0/8-vs-5/190.
   */
  extant: boolean;
  /** Which of the two findings this region represents. Empty when it clears neither. */
  findings: Finding[];
  /** Which threshold tests this region clears. Displayed; never weighted into a number. */
  flags: FlagName[];
  flagged: boolean;
}

export type FlagName = 'orphaned' | 'concentrated' | 'hot' | 'undocumented';

/**
 * The two findings this map can make, kept SEPARATE rather than blended into one risk list.
 *
 * They are different conversations and they sell differently. Bus factor is chronic, and every
 * engineering leader can already name theirs — it is a fair finding but it is not news.
 * Departure is acute, dated, and usually has an incident attached, which is the stronger one.
 *
 * Blending them lets the artifact overclaim without anyone noticing: grafana's only flagged
 * region has an orphan share of ZERO and is flagged purely on concentration, so a page headed
 * "code nobody left understands" would have been making a claim its own table refutes.
 */
export type Finding = 'departed' | 'concentrated';

export interface Thresholds {
  /** Contributor counts as inactive with no commit repo-wide in this many months. */
  inactivityMonths: number;
  /** Trailing window over which regions are measured. */
  windowMonths: number;
  orphanedShare: number;
  concentration: number;
  /** Commits per month above which a region counts as hot. */
  commitsPerMonth: number;
  /** Record-coverage percentile at or below which a region counts as undocumented. */
  coveragePercentile: number;
  /** A region flags when it clears at least this many of the four tests. */
  minFlags: number;
  /** Commits below which a region is rolled into its parent. */
  regionMinCommits: number;
  /** Commits touching more files than this are excluded from churn and authorship. */
  maxFilesPerCommit: number;
}

export interface RiskMap {
  report: ExtractReport;
  thresholds: Thresholds;
  squash: SquashVerdict;
  regions: Region[];
  /** Top flagged regions, already sorted. The page shows these. */
  top: Region[];
  calibration: CalibrationInfo | null;
  generatedAtUtc: string;
}

export interface CalibrationInfo {
  corpus: string;
  n: number;
  /** Deciles of per-PR explicit rate, [0,1], ascending. */
  deciles: number[];
  source: string;
}
