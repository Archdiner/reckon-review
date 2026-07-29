/**
 * Human validation.
 *
 * The protocol is blunt about why this exists: without it, the study is one prompt grading
 * another prompt, that is the first criticism it will get, and it is a fair one. Fifty PRs
 * labelled by hand converts the study's weakest point into its most defensible one.
 *
 * The human labeller is kept under the SAME blinding as the model — same A/B assignment,
 * no provenance shown, no diff shown. If the human knew which text was the real record they
 * would score it differently, and the agreement rate would then be measuring the blinding
 * rather than the rubric.
 *
 * AGREEMENT IS REPORTED THREE WAYS, because raw agreement alone is misleading on a 3-point
 * scale where one class dominates. If 70% of scores are 0, two labellers who both guess 0
 * every time agree 70% of the time and have learned nothing. Quadratic weighted kappa
 * corrects for that chance agreement and is the number to lead with; exact and adjacent
 * agreement are reported alongside because they are what a reader intuits.
 *
 * Disagreements are dumped in full. The protocol asks for them to be reported openly,
 * including where and why, and a list of the cases where the model and the human diverged is
 * more informative about the rubric than any single coefficient.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { prDirs, readMeta, readJson, readText, has } from './io.js';
import { blindAssign } from './guard.js';
import type { PrScores } from './types.js';

export interface WorksheetRow {
  id: string;
  qIndex: number;
  question: string;
  textA: string;
  textB: string;
  /** Filled in by the human: 0, 1 or 2. Left null in the exported worksheet. */
  score_A: number | null;
  score_B: number | null;
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

export function exportWorksheet(root: string, outDir: string, n: number, seed: string): { prs: number; rows: number } {
  const dirs = prDirs(root).filter((d) => has(d, 'scores.json') && has(d, 'questions.json'));
  const rng = mulberry32(seedFrom(seed));
  const shuffled = [...dirs];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const picked = shuffled.slice(0, n);

  mkdirSync(outDir, { recursive: true });
  const rows: WorksheetRow[] = [];
  const md: string[] = [
    '# Hand-labelling worksheet',
    '',
    'Score each TEXT against the QUESTION. You are blind to which text is the real PR',
    'description and which was generated from the diff. Do not look at the code.',
    '',
    '  0 = ABSENT   — nothing in the text bears on the question',
    '  1 = PARTIAL  — gestures at it; a hint, but the mechanism cannot be reconstructed',
    '  2 = EXPLICIT — stated clearly enough to act on without reading the code',
    '',
    'Record your scores in `worksheet.jsonl` by filling `score_A` and `score_B`.',
    '',
    '---',
    '',
  ];

  for (const d of picked) {
    const meta = readMeta(d);
    const sc = readJson<PrScores>(d, 'scores.json');
    if (!sc) continue;
    const assign = blindAssign(meta.id, 'score-v1');
    const real = readText(d, 'record.md').trim();
    const synthetic = readText(d, 'synthetic.md').trim();
    const textA = assign.A === 'real' ? real : synthetic;
    const textB = assign.B === 'real' ? real : synthetic;

    sc.scores.forEach((s, qIndex) => {
      rows.push({ id: meta.id, qIndex, question: s.question, textA, textB, score_A: null, score_B: null });
    });

    md.push(`## ${meta.id}`, '');
    md.push('**TEXT A**', '', '```', textA || '(empty)', '```', '');
    md.push('**TEXT B**', '', '```', textB || '(empty)', '```', '');
    sc.scores.forEach((s, i) => md.push(`- Q${i}: ${s.question}    A = ___   B = ___`));
    md.push('', '---', '');
  }

  writeFileSync(join(outDir, 'worksheet.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  writeFileSync(join(outDir, 'worksheet.md'), md.join('\n'));
  return { prs: picked.length, rows: rows.length };
}

/** Quadratic weighted kappa for ordinal labels on {0,1,2}. */
export function quadraticWeightedKappa(a: number[], b: number[]): number {
  const K = 3;
  const n = a.length;
  if (n === 0) return NaN;
  const O = Array.from({ length: K }, () => new Array(K).fill(0));
  for (let i = 0; i < n; i++) O[a[i]][b[i]]++;
  const ha = new Array(K).fill(0);
  const hb = new Array(K).fill(0);
  for (let i = 0; i < n; i++) {
    ha[a[i]]++;
    hb[b[i]]++;
  }
  let num = 0;
  let den = 0;
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) {
      const w = ((i - j) ** 2) / ((K - 1) ** 2);
      num += w * O[i][j];
      den += w * ((ha[i] * hb[j]) / n);
    }
  }
  return den === 0 ? 1 : 1 - num / den;
}

export interface AgreementReport {
  pairs: number;
  exact: number;
  adjacent: number;
  kappa: number;
  modelMean: number;
  humanMean: number;
  disagreements: { id: string; qIndex: number; candidate: string; question: string; model: number; human: number }[];
}

export function compareLabels(root: string, worksheetPath: string): AgreementReport {
  if (!existsSync(worksheetPath)) throw new Error(`worksheet not found: ${worksheetPath}`);
  const rows: WorksheetRow[] = readFileSync(worksheetPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  const modelScores: number[] = [];
  const humanScores: number[] = [];
  const disagreements: AgreementReport['disagreements'] = [];

  for (const row of rows) {
    if (row.score_A === null && row.score_B === null) continue;
    const dir = join(root, row.id);
    const sc = readJson<PrScores>(dir, 'scores.json');
    if (!sc || !sc.scores[row.qIndex]) continue;
    const s = sc.scores[row.qIndex];
    const assign = blindAssign(row.id, 'score-v1');

    for (const label of ['A', 'B'] as const) {
      const human = label === 'A' ? row.score_A : row.score_B;
      if (human === null || human === undefined) continue;
      const which = assign[label];
      const model = which === 'real' ? s.real : s.synthetic;
      modelScores.push(model);
      humanScores.push(human);
      if (model !== human) {
        disagreements.push({ id: row.id, qIndex: row.qIndex, candidate: which, question: s.question, model, human });
      }
    }
  }

  const n = modelScores.length;
  const exact = n ? (modelScores.filter((v, i) => v === humanScores[i]).length / n) * 100 : NaN;
  const adjacent = n ? (modelScores.filter((v, i) => Math.abs(v - humanScores[i]) <= 1).length / n) * 100 : NaN;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : NaN);

  return {
    pairs: n,
    exact,
    adjacent,
    kappa: quadraticWeightedKappa(modelScores, humanScores),
    modelMean: mean(modelScores),
    humanMean: mean(humanScores),
    disagreements,
  };
}
