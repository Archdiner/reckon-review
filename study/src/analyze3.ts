/**
 * Three-arm analysis: real record, synthetic description, paraphrased record.
 *
 * WHAT THIS EXISTS TO DECIDE.
 *
 * The two-arm result (real vs synthetic) has a confound that no amount of care on the record
 * side can remove: the question and the synthetic answer come from the same model reading the
 * same diff, so they share a decomposition of the change and a vocabulary for it. The human
 * record does not. A scorer judging "does this text answer this question" is therefore partly
 * measuring alignment of form, not presence of information.
 *
 * The paraphrase arm separates the two. It carries the record's CONTENT in the model's FORM:
 *
 *   paraphrase ~ synthetic  ->  the gap is FORM. What the study measured is that model-shaped
 *                               text is legible to model-shaped questions. The record result
 *                               is much weaker than it looks and must not be led with.
 *   paraphrase ~ real       ->  the gap is CONTENT. Restating the record in the model's own
 *                               voice buys nothing, because the information was never there.
 *                               The finding survives on far stronger footing.
 *
 * The interesting quantity is therefore not any single mean but the position of paraphrase
 * BETWEEN the other two arms, reported as the share of the real-to-synthetic distance that
 * mere reformatting recovers. That number is the confound, measured.
 *
 * UNCERTAINTY is cluster bootstrap over PRs, as everywhere else in this study: each PR
 * contributes 2-4 questions scored against the same three texts, and treating those as
 * independent would shrink every interval by roughly the square root of the cluster size.
 *
 * ALL COMPARISONS ARE PAIRED BY CONSTRUCTION — same PR, same questions, three texts — so the
 * bootstrap resamples PRs and recomputes the mean of the per-PR difference.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prDirs, readMeta, readJson, has } from './io.js';
import { classifyRecord, type RecordTier } from './triviality.js';
import type { ThreeArmScores } from './stage4b_score3.js';
import type { PrMeta } from './types.js';

const BOOTSTRAP_ITERS = 5000;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function bootstrapCI(xs: number[], iters = BOOTSTRAP_ITERS, seed = 12345): [number, number] {
  if (xs.length < 2) return [NaN, NaN];
  const rng = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    for (let j = 0; j < xs.length; j++) sum += xs[Math.floor(rng() * xs.length)];
    means.push(sum / xs.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(iters * 0.025)], means[Math.floor(iters * 0.975)]];
}

export interface ThreeArmRow {
  id: string;
  repo: string;
  provenance: string;
  evidence: string;
  tier: RecordTier;
  nQuestions: number;
  real: number;
  synthetic: number;
  paraphrase: number;
  realPct2: number;
  syntheticPct2: number;
  paraphrasePct2: number;
  recordChars: number;
  paraphraseChars: number;
  syntheticChars: number;
  /** Raw per-question scores, kept so the report can show the DISTRIBUTION rather than
   *  collapsing to a mean. See `distribution` for why that matters. */
  rawReal: number[];
  rawSynthetic: number[];
  rawParaphrase: number[];
}

export function loadThreeArm(root: string): ThreeArmRow[] {
  const rows: ThreeArmRow[] = [];
  for (const d of prDirs(root)) {
    if (!has(d, 'scores3.json')) continue;
    const sc = readJson<ThreeArmScores>(d, 'scores3.json');
    if (!sc || sc.scores.length === 0) continue;
    const meta: PrMeta = readMeta(d);
    const record = readFileSync(join(d, 'record.md'), 'utf8');
    const paraphrase = has(d, 'paraphrase.md') ? readFileSync(join(d, 'paraphrase.md'), 'utf8') : '';
    const synthetic = has(d, 'synthetic.md') ? readFileSync(join(d, 'synthetic.md'), 'utf8') : '';
    const pct2 = (xs: number[]) => (xs.filter((v) => v === 2).length / xs.length) * 100;
    const r = sc.scores.map((s) => s.real);
    const s2 = sc.scores.map((s) => s.synthetic);
    const p = sc.scores.map((s) => s.paraphrase);
    rows.push({
      id: meta.id,
      repo: meta.repo,
      provenance: meta.provenance,
      evidence: meta.evidence,
      tier: classifyRecord(record).tier,
      nQuestions: sc.scores.length,
      real: mean(r),
      synthetic: mean(s2),
      paraphrase: mean(p),
      realPct2: pct2(r),
      syntheticPct2: pct2(s2),
      paraphrasePct2: pct2(p),
      recordChars: record.trim().length,
      paraphraseChars: paraphrase.trim().length,
      syntheticChars: synthetic.trim().length,
      rawReal: r,
      rawSynthetic: s2,
      rawParaphrase: p,
    });
  }
  return rows;
}

const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a');
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : 'n/a');

/**
 * Share of the real-to-synthetic distance recovered by reformatting alone.
 *
 * 0% means restating the record in model voice bought nothing and the whole gap is content.
 * 100% means reformatting alone closed the gap and the whole gap is form. Undefined when the
 * two reference arms are not meaningfully apart, which is reported rather than papered over.
 */
function formShare(rows: ThreeArmRow[]): { share: number; ci: [number, number] } | null {
  const denom = mean(rows.map((r) => r.synthetic - r.real));
  if (!Number.isFinite(denom) || Math.abs(denom) < 0.05) return null;
  const perPr = rows.map((r) => (r.paraphrase - r.real) / denom);
  return { share: mean(perPr) * 100, ci: [bootstrapCI(perPr)[0] * 100, bootstrapCI(perPr)[1] * 100] };
}

/**
 * Share of questions scoring 0, 1 and 2.
 *
 * THE DISTRIBUTION IS THE RESULT; THE MEAN IS A SUMMARY THAT MISLEADS HERE.
 *
 * The real-record scores are bimodal, heavily so on the human arm: 58.7% of questions score 0
 * and 8.6% score 2. A mean of 0.49 sits in the trough between those masses and describes
 * almost no actual PR. Worse, it makes two completely different situations look like one
 * number — "the record says nothing" and "the record says something partial" average to the
 * same place as "half the records are good and half are missing".
 *
 * Reporting 0/1/2 shares separates the study's two findings visually. Absence shows up as mass
 * at 0. Reproducibility shows up as the real and synthetic columns having the SAME shape.
 */
function distribution(xs: number[]): string {
  const t = xs.length;
  if (t === 0) return 'n/a | n/a | n/a';
  const c = [0, 0, 0];
  for (const v of xs) c[v]++;
  return c.map((n) => `${((n / t) * 100).toFixed(1)}%`).join(' | ');
}

function armBlock(label: string, rows: ThreeArmRow[]): string[] {
  const L: string[] = [];
  if (rows.length === 0) return [`### ${label}`, '', '_no PRs in this cut_', ''];
  const gapSyn = rows.map((r) => r.real - r.synthetic);
  const gapPar = rows.map((r) => r.real - r.paraphrase);
  const [sl, sh] = bootstrapCI(gapSyn);
  const [pl, ph] = bootstrapCI(gapPar);
  const flat = (k: 'rawReal' | 'rawSynthetic' | 'rawParaphrase') => rows.flatMap((r) => r[k]);
  L.push(`### ${label}  (n=${rows.length} PRs, ${rows.reduce((a, r) => a + r.nQuestions, 0)} questions)`);
  L.push('');
  L.push('Share of questions at each score. The distribution is the result; the mean is a');
  L.push('summary that misleads when the scores are bimodal, which on the real arm they are.');
  L.push('');
  L.push('| arm | 0 absent | 1 partial | 2 explicit | mean |');
  L.push('| --- | --- | --- | --- | --- |');
  L.push(`| real record | ${distribution(flat('rawReal'))} | ${f2(mean(rows.map((r) => r.real)))} |`);
  L.push(`| paraphrased record (form control) | ${distribution(flat('rawParaphrase'))} | ${f2(mean(rows.map((r) => r.paraphrase)))} |`);
  L.push(`| synthetic (from diff) | ${distribution(flat('rawSynthetic'))} | ${f2(mean(rows.map((r) => r.synthetic)))} |`);
  L.push('');
  L.push(`real - synthetic: **${f2(mean(gapSyn))}**  95% CI [${f2(sl)}, ${f2(sh)}]`);
  L.push(`real - paraphrase: **${f2(mean(gapPar))}**  95% CI [${f2(pl)}, ${f2(ph)}]`);
  const fs = formShare(rows);
  if (fs) {
    L.push('');
    L.push(`**Form share: ${f1(fs.share)}%** 95% CI [${f1(fs.ci[0])}, ${f1(fs.ci[1])}] — the portion of the`);
    L.push('real-to-synthetic distance recovered by reformatting the record alone, adding no information.');
    L.push('High means the measured gap is largely about the shape of the text rather than its content.');
  } else {
    L.push('');
    L.push('_Form share undefined: the real and synthetic arms are not far enough apart in this cut._');
  }
  L.push('');
  return L;
}

export function formatThreeArmReport(rows: ThreeArmRow[]): string {
  const L: string[] = [];
  L.push('# Three-arm analysis — is the gap content, or form?');
  L.push('');
  L.push('All three arms scored INDEPENDENTLY: each text alone in its own call, same rubric,');
  L.push('same question, no A/B contrast and no ordering. The arms are therefore judged');
  L.push('identically, which is what makes them comparable.');
  L.push('');
  L.push('The paraphrase arm is the real record restated in the model\'s own voice with no');
  L.push('information added. It has the synthetic\'s form and the record\'s content, so it');
  L.push('isolates the confound that the question and the synthetic description were produced');
  L.push('by the same model from the same diff by the same reasoning.');
  L.push('');
  L.push('## The two findings this corpus supports');
  L.push('');
  L.push('They are separate claims with separate evidence, and they end in the same place.');
  L.push('');
  L.push('**1. Absence.** Where humans write the record unaided, often there is no record. Look');
  L.push('for this as mass at score 0 on the real arm of the human cut.');
  L.push('');
  L.push('**2. Reproducibility.** Where the record IS full, a model reproduces it from the diff');
  L.push('alone. Look for this as the real and synthetic arms having the same SHAPE in the agent');
  L.push('cut — not as a mean difference near zero, which could arise many ways.');
  L.push('');
  L.push('Neither claim needs anyone to have written badly. Together they say the written record');
  L.push('is not evidence that a human understood the change: where it is absent there is nothing');
  L.push('to read, and where it is present it is recoverable from the artifact.');
  L.push('');
  L.push('The agent cut is the stronger of the two, and its selection story is the explanation');
  L.push('rather than a nuisance to be waved off. A `Co-authored-by` trailer marks a PR from a');
  L.push('team that uses agents, and those records were plausibly model-drafted from the diff in');
  L.push('the first place. That is precisely why they are reproducible: the cut where records are');
  L.push('fullest is the cut where they are most recoverable. State it before a reader finds it.');
  L.push('');
  L.push(...armBlock('Agent-attested — the REPRODUCIBILITY finding', rows.filter((r) => r.provenance === 'agent')));
  L.push(...armBlock('Human-authored — the ABSENCE finding', rows.filter((r) => r.provenance === 'human')));
  L.push(...armBlock('All PRs', rows));
  L.push(...armBlock('Substantive records only (author wrote something beyond the title)', rows.filter((r) => r.tier === 'substantive')));
  L.push(...armBlock('Trivial records (body restates the title or is process chatter)', rows.filter((r) => r.tier === 'trivial')));
  L.push(...armBlock('Empty records (title alone)', rows.filter((r) => r.tier === 'empty')));
  L.push(...armBlock('Agent-attested, substantive records only', rows.filter((r) => r.provenance === 'agent' && r.tier === 'substantive')));

  L.push('## Text length by arm');
  L.push('');
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
  L.push('| arm | median chars |');
  L.push('| --- | --- |');
  L.push(`| real record | ${med(rows.map((r) => r.recordChars))} |`);
  L.push(`| paraphrased record | ${med(rows.map((r) => r.paraphraseChars))} |`);
  L.push(`| synthetic | ${med(rows.map((r) => r.syntheticChars))} |`);
  L.push('');
  L.push('The paraphrase should track the record in length. If it has drifted toward the');
  L.push('synthetic it stopped being a form control and started adding information, which');
  L.push('would make it a second synthetic arm and void the comparison.');
  L.push('');
  return L.join('\n');
}

export function writeThreeArmCsv(rows: ThreeArmRow[]): string {
  const cols: (keyof ThreeArmRow)[] = [
    'id', 'repo', 'provenance', 'evidence', 'tier', 'nQuestions',
    'real', 'paraphrase', 'synthetic', 'realPct2', 'paraphrasePct2', 'syntheticPct2',
    'recordChars', 'paraphraseChars', 'syntheticChars',
  ];
  const esc = (v: unknown) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(cols.map((c) => {
      const v = r[c];
      return esc(typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(4) : v);
    }).join(','));
  }
  return `${lines.join('\n')}\n`;
}
