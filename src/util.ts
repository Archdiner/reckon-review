import crypto from 'crypto';
import type { Decision } from '@reckon/core';

export function hash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

// A PR is trivial (auto-pass, no comprehension needed) when every changed file is docs,
// a lockfile, or plain text. Deliberately conservative — a single source file makes it
// non-trivial. Placeholder for a fuller classifier later.
const TRIVIAL = [/\.md$/i, /\.txt$/i, /^docs\//i, /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i];
export function isTrivial(files: string[]): boolean {
  return files.length > 0 && files.every((f) => TRIVIAL.some((re) => re.test(f)));
}

// The decompose output IS the grading reference — a faithful list of the PR's load-bearing
// decisions. Render it as ground truth so the grader never needs the raw diff re-fetched.
export function decisionsToGroundTruth(decisions: Decision[]): string {
  return decisions.map((d, i) => `${i + 1}. ${d.concept}: ${d.summary}`).join('\n\n');
}
