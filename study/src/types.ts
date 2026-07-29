/**
 * Shared types for the record-survival study.
 *
 * The central design constraint of this study is INFORMATION SEPARATION, so the types
 * are deliberately split along the lines that must never be crossed:
 *
 *   - `PrMeta`  — provenance and size. Carries NO prose from the change.
 *   - the diff  — read only by stage 2 (questions) and stage 3 (synthetic description).
 *   - the record— read only by stage 4 (scoring).
 *
 * No type in this file bundles the diff together with the written record. That is not
 * a stylistic choice; a single struct holding both is exactly how leakage gets into a
 * prompt by accident. See guard.ts for the runtime enforcement.
 */

/** Who wrote the change, and on what evidence. */
export type Provenance = 'agent' | 'human';

/**
 * How we concluded a PR was agent-authored. Recorded per PR so the analysis can be
 * re-cut by evidence strength — a bot author account is a much stronger claim than a
 * `Co-authored-by: Claude` trailer, which only attests assistance.
 */
export type ProvenanceEvidence =
  | 'bot-author' //   the commit author IS an agent account (strongest)
  | 'agent-trailer' // Co-authored-by naming an agent (attests assistance, not authorship)
  | 'agent-footer' //  "Generated with Claude Code" style footer
  | 'none'; //         no agent evidence -> classified human

export interface PrMeta {
  /** Stable id: "<owner>_<repo>__<prNumber>". Used as the directory name. */
  id: string;
  repo: string;
  prNumber: number;
  sha: string;
  /** ISO date of the merge (author date of the squash commit). */
  mergedAt: string;
  authorName: string;
  authorEmail: string;
  provenance: Provenance;
  evidence: ProvenanceEvidence;
  /** The literal marker that triggered the agent classification, for auditability. */
  evidenceMarker: string | null;
  /** Dominant language, inferred from changed file extensions. */
  language: string;
  /** Added + deleted lines, excluding files dropped by the exclusion filter. */
  changedLines: number;
  filesChanged: number;
  /** Bucketed size, used for agent/human matching. */
  sizeBucket: SizeBucket;
  /** True when the PR body was empty. Kept as data, never used to filter. */
  emptyBody: boolean;
  /**
   * Prose the written record shares verbatim with the diff, in 8-word shingles, and the
   * record's total shingle count. High overlap means the description restates text the
   * change itself contains — a changelog, an ADR, a docs edit — so the record is recoverable
   * from the artifact by copying rather than by understanding. Measured, never filtered on;
   * the analysis reports the headline with these PRs excluded as a robustness check.
   */
  recordDiffSharedShingles: number;
  recordShingles: number;
}

export type SizeBucket = '20-49' | '50-149' | '150-499' | '500+';

export function bucketOf(changedLines: number): SizeBucket {
  if (changedLines < 50) return '20-49';
  if (changedLines < 150) return '50-149';
  if (changedLines < 500) return '150-499';
  return '500+';
}

/** A mechanism question generated from the diff alone (Reckon's `decompose`). */
export interface Question {
  concept: string;
  summary: string;
  question: string;
}

/** Which candidate text a score refers to. */
export type Candidate = 'real' | 'synthetic';

export interface QuestionScore {
  concept: string;
  question: string;
  /** 0 absent, 1 partial, 2 explicit. */
  real: number;
  synthetic: number;
  realRationale: string;
  syntheticRationale: string;
}

export interface PrScores {
  id: string;
  scores: QuestionScore[];
}

/** The per-PR row published as CSV alongside the writeup. */
export interface ResultRow {
  id: string;
  repo: string;
  prNumber: number;
  provenance: Provenance;
  evidence: ProvenanceEvidence;
  language: string;
  changedLines: number;
  sizeBucket: SizeBucket;
  emptyBody: boolean;
  nQuestions: number;
  realMean: number;
  syntheticMean: number;
  realPctExplicit: number;
  syntheticPctExplicit: number;
  /** realMean - syntheticMean. The reproducibility gap, per PR. */
  gap: number;
}
