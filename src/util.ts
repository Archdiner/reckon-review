import crypto from 'crypto';
import type { Decision } from '@reckon/core';

export function hash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

// Files that never carry load-bearing decisions — docs, lockfiles, licenses, CI config.
const TRIVIAL_FILE = [
  /\.md$/i, /\.txt$/i, /\.rst$/i, /^docs\//i, /(^|\/)(LICENSE|CHANGELOG|CODEOWNERS)/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock)$/i,
  /^\.github\//i, /\.editorconfig$/i, /\.gitignore$/i,
];
// Machine-generated / vendored — changes here aren't the human's to explain.
const GENERATED = [/(^|\/)(dist|build|out|coverage|vendor|node_modules|generated)\//i, /\.min\.(js|css)$/i, /\.snap$/i, /\.map$/i];

// How many meaningful diff lines are too few to be worth a comprehension gate.
const TINY_CHANGE_LINES = 8;

export interface Classification {
  trivial: boolean;
  reason: string;
}

/**
 * Fuller than a docs-only check: a PR is trivial (auto-pass) when every changed file is
 * docs/lockfile/generated, OR the substantive change is tiny. Otherwise it's gated.
 * Conservative on the safe side — when unsure, gate.
 */
export function classify(files: string[], diff: string): Classification {
  if (files.length === 0) return { trivial: true, reason: 'no files changed' };
  const meaningful = files.filter((f) => !TRIVIAL_FILE.some((r) => r.test(f)) && !GENERATED.some((r) => r.test(f)));
  if (meaningful.length === 0) return { trivial: true, reason: 'only docs/lockfile/generated files' };

  const lines = diff.split('\n');
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  if (added + removed <= TINY_CHANGE_LINES) return { trivial: true, reason: `tiny change (${added + removed} lines)` };

  return { trivial: false, reason: `${meaningful.length} substantive file(s), ${added + removed} changed lines` };
}

// The decompose output IS the grading reference — a faithful list of the PR's load-bearing
// decisions. Render it as ground truth so the grader never needs the raw diff re-fetched.
export function decisionsToGroundTruth(decisions: Decision[]): string {
  return decisions.map((d, i) => `${i + 1}. ${d.concept}: ${d.summary}`).join('\n\n');
}

/**
 * Exponential backoff with full jitter, for retrying transient GitHub / OpenAI failures.
 * The delay doubles each attempt so a struggling upstream isn't retried in tight lockstep;
 * the cap bounds worst-case wait; and returning a random value in [0, window) (full jitter)
 * desynchronizes concurrent retriers so they don't all wake at the same instant and stampede.
 */
export function backoffMs(attempt: number, baseMs = 500, capMs = 8000): number {
  const window = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(Math.random() * window);
}
