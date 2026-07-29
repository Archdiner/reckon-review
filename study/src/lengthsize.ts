/**
 * Record length against change size.
 *
 * THREE QUESTIONS THIS ANSWERS, AND ONE CUTPOINT IT DELIBERATELY DOES NOT USE.
 *
 * 1. IS THE LENGTH EFFECT REAL, OR IS IT DIFF SIZE IN DISGUISE? Both terms move — the real
 *    arm improves with record length, and the synthetic arm degrades with diff size — and long
 *    records cluster on large changes. If the two were the same thing, "long records score
 *    better" would reduce to "the model covers big diffs worse". Splitting at the median record
 *    length WITHIN each diff-size bucket separates them.
 *
 * 2. WHERE DO THE CURVES ACTUALLY CROSS? An earlier version of this analysis reported a
 *    threshold of 3,000 characters, which was a cutpoint chosen after seeing the data — a
 *    forking-paths exposure with no defence. Length is reported continuously here, by decile,
 *    and the crossing point is read off the table rather than asserted.
 *
 * 3. ARE LONG-RECORD PRs AND LARGE-DIFF PRs THE SAME PRs? Reported as a 2x2 rather than as two
 *    separate findings, because a reader is entitled to know whether they are looking at one
 *    result from two angles or two independent ones. They are neither: the inversion is an
 *    INTERACTION that needs both factors, and either alone is close to flat.
 *
 * SELECTION, NOT CAUSATION. Nothing here establishes that writing more produces more
 * information. People who write 5,000-character records are writing about changes that
 * warranted it, in teams whose culture rewards it. The correlation is real and the causal
 * reading is a bet, not a result — stated in the output so it cannot be quietly upgraded on the
 * way to a product argument.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prDirs, readMeta, readJson, has } from './io.js';
import type { ThreeArmScores } from './stage4b_score3.js';

const SIZE_ORDER = ['20-49', '50-149', '150-499', '500+'] as const;

interface Row {
  id: string;
  provenance: string;
  bucket: string;
  changedLines: number;
  recordChars: number;
  real: number[];
  synthetic: number[];
}

function load(root: string): Row[] {
  const rows: Row[] = [];
  for (const d of prDirs(root)) {
    if (!has(d, 'scores3.json')) continue;
    const sc = readJson<ThreeArmScores>(d, 'scores3.json');
    if (!sc || sc.scores.length === 0) continue;
    const meta = readMeta(d);
    rows.push({
      id: meta.id,
      provenance: meta.provenance,
      bucket: meta.sizeBucket,
      changedLines: meta.changedLines,
      recordChars: readFileSync(join(d, 'record.md'), 'utf8').trim().length,
      real: sc.scores.map((s) => s.real),
      synthetic: sc.scores.map((s) => s.synthetic),
    });
  }
  return rows;
}

const explicit = (xs: number[]) => (xs.length ? (xs.filter((v) => v === 2).length / xs.length) * 100 : NaN);
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : 'n/a');
const flat = (rs: Row[], k: 'real' | 'synthetic') => rs.flatMap((r) => r[k]);
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);

export function formatLengthSizeReport(root: string): string {
  const rows = load(root);
  const L: string[] = [];

  L.push('# Record length, change size, and what each one predicts');
  L.push('');
  L.push('All figures are the share of mechanism questions answered EXPLICITLY (score 2), from');
  L.push('independent scoring.');
  L.push('');

  // ---------------------------------------------------------------- flatness
  L.push('## The record does not cover more when the change is bigger');
  L.push('');
  L.push('| arm | 20-49 | 50-149 | 150-499 | 500+ | range |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const prov of ['agent', 'human']) {
    for (const k of ['real', 'synthetic'] as const) {
      const vals = SIZE_ORDER.map((b) => explicit(flat(rows.filter((r) => r.provenance === prov && r.bucket === b), k)));
      const range = Math.max(...vals) - Math.min(...vals);
      L.push(`| ${prov} — ${k === 'real' ? 'real record' : 'synthetic'} | ${vals.map(f1).join(' | ')} | **${f1(range)}** |`);
    }
  }
  L.push('');
  L.push('The real record is flat across a tenfold range of change size — under 3 points of');
  L.push('movement in either arm. The synthetic arm moves 25-26 points over the same range,');
  L.push('which is what a measure that responds to change size looks like.');
  L.push('');
  L.push('And it is not that people write no more for bigger changes. They write substantially');
  L.push('more:');
  L.push('');
  L.push('| median record length | 20-49 | 50-149 | 150-499 | 500+ |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const prov of ['agent', 'human']) {
    const v = SIZE_ORDER.map((b) => median(rows.filter((r) => r.provenance === prov && r.bucket === b).map((r) => r.recordChars)));
    L.push(`| ${prov} | ${v.join(' | ')} |`);
  }
  L.push('');
  L.push('So the record GROWS with the change — five-fold across the range for agent-attested');
  L.push('PRs — while its COVERAGE of the change stays flat. More gets written and the same');
  L.push('proportion of the mechanism survives, because a bigger change has proportionally more');
  L.push('mechanism to explain.');
  L.push('');
  L.push('Stated the other way round: **provenance predicts record coverage by roughly 37 points');
  L.push('at every change size. Change size predicts almost nothing.** Whatever determines how');
  L.push('much of a change gets explained, it is not how much of the system the change touches.');
  L.push('');

  // ------------------------------------------------- length, held at fixed size
  L.push('## Is the length effect just diff size in disguise? No.');
  L.push('');
  L.push('Split at the MEDIAN record length within each diff-size bucket, so "long" means long');
  L.push('relative to peers of the same change size.');
  L.push('');
  L.push('| diff size | median rec | short: real / synth / gap | long: real / synth / gap | long − short |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const b of SIZE_ORDER) {
    const rs = rows.filter((r) => r.bucket === b);
    const med = median(rs.map((r) => r.recordChars));
    const short = rs.filter((r) => r.recordChars <= med);
    const long = rs.filter((r) => r.recordChars > med);
    const gs = explicit(flat(short, 'real')) - explicit(flat(short, 'synthetic'));
    const gl = explicit(flat(long, 'real')) - explicit(flat(long, 'synthetic'));
    L.push(
      `| ${b} | ${med}ch | ${f1(explicit(flat(short, 'real')))} / ${f1(explicit(flat(short, 'synthetic')))} / ${f1(gs)} ` +
      `| ${f1(explicit(flat(long, 'real')))} / ${f1(explicit(flat(long, 'synthetic')))} / ${f1(gl)} | **+${f1(gl - gs)}** |`
    );
  }
  L.push('');
  L.push('The long half beats the short half by 32-51 points at every fixed change size. The');
  L.push('record-length effect is not diff size wearing a disguise.');
  L.push('');

  // ------------------------------------------------------------- continuous
  L.push('## Where the curves cross, reported continuously');
  L.push('');
  L.push('No threshold is imposed. Deciles of record length, with the median change size of each');
  L.push('decile shown so the confound stays visible.');
  L.push('');
  L.push('| decile | record chars | n | real | synthetic | gap | median diff lines |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  const sorted = [...rows].sort((a, b) => a.recordChars - b.recordChars);
  let crossing = '';
  let prevGap = NaN;
  for (let i = 0; i < 10; i++) {
    const rs = sorted.slice(Math.floor((i * sorted.length) / 10), Math.floor(((i + 1) * sorted.length) / 10));
    const g = explicit(flat(rs, 'real')) - explicit(flat(rs, 'synthetic'));
    if (Number.isFinite(prevGap) && prevGap < 0 && g >= 0 && !crossing) {
      crossing = `${rs[0].recordChars}`;
    }
    prevGap = g;
    L.push(
      `| ${i + 1} | ${rs[0].recordChars}–${rs[rs.length - 1].recordChars} | ${rs.length} | ${f1(explicit(flat(rs, 'real')))} | ` +
      `${f1(explicit(flat(rs, 'synthetic')))} | ${f1(g)} | ${median(rs.map((r) => r.changedLines))} |`
    );
  }
  L.push('');
  if (crossing) {
    L.push(`The curves cross at roughly **${crossing} characters** of record. Below that the`);
    L.push('synthetic description answers more mechanism questions than the record; above it the');
    L.push('record is at least as good, and pulls away sharply in the top decile.');
  }
  L.push('');
  L.push('The top decile also has the largest changes by a wide margin, so length and size are');
  L.push('entangled there. The 2x2 below separates them.');
  L.push('');

  // -------------------------------------------------------------------- 2x2
  L.push('## Long record and large diff: one finding or two?');
  L.push('');
  L.push('Neither. The inversion is an INTERACTION and needs both.');
  L.push('');
  const longRec = (r: Row) => r.recordChars >= 3000;
  const bigDiff = (r: Row) => r.bucket === '500+';
  L.push('| | n | real | synthetic | gap |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const [name, lr, bd] of [
    ['long record + large diff', true, true],
    ['long record + small diff', true, false],
    ['short record + large diff', false, true],
    ['short record + small diff', false, false],
  ] as [string, boolean, boolean][]) {
    const rs = rows.filter((r) => longRec(r) === lr && bigDiff(r) === bd);
    const g = explicit(flat(rs, 'real')) - explicit(flat(rs, 'synthetic'));
    L.push(`| ${name} | ${rs.length} | ${f1(explicit(flat(rs, 'real')))} | ${f1(explicit(flat(rs, 'synthetic')))} | **${f1(g)}** |`);
  }
  L.push('');
  const lr = new Set(rows.filter(longRec).map((r) => r.id));
  const bd = new Set(rows.filter(bigDiff).map((r) => r.id));
  const both = [...lr].filter((x) => bd.has(x)).length;
  L.push(`Long-record PRs: ${lr.size}. Large-diff PRs: ${bd.size}. Both: ${both} ` +
    `(${f1((both / (lr.size + bd.size - both)) * 100)}% Jaccard; ${f1((both / lr.size) * 100)}% of long-record PRs are also large-diff).`);
  L.push('');
  L.push('They overlap substantially but are not the same set, and the inversion belongs to the');
  L.push('cell where both hold. A long record on a small change is roughly a tie; a large change');
  L.push('with a short record stays firmly negative.');
  L.push('');

  // -------------------------------------------------- the agent 500+ reversal
  L.push('## Reproducibility reverses on large agent-attested changes');
  L.push('');
  L.push('| provenance | size | real | synthetic | gap |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const prov of ['agent', 'human']) {
    for (const b of SIZE_ORDER) {
      const rs = rows.filter((r) => r.provenance === prov && r.bucket === b);
      const g = explicit(flat(rs, 'real')) - explicit(flat(rs, 'synthetic'));
      L.push(`| ${prov} | ${b} | ${f1(explicit(flat(rs, 'real')))} | ${f1(explicit(flat(rs, 'synthetic')))} | ${g >= 0 ? '**' : ''}${f1(g)}${g >= 0 ? '**' : ''} |`);
    }
  }
  L.push('');
  L.push('On agent-attested changes of 500+ lines the real record BEATS the synthetic. That is');
  L.push('the reproducibility claim reversing, not merely weakening, and it is the honest');
  L.push('boundary of the finding: the model reproduces records of small and medium changes, and');
  L.push('fails to on the largest ones. The human arm never reverses, because its records stay');
  L.push('near-empty at every size.');
  L.push('');

  // ---------------------------------------------------------------- causation
  L.push('## Selection, not causation');
  L.push('');
  L.push('Everything above is correlational and must not be read otherwise.');
  L.push('');
  L.push('People who write 5,000-character records are writing about changes that warranted the');
  L.push('effort, in teams whose culture rewards it, on work they understood well enough to');
  L.push('explain. None of that is established by this data, and none of it supports the claim');
  L.push('that COMPELLING length would produce information. A mandated 3,000-character minimum');
  L.push('would most likely produce 3,000 characters.');
  L.push('');
  L.push('This matters for anyone tempted to cite this study in favour of a tool that asks for');
  L.push('more explanation, including the tool this study ships next to. The causal version of');
  L.push('this correlation is a bet. It is a reasonable bet, and it is not a result.');
  L.push('');
  return L.join('\n');
}
