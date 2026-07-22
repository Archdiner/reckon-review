import type { Decision } from '@reckon/core';
import type { Closeout, TopicVerdict } from './closeout.js';

export const RECKON_CHECK = 'Reckon comprehension';

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
  'Before this merges, walk me through it in your own words — the how and the why, not a summary of the diff.',
  'Quick comprehension check before merge: explain the reasoning here like you would to a teammate, not by restating what changed.',
  "Before this goes in, talk me through what it's really doing and why it holds — your words, not a recap of the lines.",
  'One thing before merge — help me understand the mechanism here, and what would break if it were done differently.',
  'Before merging, explain the thinking behind this: why it works, and the failure it steers around.',
];
const ELICIT_LEADINS = ['Speak to each of these', 'Worth covering', 'Make sure you touch on', 'A few things to hit'];
const ELICIT_CLOSERS = [
  'Reply in this thread — an isolated grader reads it, and the merge stays blocked until it passes.',
  'Drop your explanation as a reply here. A separate grader checks it; the merge unblocks once it lands.',
  "Answer in this thread. An independent grader scores it, and the gate opens once the mechanism's there.",
];

function humanize(concept: string): string {
  return concept.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// The reader-facing ask for one topic. decompose() already produced a natural-language mechanism
// QUESTION per topic (safe — it points at what to explain without handing over the answer, the way
// a bare summary would). Prefer it; fall back to a humanized slug phrase if it's ever missing.
function askFor(d: Decision): string {
  const q = (d.question || '').trim();
  return q || `the ${humanize(d.concept)} — how it works and why`;
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
    out.push('', `${pick(ELICIT_LEADINS, seed + '^')}:`, ...decisions.map((d) => `- ${askFor(d)}`));
  }
  out.push('', pick(ELICIT_CLOSERS, seed + '~'));
  return out.join('\n');
}

const RESCUE_HEADERS = ['### 🌊 Close — one more pass', '### 🌊 Almost — take another swing', '### 🌊 Nearly there'];

/** Rescue reply on a failed grade: the single hole the grader surfaced. */
export function rescueBody(hole: string): string {
  return [pick(RESCUE_HEADERS, hole), '', hole, '', 'Reply again in this thread.'].join('\n');
}

const VERDICT_MARK: Record<TopicVerdict, string> = {
  strong: '🟢 **strong**',
  solid: '🟡 solid',
  thin: '🟠 thin',
};

/**
 * The pass message. With a closeout it becomes the DEPOSIT — a per-topic read of what the
 * reviewer showed, their strongest point, and the one growth edge — so the highest-value
 * moment gives something back instead of a one-liner. Without one (closeout best-effort
 * returned null), it degrades to the simple confirmation. The merge is unblocked either way.
 */
export function passBody(login: string, close?: Closeout | null): string {
  if (!close) {
    return `### ✓ Comprehension passed\n\n@${login} explained the mechanism. Merge unblocked.`;
  }
  const rows = close.topics.map((t) => `- ${VERDICT_MARK[t.verdict]} · **${t.concept}** — ${t.note}`);
  const lines = [
    `### ✓ Comprehension passed — @${login}`,
    '',
    close.one_line,
    '',
    '**What you showed**',
    ...rows,
  ];
  if (close.strongest) lines.push('', `**Strongest** — ${close.strongest}`);
  if (close.growth_edge) lines.push('', `**Go deeper** — ${close.growth_edge}`);
  lines.push('', 'Merge unblocked, and this is now on your Reckon record.');
  return lines.join('\n');
}

/** Beta rate-limit reached: not blocking, just skipped for today. */
export function cappedBody(scope: 'install' | 'global'): string {
  const which = scope === 'install'
    ? "this account has hit today's Reckon Review beta limit"
    : "Reckon Review has hit today's global beta limit";
  return [
    '### ⏳ Reckon Review — beta limit reached',
    '',
    `${which}, so this PR was not gated. The check is neutral (not blocking) — merge as normal.`,
    'Try again tomorrow.',
  ].join('\n');
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
