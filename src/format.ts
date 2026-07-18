import { planElicitPrompt, retryPrompt } from '@reckon/core';
import type { Decision } from '@reckon/core';

const CHECK_NAME = 'Reckon — comprehension';
export const RECKON_CHECK = CHECK_NAME;

/** The elicit comment: the mechanism prompt grounded in this PR's decomposed decisions. */
export function elicitBody(subsystem: string, decisions: Decision[]): string {
  return [
    '### 🧠 Reckon — explain to merge',
    '',
    planElicitPrompt(subsystem, decisions),
    '',
    '_Reply in this thread with your explanation — the **mechanism** (why it works, what breaks',
    'if done differently), not a restatement of the diff. An isolated grader checks it; the merge',
    'stays blocked until it passes._',
  ].join('\n');
}

/** Rescue reply on a failed grade — the single hole, phrased as a re-explanation prompt. */
export function rescueBody(hole: string): string {
  return ['### 🧠 Close — one more pass', '', retryPrompt(hole, true)].join('\n');
}

export function passBody(login: string): string {
  return `### ✓ Comprehension passed\n\n@${login} explained the mechanism — merge unblocked.`;
}

/** Grader outage: neutral (not passed, not wedged) + a loud nudge for a human. */
export function ungradedBody(note: string): string {
  return [
    '### ⚠ Reckon grader unavailable',
    '',
    `Could not grade this explanation (${note}). The check is **neutral, not passed** — a human`,
    'should confirm understanding before merging.',
  ].join('\n');
}
