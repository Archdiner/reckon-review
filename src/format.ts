import type { Decision } from '@reckon/core';

export const RECKON_CHECK = 'Reckon comprehension';

/**
 * The elicit comment. Lists the decision TOPICS only (labels, never the summaries - handing
 * over the answer invites parroting) and asks for the mechanism. PR-native voice.
 */
export function elicitBody(decisions: Decision[]): string {
  const topics = decisions.length
    ? decisions.map((d, i) => `${i + 1}. ${d.concept}`).join('\n')
    : '(the change as a whole)';
  return [
    '### 🧠 Reckon: explain to merge',
    '',
    'Before this merges, explain the mechanism of what it changes, in your own words:',
    'why it works, and what breaks if done differently. Not a summary of the diff.',
    '',
    'Cover:',
    topics,
    '',
    'Reply in this thread. An isolated grader checks it, and the merge stays blocked until it passes.',
  ].join('\n');
}

/** Rescue reply on a failed grade: the single hole the grader surfaced. */
export function rescueBody(hole: string): string {
  return ['### 🧠 Close, one more pass', '', hole, '', 'Reply again in this thread.'].join('\n');
}

export function passBody(login: string): string {
  return `### ✓ Comprehension passed\n\n@${login} explained the mechanism. Merge unblocked.`;
}

/** Grader outage: neutral (not passed, not wedged) plus a clear nudge. */
export function ungradedBody(note: string): string {
  return [
    '### ⚠ Reckon grader unavailable',
    '',
    `Could not grade this (${note}). The check is neutral, not passed.`,
    'A human should confirm understanding before merging.',
  ].join('\n');
}
