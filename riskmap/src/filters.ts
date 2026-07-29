/**
 * Step 2 — what gets excluded, and what merely gets flagged.
 *
 * Every exclusion here is a hole the build spec names in advance, because each one would
 * otherwise produce a confidently wrong map:
 *
 *   GENERATED, VENDORED, LOCKFILES. Machine-maintained. Nobody understood them and nobody
 *   was ever going to write them down, so a region full of them is not at risk, it is just
 *   large. Patterns come from the study rather than being rewritten here, so the two
 *   artifacts cannot disagree about what counts as machine-maintained.
 *
 *   MIGRATIONS AND FIXTURES. High churn, low meaning. A migrations directory receives a
 *   commit every time anyone touches the schema and explains nothing about mechanism, so it
 *   would flag on churn forever. FLAGGED SEPARATELY rather than excluded: a migrations
 *   directory that no active contributor has touched is genuinely worth knowing about, it
 *   just should not be competing for the top ten on churn alone.
 *
 *   INITIAL IMPORTS AND VENDOR DROPS. One commit touching 40,000 files dominates every metric
 *   forever — it makes its author look like the owner of the entire codebase and inflates
 *   churn for a region for the whole window. Commits above a file cap are excluded from churn
 *   and authorship, and counted in the report so the exclusion is visible.
 */

import { isGeneratedPath } from './vendor/exclusions.js';
import type { Commit } from './types.js';

/**
 * Paths whose churn is real but whose meaning is thin.
 *
 * Kept in the tree and marked, not dropped: excluding them entirely would hide a genuinely
 * orphaned migrations directory, and the spec asks for "exclude or flag separately".
 */
const LOW_MEANING =
  /(^|\/)(migrations?|migrate|fixtures?|testdata|test[_-]?data|__fixtures__|golden|snapshots?|seeds?|mocks?|cassettes|vcr)(\/|$)/i;

/** Locale and translation trees. Enormous churn, no mechanism, usually machine-synced. */
const LOCALE = /(^|\/)(locales?|i18n|translations?|lang)\//i;

export function isLowMeaningPath(path: string): boolean {
  return LOW_MEANING.test(path) || LOCALE.test(path);
}

/** Excluded from the tree entirely. */
export function isExcludedPath(path: string): boolean {
  return isGeneratedPath(path);
}

export function classifyPath(path: string): 'excluded' | 'low-meaning' | 'normal' {
  if (isExcludedPath(path)) return 'excluded';
  if (isLowMeaningPath(path)) return 'low-meaning';
  return 'normal';
}

export interface FilterOpts {
  maxFilesPerCommit: number;
  /** Commits at or after this epoch ms are in the measurement window. */
  windowStart: number;
  /**
   * Upper bound on AUTHOR date. Enforced here rather than left to git, because `--before`
   * filters the COMMITTER date: a commit authored 2025-12-01 with committer date 2023-01-01
   * passes `--before=2024-06-01` and lands in a map built as of 2024-06-01. That is post-cutoff
   * information inside a map the validation harness treats as blind, so the guarantee has to be
   * enforced on the field everything downstream actually uses.
   */
  windowEnd: number;
}

export interface FilterResult {
  kept: Commit[];
  dropped: { botAuthor: number; oversized: number; noSurvivingFiles: number; outsideWindow: number };
  pathsExcluded: Record<string, number>;
}

/**
 * Apply the commit-level filters.
 *
 * Note the ORDER of the window test: it runs last, so `dropped.outsideWindow` counts commits
 * that were otherwise usable. The inactivity calculation deliberately reads commits from
 * OUTSIDE the window too — a contributor is active if they committed anywhere in the repo
 * recently, which is a repo-wide question, not a windowed one — so the caller keeps the
 * unwindowed set as well. See dimensions.ts.
 */
export function filterCommits(commits: Commit[], opts: FilterOpts): FilterResult {
  const dropped = { botAuthor: 0, oversized: 0, noSurvivingFiles: 0, outsideWindow: 0 };
  const pathsExcluded: Record<string, number> = { generated: 0 };
  const kept: Commit[] = [];

  for (const c of commits) {
    if (c.bot) {
      dropped.botAuthor++;
      continue;
    }
    if (c.files.length > opts.maxFilesPerCommit) {
      dropped.oversized++;
      continue;
    }
    const files = c.files.filter((f) => {
      if (isExcludedPath(f.path)) {
        pathsExcluded.generated = (pathsExcluded.generated ?? 0) + 1;
        return false;
      }
      return true;
    });
    if (files.length === 0) {
      dropped.noSurvivingFiles++;
      continue;
    }
    if (c.at < opts.windowStart || c.at > opts.windowEnd) {
      dropped.outsideWindow++;
      continue;
    }
    kept.push({ ...c, files });
  }

  return { kept, dropped, pathsExcluded };
}
