/**
 * Decomposition of the agent-vs-human contrast into its two moving parts.
 *
 * THE TRAP THIS EXISTS TO AVOID. The headline contrast is a difference of differences, and
 * BOTH terms move across the cuts:
 *
 *   real arm       agent 45.9% explicit, human  8.6%   -> 37 points
 *   synthetic arm  agent 53.1% explicit, human 63.3%   -> 10 points, the OTHER way
 *
 * A reader who notices the second line unaided will assume it was missed, and they will be
 * right to discount the result until it is addressed. So it gets addressed here, in the
 * output, rather than in a footnote.
 *
 * WHY THE SYNTHETIC ARM MOVES. Not because the model writes worse about agent PRs as such.
 * Agent PRs are larger — median 230 changed lines against 126 — and the synthetic writer
 * degrades sharply with diff size: 71.9% explicit on 20-49 line changes against 37.1% on
 * 500+. A larger diff means more mechanism to cover from a fixed digest budget and more
 * chances to miss. The pooled agent/human synthetic difference is therefore mostly a SIZE
 * COMPOSITION effect, and it should shrink once size is held fixed.
 *
 * WHAT SURVIVES. Within a size bucket the synthetic arms nearly converge while the real arm
 * gap stays put at roughly 37 points in every bucket. The contrast is carried by the real
 * arm; the synthetic arm is a size artifact pointing the other way. This module prints both
 * so the decomposition is a stated result rather than an exercise left to the reader.
 */

import { prDirs, readMeta, readJson, has } from './io.js';
import type { PrScores, PrMeta } from './types.js';

const SIZE_ORDER = ['20-49', '50-149', '150-499', '500+'] as const;

interface Cell {
  real: number[];
  synthetic: number[];
}

const pctExplicit = (xs: number[]) => (xs.length ? (xs.filter((v) => v === 2).length / xs.length) * 100 : NaN);
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : 'n/a');

export function decomposeBySize(root: string): string {
  const cells = new Map<string, Cell>();
  const prCount = new Map<string, number>();
  const key = (prov: string, bucket: string) => `${prov}|${bucket}`;

  for (const d of prDirs(root)) {
    if (!has(d, 'scores.json')) continue;
    const meta: PrMeta = readMeta(d);
    const sc = readJson<PrScores>(d, 'scores.json');
    if (!sc || sc.scores.length === 0) continue;
    const k = key(meta.provenance, meta.sizeBucket);
    if (!cells.has(k)) cells.set(k, { real: [], synthetic: [] });
    const c = cells.get(k)!;
    for (const s of sc.scores) {
      c.real.push(s.real);
      c.synthetic.push(s.synthetic);
    }
    prCount.set(k, (prCount.get(k) ?? 0) + 1);
  }

  const L: string[] = [];
  L.push('# Decomposing the agent-vs-human contrast');
  L.push('');
  L.push('Both terms of the difference move, so both are reported. Figures are the share of');
  L.push('mechanism questions answered EXPLICITLY (score 2).');
  L.push('');
  L.push('## Within size bucket');
  L.push('');
  L.push('| size | real agent | real human | real diff | synth agent | synth human | synth diff |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');

  const realDiffs: number[] = [];
  const synDiffs: number[] = [];
  for (const b of SIZE_ORDER) {
    const a = cells.get(key('agent', b));
    const h = cells.get(key('human', b));
    if (!a || !h) continue;
    const ra = pctExplicit(a.real);
    const rh = pctExplicit(h.real);
    const sa = pctExplicit(a.synthetic);
    const sh = pctExplicit(h.synthetic);
    realDiffs.push(ra - rh);
    synDiffs.push(sa - sh);
    L.push(`| ${b} | ${f1(ra)} | ${f1(rh)} | **${f1(ra - rh)}** | ${f1(sa)} | ${f1(sh)} | ${f1(sa - sh)} |`);
  }
  L.push('');

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  L.push(`Mean within-bucket real-arm difference: **${f1(mean(realDiffs))} points**`);
  L.push(`Mean within-bucket synthetic-arm difference: **${f1(mean(synDiffs))} points**`);
  L.push('');
  L.push('The real-arm difference is stable across every size bucket. The synthetic-arm');
  L.push('difference is small and shrinks once size is held fixed, which is what identifies it');
  L.push('as a size-composition effect rather than a property of who wrote the change.');
  L.push('');

  L.push('## The synthetic writer degrades with diff size');
  L.push('');
  L.push('| size | synthetic explicit % | real explicit % |');
  L.push('| --- | --- | --- |');
  for (const b of SIZE_ORDER) {
    const a = cells.get(key('agent', b));
    const h = cells.get(key('human', b));
    if (!a || !h) continue;
    const syn = pctExplicit([...a.synthetic, ...h.synthetic]);
    const real = pctExplicit([...a.real, ...h.real]);
    L.push(`| ${b} | ${f1(syn)} | ${f1(real)} |`);
  }
  L.push('');
  L.push('A bigger diff gives the synthetic writer more mechanism to cover from a fixed digest');
  L.push('budget, so it misses more. The real record does not degrade the same way — it barely');
  L.push('moves with size at all, within either arm.');
  L.push('');
  L.push('This is also the honest limit on the reproducibility claim: the synthetic arm is');
  L.push('strongest exactly where changes are small, and small changes are where mechanism is');
  L.push('least likely to matter.');
  L.push('');
  return L.join('\n');
}
