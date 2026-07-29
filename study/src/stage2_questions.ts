/**
 * Stage 2 — generate mechanism questions from the diff alone.
 *
 * This calls Reckon's PRODUCTION `decompose()` unmodified. That is deliberate: the study
 * measures the world with the instrument the product already ships, so a finding here is a
 * claim about Reckon's own question generator rather than about a bespoke research prompt
 * that nothing else uses. The same prompt runs on every PR; there is no per-repo tuning.
 *
 * THE CONSTRAINT THIS STAGE EXISTS TO HONOUR: the generator sees the diff and nothing else.
 * If the written description reached it, the questions would be shaped by the answer and the
 * entire study would be circular. Two mechanisms enforce that, and both must pass:
 *
 *   - the stage holds a `diff-only` reader, so record.md is unreachable through the API;
 *   - `verifyPromptClean` re-checks the assembled prompt against record.md before the call.
 *
 * Large diffs go through the same `diffDigest` production uses, so every changed file is
 * represented rather than the first 8000 characters. Without it, questions about a big PR
 * would be generated from its opening files and would systematically miss the tail — which
 * would depress the record's apparent answerability for reasons that have nothing to do with
 * how well the author wrote.
 */

import { decompose } from '@reckon/core';
import type { LlmBackend } from '@reckon/core';
import { diffDigest } from './vendor/diff-digest.js';
import { PrReader, assertDerivedFromDiff } from './guard.js';
import { prDirs, readMeta, writeJson, has, mapLimit, readJson } from './io.js';
import type { Question } from './types.js';

export interface QuestionsFile {
  id: string;
  generator: string;
  model: string;
  digestChars: number;
  diffChars: number;
  questions: Question[];
}

export interface QuestionStageReport {
  attempted: number;
  written: number;
  skipped: number;
  failed: string[];
}

export async function generateQuestions(
  root: string,
  backend: LlmBackend,
  modelLabel: string,
  concurrency: number,
  force = false
): Promise<QuestionStageReport> {
  const dirs = prDirs(root).filter((d) => force || !has(d, 'questions.json'));
  const skipped = prDirs(root).length - dirs.length;
  const failed: string[] = [];
  let written = 0;

  await mapLimit(dirs, concurrency, async (dir) => {
    const meta = readMeta(dir);
    const reader = new PrReader(dir, 'diff-only');
    const diff = reader.readDiff();
    const digest = diffDigest(diff);

    // The only variable input to decompose() is the digest. Confirm it is derived from the
    // diff and nothing else before any of it reaches the model.
    assertDerivedFromDiff(dir, digest, 'stage2/decompose-input');

    const result = await decompose(digest, backend);
    if (!result.ok || result.decisions.length === 0) {
      failed.push(meta.id);
      return;
    }

    const out: QuestionsFile = {
      id: meta.id,
      generator: 'reckon-core@0.5.0 decompose',
      model: modelLabel,
      digestChars: digest.length,
      diffChars: diff.length,
      questions: result.decisions,
    };
    writeJson(dir, 'questions.json', out);
    written++;
  });

  return { attempted: dirs.length, written, skipped, failed };
}

/** Total questions across the corpus, for cost estimation and reporting. */
export function countQuestions(root: string): number {
  let n = 0;
  for (const dir of prDirs(root)) {
    const q = readJson<QuestionsFile>(dir, 'questions.json');
    if (q) n += q.questions.length;
  }
  return n;
}
