/**
 * Stage 3b — the FORM CONTROL. Rewrite the real record in the model's own voice, adding
 * nothing.
 *
 * WHY THIS ARM EXISTS, AND WHY THE STUDY IS NOT PUBLISHABLE WITHOUT IT.
 *
 * Stage 2 generates the questions from the diff. Stage 3 generates the synthetic description
 * from the same diff, with the same model, by the same reasoning. So the question and the
 * synthetic answer share a decomposition of the change and a vocabulary for it: they carve the
 * PR at the same joints and name the joints the same way. The human record was never carved
 * that way — it was written by someone solving a different problem, for a different reader,
 * before the questions existed.
 *
 * A scorer asked "does this text answer this question" is therefore not measuring only whether
 * the information is present. It is partly measuring whether the text is ALIGNED with the
 * question's framing. Common-source alignment would inflate the synthetic arm on every cut —
 * including independent scoring, which removes the A/B contrast but leaves both texts still
 * derived from the same source as the question.
 *
 * None of the other controls touch this. Emptiness, verbosity, degeneracy and contrast are all
 * properties of the record or the presentation; this is a property of the GENERATIVE
 * RELATIONSHIP between the question and one of the candidates.
 *
 * THE CONTROL. Take the real record and have the model restructure it into its own voice —
 * same information, model form. That arm has the synthetic's FORM and the record's CONTENT.
 *
 *   paraphrase jumps toward synthetic  -> the gap is form. The result is "model-written text
 *                                         is legible to model-written questions", which is a
 *                                         finding about the instrument, not about records.
 *   paraphrase stays near real         -> the information genuinely is not in the record, and
 *                                         the headline survives on much stronger footing.
 *
 * THE PROMPT IS THE WHOLE EXPERIMENT. It must move form as far as possible while moving
 * information not at all, so the instruction pushes hard on restructuring and harder on the
 * prohibition. A paraphrase that quietly explains the change would destroy the control by
 * making the arm a second synthetic — and it would do so in the direction that manufactures
 * the reassuring answer, which is the failure mode to guard against.
 *
 * ACCESS. This stage reads record.md and NOTHING else. It holds a `record-only` reader, so an
 * attempt to touch diff.patch throws. That matters: a paraphraser that could see the code
 * could supply mechanism from it, which is exactly what it must not do.
 */

import type { LlmBackend } from '@reckon/core';
import { PrReader, assertNoRawDiff } from './guard.js';
import { prDirs, readMeta, writeText, writeJson, has, mapLimit } from './io.js';

export const PARAPHRASE_SYSTEM = [
  'You rewrite pull request descriptions. You are a REFORMATTER, not an author.',
  '',
  'You will be given the full text of a pull request record: its title and, if the author',
  'wrote one, its body. Rewrite it in your own voice, using the structure and formatting you',
  'would naturally use for a pull request description — headings, bullets, a summary line —',
  'where the material supports it.',
  '',
  'THE ABSOLUTE CONSTRAINT, which overrides every other instruction:',
  '',
  'ADD NO INFORMATION THAT IS NOT IN THE SOURCE TEXT.',
  '',
  '- Do NOT explain how the change works, why it was made, what it fixes, what it improves,',
  '  what it replaces, or what would break without it, unless the source text says so.',
  '- Do NOT infer mechanism, motivation, rationale, trade-offs, or consequences.',
  '- Do NOT add detail from your own knowledge of the libraries, files or identifiers named.',
  '- Do NOT invent issue numbers, links, names, versions, or test results.',
  '- Do NOT pad. If the source says little, your rewrite says little. A one-line source',
  '  becomes at most a one-line rewrite. Never manufacture sections to fill a template.',
  '',
  'You may reorder, regroup, retitle, reformat, split run-on sentences, convert prose to',
  'bullets or bullets to prose, and fix grammar. That is the entire permitted scope.',
  '',
  'A good rewrite contains exactly the facts of the source, in your words and your structure.',
  'If you find yourself writing a sentence whose content is not traceable to the source, delete it.',
  '',
  'Output ONLY the rewritten description in Markdown. No preamble, no commentary.',
].join('\n');

export interface ParaphraseStageReport {
  attempted: number;
  written: number;
  skipped: number;
  failed: string[];
}

export async function generateParaphrase(
  root: string,
  backend: LlmBackend,
  modelLabel: string,
  concurrency: number,
  force = false
): Promise<ParaphraseStageReport> {
  const dirs = prDirs(root).filter((d) => force || !has(d, 'paraphrase.md'));
  const skipped = prDirs(root).length - dirs.length;
  const failed: string[] = [];
  let written = 0;

  await mapLimit(dirs, concurrency, async (dir) => {
    const meta = readMeta(dir);
    // record-only: reaching for diff.patch from here throws. The paraphraser must not be
    // able to supply mechanism it read out of the code.
    const reader = new PrReader(dir, 'record-only');
    const record = reader.readRecord().trim();

    const user = `PULL REQUEST RECORD:\n"""\n${record || '(empty)'}\n"""\n\nRewrite it now, adding nothing.`;
    // Cheap belt-and-braces: the record should never contain a raw patch, and if one ever
    // did the paraphrase would become a second diff-derived arm without anyone noticing.
    assertNoRawDiff(user, 'stage3b/paraphrase-input');

    let text = '';
    try {
      text = (await backend.complete(PARAPHRASE_SYSTEM, user)).trim();
    } catch {
      failed.push(meta.id);
      return;
    }
    if (!text) {
      failed.push(meta.id);
      return;
    }

    const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*)\n```$/.exec(text);
    if (fenced) text = fenced[1].trim();

    writeText(dir, 'paraphrase.md', `${text}\n`);
    writeJson(dir, 'paraphrase.meta.json', {
      id: meta.id,
      model: modelLabel,
      sourceChars: record.length,
      chars: text.length,
    });
    written++;
  });

  return { attempted: dirs.length, written, skipped, failed };
}
