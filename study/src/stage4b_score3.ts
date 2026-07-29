/**
 * Stage 4b — score three arms INDEPENDENTLY: the real record, the synthetic description, and
 * the paraphrased record.
 *
 * WHY A SEPARATE STAGE RATHER THAN AN EXTRA FIELD ON STAGE 4.
 *
 * Stage 4's default is paired A/B, which is the protocol's design. Adding a third candidate to
 * a paired prompt would change what the existing two scores mean — three texts in one prompt
 * is a different judging task from two — and it would make the new arm incomparable to the
 * runs already on disk. So this stage scores every arm the same way, alone, in its own call.
 *
 * INDEPENDENT IS THE RIGHT MODE HERE, NOT MERELY THE CONSERVATIVE ONE. The three-arm
 * comparison only means something if the arms are judged identically. Scoring alone removes
 * the contrast effect the pilot measured (paired presentation lifted the synthetic arm by
 * ~0.18 while leaving the real arm untouched), and it removes any ordering question about
 * where a third text would sit. Each judgement here depends on one text and one question.
 *
 * BLINDING. In independent mode there is nothing to blind: the prompt contains a single text
 * with no label, no provenance, and no sibling to compare against, so the scorer cannot know
 * which arm it is looking at. The arm identity lives only in this file's bookkeeping, which
 * the prompt builder never reads.
 *
 * THE SCORER STILL NEVER SEES THE DIFF. Same rule as stage 4, same enforcement: a record-only
 * reader, and `assertNoRawDiff` on every assembled prompt.
 */

import type { LlmBackend } from '@reckon/core';
import { PrReader, assertNoRawDiff } from './guard.js';
import { prDirs, readMeta, readJson, writeJson, readText, has, mapLimit } from './io.js';
import { SCORER_SYSTEM_SINGLE } from './stage4_score.js';
import type { QuestionsFile } from './stage2_questions.js';

export type Arm = 'real' | 'synthetic' | 'paraphrase';

export interface ThreeArmQuestionScore {
  concept: string;
  question: string;
  real: number;
  synthetic: number;
  paraphrase: number;
  realRationale: string;
  syntheticRationale: string;
  paraphraseRationale: string;
}

export interface ThreeArmScores {
  id: string;
  mode: 'independent';
  model: string;
  scores: ThreeArmQuestionScore[];
}

export interface Score3Report {
  attempted: number;
  written: number;
  skipped: number;
  failedQuestions: number;
  failed: string[];
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

function clampScore(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r >= 0 && r <= 2 ? r : null;
}

async function scoreOne(
  backend: LlmBackend,
  question: string,
  text: string
): Promise<{ score: number; rationale: string } | null> {
  const user = [
    `QUESTION:\n${question}`,
    '',
    `TEXT:\n"""\n${text || '(empty)'}\n"""`,
    '',
    'Return ONLY the JSON object now, starting with {',
  ].join('\n');
  assertNoRawDiff(user, 'stage4b/single-scorer-input');

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
}

export async function scoreThreeArms(
  root: string,
  backend: LlmBackend,
  modelLabel: string,
  concurrency: number,
  force = false
): Promise<Score3Report> {
  const eligible = prDirs(root).filter(
    (d) => has(d, 'questions.json') && has(d, 'synthetic.md') && has(d, 'paraphrase.md')
  );
  const dirs = eligible.filter((d) => force || !has(d, 'scores3.json'));
  const failed: string[] = [];
  let written = 0;
  let failedQuestions = 0;

  await mapLimit(dirs, concurrency, async (dir) => {
    const meta = readMeta(dir);
    const qf = readJson<QuestionsFile>(dir, 'questions.json');
    if (!qf) return;

    const reader = new PrReader(dir, 'record-only');
    const texts: Record<Arm, string> = {
      real: reader.readRecord().trim(),
      synthetic: readText(dir, 'synthetic.md').trim(),
      paraphrase: readText(dir, 'paraphrase.md').trim(),
    };

    const scores: ThreeArmQuestionScore[] = [];
    for (const q of qf.questions) {
      const [real, synthetic, paraphrase] = await Promise.all([
        scoreOne(backend, q.question, texts.real),
        scoreOne(backend, q.question, texts.synthetic),
        scoreOne(backend, q.question, texts.paraphrase),
      ]);
      if (!real || !synthetic || !paraphrase) {
        failedQuestions++;
        continue;
      }
      scores.push({
        concept: q.concept,
        question: q.question,
        real: real.score,
        synthetic: synthetic.score,
        paraphrase: paraphrase.score,
        realRationale: real.rationale,
        syntheticRationale: synthetic.rationale,
        paraphraseRationale: paraphrase.rationale,
      });
    }

    if (scores.length === 0) {
      failed.push(meta.id);
      return;
    }

    const out: ThreeArmScores = { id: meta.id, mode: 'independent', model: modelLabel, scores };
    writeJson(dir, 'scores3.json', out);
    written++;
  });

  return { attempted: dirs.length, written, skipped: eligible.length - dirs.length, failedQuestions, failed };
}
