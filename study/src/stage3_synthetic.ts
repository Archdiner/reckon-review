/**
 * Stage 3 — write a synthetic PR description from the diff alone.
 *
 * This is the reproducibility control, and it is the part of the study that carries the
 * headline. The question it answers is not "are descriptions good" but "is anything in the
 * description not already recoverable from the artifact". If a model with no access to the
 * author's intent produces a description that scores as well as the real one, then the real
 * one contained nothing a human had to supply, and completeness of documentation stops being
 * evidence that a person understood the change.
 *
 * PROMPT DESIGN. The instruction asks for the house style of a normal PR description and
 * says nothing about mechanism, rationale, or the rubric. That restraint is the whole point.
 * A prompt that said "explain why this approach was chosen over alternatives" would be
 * optimising the synthetic candidate against the scoring criteria, and a win would then mean
 * "a targeted prompt beats an untargeted human", which is not a claim about anything.
 *
 * So the synthetic description is a fair proxy for the ordinary artifact: what you get when
 * you ask a model for a PR description, in the way people actually ask.
 */

import type { LlmBackend } from '@reckon/core';
import { diffDigest } from '../../src/diff-digest.js';
import { PrReader, assertDerivedFromDiff } from './guard.js';
import { prDirs, readMeta, writeText, writeJson, has, mapLimit } from './io.js';

export const SYNTHETIC_SYSTEM = [
  'You write pull request descriptions.',
  '',
  'You will be given a unified diff. Write the description that would normally accompany',
  'this pull request, in the style typical of an active open-source repository.',
  '',
  'RULES:',
  '- Output ONLY the description body in Markdown. No preamble, no code fences around the',
  '  whole response, no commentary about the task.',
  '- Do not invent issue numbers, ticket links, author names, or review history.',
  '- Do not speculate about facts the diff cannot support, such as production incidents,',
  '  benchmark figures, or customer reports.',
  '- Length should suit the size of the change: a short paragraph for a small one, a',
  '  structured description with headings or bullets for a large one.',
].join('\n');

export interface SyntheticStageReport {
  attempted: number;
  written: number;
  skipped: number;
  failed: string[];
}

export async function generateSynthetic(
  root: string,
  backend: LlmBackend,
  modelLabel: string,
  concurrency: number,
  force = false
): Promise<SyntheticStageReport> {
  const dirs = prDirs(root).filter((d) => force || !has(d, 'synthetic.md'));
  const skipped = prDirs(root).length - dirs.length;
  const failed: string[] = [];
  let written = 0;

  await mapLimit(dirs, concurrency, async (dir) => {
    const meta = readMeta(dir);
    const reader = new PrReader(dir, 'diff-only');
    const digest = diffDigest(reader.readDiff());

    const user = `DIFF:\n"""\n${digest}\n"""\n\nWrite the pull request description now.`;
    assertDerivedFromDiff(dir, user, 'stage3/synthetic-input');

    let text = '';
    try {
      text = (await backend.complete(SYNTHETIC_SYSTEM, user)).trim();
    } catch {
      failed.push(meta.id);
      return;
    }
    if (!text) {
      failed.push(meta.id);
      return;
    }

    // Strip an outer code fence if the model wrapped the whole description in one.
    const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*)\n```$/.exec(text);
    if (fenced) text = fenced[1].trim();

    writeText(dir, 'synthetic.md', `${text}\n`);
    writeJson(dir, 'synthetic.meta.json', { id: meta.id, model: modelLabel, chars: text.length });
    written++;
  });

  return { attempted: dirs.length, written, skipped, failed };
}
