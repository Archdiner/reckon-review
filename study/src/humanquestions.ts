/**
 * The human-question control.
 *
 * THE THREAT THIS CLOSES. Every question in this study comes from one generator with one
 * prompt, reading the diff. The paraphrase arm showed the gap is not about surface form, but
 * it cannot touch a subtler version of the objection: that questions generated FROM a diff
 * over-weight what is locally visible in the diff, and a human deciding what actually matters
 * about a change would weight it differently. If that were driving the result, the record
 * would look uninformative mainly because it was answering a different set of questions than
 * the ones being asked.
 *
 * The control is to have a person write mechanism questions from the diff, without seeing
 * either candidate text, and score both arms against those. If the gap survives on
 * human-written questions, the objection is dead.
 *
 * WHY THIS FILE ONLY EXPORTS AND SCORES, AND NEVER GENERATES.
 *
 * The questions must be written by a HUMAN. A language model writing them — including the one
 * that ran this pipeline — belongs to the same class of generator as the one under test, and
 * would reproduce whatever framing bias the control exists to detect. Auto-filling this
 * worksheet would not be a weaker version of the control, it would be a fake one, and it
 * would be indistinguishable in the output from a real one. So there is deliberately no code
 * path here that can populate `questions`. The worksheet ships empty and a person fills it.
 *
 * BLINDING. The worksheet shows the diff and nothing else. The labeller never sees the real
 * record, the synthetic description or the paraphrase, so their questions cannot be shaped by
 * what any candidate happens to answer — which is the same constraint stage 2 operates under,
 * enforced the same way.
 *
 * SAMPLE. 35 PRs is the default: enough to detect a gap the size of the observed one, small
 * enough to finish in a sitting. Drawn seeded and stratified across the record tiers, because
 * a sample that missed the empty records would not test the finding that matters.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmBackend } from '@reckon/core';
import { PrReader, assertNoRawDiff } from './guard.js';
import { prDirs, readMeta, readText, has, mapLimit } from './io.js';
import { classifyRecord, type RecordTier } from './triviality.js';
import { SCORER_SYSTEM_SINGLE } from './stage4_score.js';

export interface HumanQuestionRow {
  id: string;
  repo: string;
  /** Filled in BY HAND. 2-4 mechanism questions answerable from understanding the change. */
  questions: string[];
  /** Optional note from the labeller, e.g. why the change was hard to read. */
  note?: string;
}

function seedFrom(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INSTRUCTIONS = [
  '# Human question worksheet',
  '',
  'You are writing the questions this study will be scored against. Nothing here is',
  'generated for you, deliberately: a model writing these would carry the same framing bias',
  'the control exists to detect.',
  '',
  '## What to do',
  '',
  'For each pull request below you get the DIFF and nothing else. Read it, and write 2-4',
  'questions about the MECHANISM of the change — the things someone would have to understand',
  'to have made it, and that a reader of the code alone might get wrong.',
  '',
  'Good questions ask why this approach, what breaks without it, what constraint forced this',
  'shape, why this boundary and not another. Bad questions ask what the code does, which is',
  'answerable by reading it.',
  '',
  'Write the questions YOU think matter. Do not try to guess what a model would ask, and do',
  'not try to make them easy or hard to answer. The point is to find out whether the study\'s',
  'result depends on its generator\'s taste in questions.',
  '',
  '## What you must not do',
  '',
  'Do not look at the pull request description, the commit messages, or the PR on GitHub.',
  'The worksheet deliberately omits them. If you know the change already, skip it and say so',
  'in `note` — a question shaped by knowing the answer is worse than a missing one.',
  '',
  '## How to record them',
  '',
  'Fill the `questions` array for each entry in `human-questions.jsonl`. Leave an entry\'s',
  'array empty to skip that PR. Then run `study score-human-questions`.',
  '',
  '---',
  '',
];

export function exportQuestionWorksheet(
  root: string,
  outDir: string,
  n: number,
  seed: string
): { prs: number; byTier: Record<string, number> } {
  const dirs = prDirs(root).filter((d) => has(d, 'diff.patch'));
  const withTier = dirs.map((d) => ({
    dir: d,
    tier: classifyRecord(readText(d, 'record.md')).tier as RecordTier,
  }));

  // Stratify across tiers so the sample cannot miss the empty records, which are where the
  // absence finding lives.
  const rng = mulberry32(seedFrom(seed));
  const shuffle = <T,>(xs: T[]) => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const tiers: RecordTier[] = ['empty', 'trivial', 'substantive'];
  const perTier = Math.max(1, Math.floor(n / tiers.length));
  const picked: typeof withTier = [];
  for (const t of tiers) {
    picked.push(...shuffle(withTier.filter((x) => x.tier === t)).slice(0, perTier));
  }
  for (const x of shuffle(withTier)) {
    if (picked.length >= n) break;
    if (!picked.some((p) => p.dir === x.dir)) picked.push(x);
  }

  mkdirSync(outDir, { recursive: true });
  const rows: HumanQuestionRow[] = [];
  const md: string[] = [...INSTRUCTIONS];
  const byTier: Record<string, number> = { empty: 0, trivial: 0, substantive: 0 };

  for (const { dir, tier } of picked.slice(0, n)) {
    const meta = readMeta(dir);
    // diff-only: the worksheet must not be able to show the record.
    const reader = new PrReader(dir, 'diff-only');
    const diff = reader.readDiff();
    byTier[tier]++;
    rows.push({ id: meta.id, repo: meta.repo, questions: [] });
    md.push(`## ${meta.id}`, '', `${meta.repo} — ${meta.changedLines} changed lines, ${meta.language}`, '');
    md.push('```diff', diff.slice(0, 20000), '```', '');
    md.push('Questions (write 2-4):', '', '1. ', '2. ', '3. ', '', '---', '');
  }

  writeFileSync(join(outDir, 'human-questions.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  writeFileSync(join(outDir, 'human-questions.md'), md.join('\n'));
  return { prs: rows.length, byTier };
}

function extractJson(raw: string): any {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

const clamp = (v: unknown): number | null => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : null;
};

export interface HumanQuestionResult {
  prs: number;
  questions: number;
  realMean: number;
  syntheticMean: number;
  paraphraseMean: number;
  realExplicitPct: number;
  syntheticExplicitPct: number;
  gap: number;
  perPrGaps: number[];
  skipped: number;
}

/**
 * Score the arms against hand-written questions. Same rubric, same independent single-text
 * calls, same record-only access as stage 4b — only the questions differ.
 */
export async function scoreAgainstHumanQuestions(
  root: string,
  worksheetPath: string,
  backend: LlmBackend,
  concurrency: number
): Promise<HumanQuestionResult | null> {
  if (!existsSync(worksheetPath)) return null;
  const rows: HumanQuestionRow[] = readFileSync(worksheetPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const filled = rows.filter((r) => Array.isArray(r.questions) && r.questions.filter((q) => q.trim()).length > 0);
  if (filled.length === 0) return null;

  const byId = new Map(prDirs(root).map((d) => [readMeta(d).id, d]));
  const real: number[] = [];
  const syn: number[] = [];
  const par: number[] = [];
  const perPrGaps: number[] = [];
  let questions = 0;

  const scoreOne = async (question: string, text: string) => {
    const user = [
      `QUESTION:\n${question}`,
      '',
      `TEXT:\n"""\n${text || '(empty)'}\n"""`,
      '',
      'Return ONLY the JSON object now, starting with {',
    ].join('\n');
    assertNoRawDiff(user, 'human-questions/scorer-input');
    for (let i = 0; i < 2; i++) {
      try {
        const s = clamp(extractJson(await backend.complete(SCORER_SYSTEM_SINGLE, user))?.score);
        if (s !== null) return s;
      } catch {
        /* retry once */
      }
    }
    return null;
  };

  await mapLimit(filled, concurrency, async (row) => {
    const dir = byId.get(row.id);
    if (!dir) return;
    const reader = new PrReader(dir, 'record-only');
    const texts = {
      real: reader.readRecord().trim(),
      synthetic: has(dir, 'synthetic.md') ? readText(dir, 'synthetic.md').trim() : '',
      paraphrase: has(dir, 'paraphrase.md') ? readText(dir, 'paraphrase.md').trim() : '',
    };
    const prReal: number[] = [];
    const prSyn: number[] = [];
    for (const q of row.questions.filter((x) => x.trim())) {
      const [a, b, c] = await Promise.all([
        scoreOne(q, texts.real),
        scoreOne(q, texts.synthetic),
        scoreOne(q, texts.paraphrase),
      ]);
      if (a === null || b === null || c === null) continue;
      real.push(a);
      syn.push(b);
      par.push(c);
      prReal.push(a);
      prSyn.push(b);
      questions++;
    }
    if (prReal.length) {
      const m = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / xs.length;
      perPrGaps.push(m(prReal) - m(prSyn));
    }
  });

  const m = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const p2 = (xs: number[]) => (xs.length ? (xs.filter((v) => v === 2).length / xs.length) * 100 : NaN);
  return {
    prs: filled.length,
    questions,
    realMean: m(real),
    syntheticMean: m(syn),
    paraphraseMean: m(par),
    realExplicitPct: p2(real),
    syntheticExplicitPct: p2(syn),
    gap: m(perPrGaps),
    perPrGaps,
    skipped: rows.length - filled.length,
  };
}
