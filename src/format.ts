import type { Decision } from '@reckon/core';
import type { Closeout } from './closeout.js';

export const RECKON_CHECK = 'Reckon comprehension';

// Reckon never speaks in em dashes. Our own copy is written without them, but the grader-
// and closeout-generated fields (hole, one_line, strongest, growth_edge) can come back with
// them, so we strip them at the render boundary: "A — B" becomes "A, B", the reflowed comma
// reading naturally in almost every case. Also collapses the en dash for the same reason.
function noDash(s: string): string {
  return s.replace(/\s*[—–]\s*/g, ', ').replace(/ ,/g, ',').trim();
}

// Deterministic-but-varied phrasing. A gate that opens with the identical script every time
// reads as robotic; rotating the wording keeps it human. Seeded off the PR's own topics so the
// same PR is stable across re-posts, but different PRs get different phrasings (no Math.random,
// so a webhook redelivery never changes the comment).
function pick<T>(arr: T[], seed: string): T {
  let n = 0;
  for (let i = 0; i < seed.length; i++) n = (n * 31 + seed.charCodeAt(i)) >>> 0;
  return arr[n % arr.length];
}

const ELICIT_INTROS = [
  'Before this merges, walk me through it in your own words. How it works and why, not a recap of the diff.',
  'Quick gut check before this goes in. Explain the reasoning here the way you would to a teammate, not by restating what changed.',
  "Before it lands, tell me what this is actually doing and why it holds. Your words, not the lines.",
  'One thing before merge. Help me see the mechanism here, and what would break if you did it another way.',
  'Before merging, talk me through the thinking. Why it works, and the failure it quietly steers around.',
];
const ELICIT_LEADINS = ['Speak to each of these', 'Worth touching on', 'Make sure you hit', 'A few things to cover'];
const ELICIT_CLOSERS = [
  'Reply right here in the thread. A separate grader reads it, and the merge stays put until it passes.',
  'Drop your explanation as a reply. Another grader checks it, and the merge opens once it lands.',
  'Answer in this thread. An independent grader scores it, and the gate opens once the mechanism is there.',
];

function humanize(concept: string): string {
  return concept.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// The reader-facing ask for one topic. decompose() already produced a natural-language mechanism
// QUESTION per topic (safe — it points at what to explain without handing over the answer, the way
// a bare summary would). Prefer it; fall back to a humanized slug phrase if it's ever missing.
function askFor(d: Decision): string {
  const q = (d.question || '').trim();
  return q || `the ${humanize(d.concept)}: how it works and why`;
}

/**
 * The elicit comment. Renders each topic as a natural-language mechanism question (not a raw
 * kebab slug, which reads robotically) under varied framing, in PR-native voice. Never the
 * summaries — those describe what the code does and invite parroting; a question guides instead.
 */
export function elicitBody(decisions: Decision[]): string {
  const seed = decisions.map((d) => d.concept).join('|') || 'whole';
  const out = ['### 🌊 Reckon: explain to merge', '', pick(ELICIT_INTROS, seed)];
  if (decisions.length) {
    out.push('', `${pick(ELICIT_LEADINS, seed + '^')}:`, ...decisions.map((d) => `- ${noDash(askFor(d))}`));
  }
  out.push('', pick(ELICIT_CLOSERS, seed + '~'));
  return out.join('\n');
}

const RESCUE_HEADERS = ['### 🌊 Close. One more pass.', '### 🌊 Almost there. Take another swing.', '### 🌊 So close.'];

/** Rescue reply on a failed grade: the single hole the grader surfaced. */
export function rescueBody(hole: string): string {
  return [pick(RESCUE_HEADERS, hole), '', noDash(hole), '', 'Give it one more go right here.'].join('\n');
}

/**
 * The pass message. Kept deliberately short: a passing explanation is a good moment, and the
 * surest way to make it read like AI filler is to pad it with per-topic rows and badges. So
 * we keep only the two lines worth reading, the one thing they nailed (✧) and the one place to
 * push next (▸), under a warm line naming what they now understand. Without a closeout it
 * degrades to a single human sentence. Merge is unblocked either way; all dynamic text is
 * stripped of em dashes at the boundary.
 */
export function passBody(login: string, close?: Closeout | null): string {
  if (!close) {
    return `### ✧ You explained it. Merge unblocked.\n\nNice work, @${login}. That is the real mechanism, not just a description of it.`;
  }
  const lines = [
    '### ✧ You explained it. Merge unblocked.',
    '',
    close.one_line ? `Nice work, @${login}. ${noDash(close.one_line)}` : `Nice work, @${login}.`,
  ];
  if (close.strongest) lines.push('', `✧ **Nailed it:** ${noDash(close.strongest)}`);
  if (close.growth_edge) lines.push('', `▸ **Push next:** ${noDash(close.growth_edge)}`);
  lines.push('', 'Saved to your Reckon record.');
  return lines.join('\n');
}

/** Beta rate-limit reached: not blocking, just skipped for today. */
export function cappedBody(scope: 'install' | 'global'): string {
  const which = scope === 'install'
    ? "this account has hit today's Reckon Review beta limit"
    : "Reckon Review has hit today's global beta limit";
  return [
    '### ⏳ Reckon Review, beta limit reached',
    '',
    `${which}, so this PR was not gated. The check is neutral, not blocking, so merge as normal.`,
    'Try again tomorrow.',
  ].join('\n');
}

/** Grader outage: neutral (not passed, not wedged) plus a clear nudge. */
export function ungradedBody(note: string): string {
  return [
    '### ⚠ Reckon grader unavailable',
    '',
    `Could not grade this (${noDash(note)}). The check is neutral, not passed.`,
    'Someone should confirm they understand this before it merges.',
  ].join('\n');
}
