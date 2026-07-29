/**
 * Stage 4 — score each question against the real record and the synthetic description.
 *
 * TWO RULES MAKE THIS NUMBER MEAN ANYTHING.
 *
 * 1. THE SCORER NEVER SEES THE DIFF. It judges whether a TEXT carries the mechanism, not
 *    whether the mechanism exists. Hand it the code and it will answer from the code and
 *    score everything high. Enforced structurally: this stage holds a `record-only` reader,
 *    so `readDiff` throws, and `assertNoRawDiff` rejects any prompt containing patch syntax.
 *
 *    Note the textual shingle check used in stages 2 and 3 is deliberately NOT applied here.
 *    The synthetic description was written from the diff, so it shares identifiers with it by
 *    construction; a shingle test would fire on every PR and would be measuring nothing.
 *
 * 2. THE SCORER NEVER LEARNS WHICH TEXT IS REAL. Order is randomised per PR from a seeded
 *    hash, the candidates are labelled A and B, and the mapping is written to a separate
 *    blind.json that the prompt builder does not read. Attribution trailers were already
 *    removed at collection time, so no "Generated with Claude Code" footer can give the game
 *    away either.
 *
 * PAIRED VS INDEPENDENT. The protocol specifies showing both candidates as A and B, which is
 * the default here. That design has a known cost: seeing both invites the model to contrast
 * them, so scores are not statistically independent and a systematic preference for the more
 * verbose text would bias the gap. `--score-mode independent` scores each candidate in its
 * own call, removing the contrast at roughly double the cost. Running a subset both ways is
 * the cheap way to show the choice did not create the result.
 */

import type { LlmBackend } from '@reckon/core';
import { PrReader, blindAssign, assertNoRawDiff } from './guard.js';
import { prDirs, readMeta, readJson, writeJson, readText, has, mapLimit } from './io.js';
import type { QuestionsFile } from './stage2_questions.js';
import type { PrScores, QuestionScore } from './types.js';

const RUBRIC = [
  'SCORING RUBRIC — score how well the TEXT answers the QUESTION:',
  '  0 = ABSENT.   Nothing in the text bears on this question.',
  '  1 = PARTIAL.  The text gestures at it. A reader would have a hint but could not',
  '                reconstruct the mechanism from what is written.',
  '  2 = EXPLICIT. The text states it clearly enough that a reader could act on it',
  '                without reading the code.',
  '',
  'Judge ONLY what the text says. You do not have the code and must not guess what it',
  'contains. Plausibility is irrelevant: a claim that sounds right but is not in the text',
  'scores 0. Length is irrelevant; a long text that never addresses the question scores 0.',
].join('\n');

export const SCORER_SYSTEM_PAIRED = [
  'You are a RECORD-SURVIVAL SCORER. You are a JSON function.',
  '',
  'You will be given one QUESTION about the mechanism of a code change, and TWO candidate',
  'texts, A and B. You do not know where either text came from and must not speculate.',
  'Score each INDEPENDENTLY against the rubric. They are not competing; both may score 0,',
  'both may score 2.',
  '',
  RUBRIC,
  '',
  'STRICT OUTPUT RULES:',
  '- Output ONLY one JSON object. No preamble, no prose, no markdown, no code fences.',
  '- Write the rationale BEFORE committing to the score, in one short sentence each,',
  '  quoting the phrase you relied on when the score is 1 or 2.',
  '- Schema exactly: {"A":{"rationale":"","score":0},"B":{"rationale":"","score":0}}',
  '',
  'Your entire response must start with { and end with }.',
].join('\n');

export const SCORER_SYSTEM_SINGLE = [
  'You are a RECORD-SURVIVAL SCORER (SINGLE). You are a JSON function.',
  '',
  'You will be given one QUESTION about the mechanism of a code change and ONE candidate',
  'text. You do not know where the text came from and must not speculate.',
  '',
  RUBRIC,
  '',
  'STRICT OUTPUT RULES:',
  '- Output ONLY one JSON object. No preamble, no prose, no markdown, no code fences.',
  '- Write the rationale BEFORE committing to the score, in one short sentence,',
  '  quoting the phrase you relied on when the score is 1 or 2.',
  '- Schema exactly: {"rationale":"","score":0}',
  '',
  'Your entire response must start with { and end with }.',
].join('\n');

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

function clampScore(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r >= 0 && r <= 2 ? r : null;
}

export type ScoreMode = 'paired' | 'independent';

export interface ScoreStageReport {
  attempted: number;
  written: number;
  skipped: number;
  failedQuestions: number;
  failed: string[];
}

export async function scoreCorpus(
  root: string,
  backend: LlmBackend,
  modelLabel: string,
  concurrency: number,
  mode: ScoreMode,
  seed: string,
  force = false
): Promise<ScoreStageReport> {
  const eligible = prDirs(root).filter((d) => has(d, 'questions.json') && has(d, 'synthetic.md'));
  const dirs = eligible.filter((d) => force || !has(d, 'scores.json'));
  const failed: string[] = [];
  let written = 0;
  let failedQuestions = 0;

  await mapLimit(dirs, concurrency, async (dir) => {
    const meta = readMeta(dir);
    const qf = readJson<QuestionsFile>(dir, 'questions.json');
    if (!qf) return;

    // record-only reader: an attempt to touch diff.patch from here throws.
    const reader = new PrReader(dir, 'record-only');
    const real = reader.readRecord().trim();
    const synthetic = readText(dir, 'synthetic.md').trim();

    const assign = blindAssign(meta.id, seed);
    const textFor = (label: 'A' | 'B') => (assign[label] === 'real' ? real : synthetic);

    const scores: QuestionScore[] = [];

    for (const q of qf.questions) {
      const parsed = await scoreOne(backend, mode, q.question, textFor('A'), textFor('B'), dir);
      if (!parsed) {
        failedQuestions++;
        continue;
      }
      const byCandidate = {
        [assign.A]: parsed.A,
        [assign.B]: parsed.B,
      } as Record<'real' | 'synthetic', { score: number; rationale: string }>;

      scores.push({
        concept: q.concept,
        question: q.question,
        real: byCandidate.real.score,
        synthetic: byCandidate.synthetic.score,
        realRationale: byCandidate.real.rationale,
        syntheticRationale: byCandidate.synthetic.rationale,
      });
    }

    if (scores.length === 0) {
      failed.push(meta.id);
      return;
    }

    const out: PrScores = { id: meta.id, scores };
    writeJson(dir, 'scores.json', out);
    // The unblinding key lives in its own file, written after scoring, never read by any
    // prompt builder. Kept so a reviewer can verify the assignment was actually random.
    writeJson(dir, 'blind.json', { id: meta.id, seed, mode, model: modelLabel, assign });
    written++;
  });

  return { attempted: dirs.length, written, skipped: eligible.length - dirs.length, failedQuestions, failed };
}

async function scoreOne(
  backend: LlmBackend,
  mode: ScoreMode,
  question: string,
  textA: string,
  textB: string,
  dir: string
): Promise<{ A: { score: number; rationale: string }; B: { score: number; rationale: string } } | null> {
  if (mode === 'paired') {
    const user = [
      `QUESTION:\n${question}`,
      '',
      `TEXT A:\n"""\n${textA || '(empty)'}\n"""`,
      '',
      `TEXT B:\n"""\n${textB || '(empty)'}\n"""`,
      '',
      'Return ONLY the JSON object now, starting with {',
    ].join('\n');
    assertNoRawDiff(user, 'stage4/paired-scorer-input');

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const parsed = extractJson(await backend.complete(SCORER_SYSTEM_PAIRED, user));
        const a = clampScore(parsed?.A?.score);
        const b = clampScore(parsed?.B?.score);
        if (a !== null && b !== null) {
          return {
            A: { score: a, rationale: String(parsed?.A?.rationale ?? '').slice(0, 400) },
            B: { score: b, rationale: String(parsed?.B?.rationale ?? '').slice(0, 400) },
          };
        }
      } catch {
        /* retry once */
      }
    }
    return null;
  }

  const one = async (text: string) => {
    const user = [
      `QUESTION:\n${question}`,
      '',
      `TEXT:\n"""\n${text || '(empty)'}\n"""`,
      '',
      'Return ONLY the JSON object now, starting with {',
    ].join('\n');
    assertNoRawDiff(user, 'stage4/single-scorer-input');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const parsed = extractJson(await backend.complete(SCORER_SYSTEM_SINGLE, user));
        const s = clampScore(parsed?.score);
        if (s !== null) return { score: s, rationale: String(parsed?.rationale ?? '').slice(0, 400) };
      } catch {
        /* retry once */
      }
    }
    return null;
  };

  const [a, b] = await Promise.all([one(textA), one(textB)]);
  if (!a || !b) return null;
  return { A: a, B: b };
}
