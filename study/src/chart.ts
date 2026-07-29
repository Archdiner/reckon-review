/**
 * The chart.
 *
 * Four bars, three segments each, and it carries the whole result. Everything else in the
 * study is supporting text for this picture:
 *
 *   agent  real   ▓ 0 ░ 1 █ 2      shape resembles the synthetic bar below it -> REPRODUCIBILITY
 *   agent  synth
 *   human  real                    a wall of 0 -> ABSENCE
 *   human  synth
 *
 * WHY A STACKED BAR AND NOT A MEAN. The real-record scores are bimodal, heavily so on the
 * human arm, where 68.9% of questions score 0 and 12.4% score 2. A mean of 0.43 falls in the
 * trough between those masses and describes almost no actual PR. A bar chart of the three
 * shares cannot hide that, and it makes the study's two findings visually separable in a way
 * no summary statistic does: absence is mass at 0, reproducibility is two bars with the same
 * profile.
 *
 * SVG rather than a plotting library: it renders inline on GitHub, needs no dependency, and
 * diffs as text.
 */

import { prDirs, readMeta, readJson, has } from './io.js';
import type { ThreeArmScores } from './stage4b_score3.js';

interface Bar {
  label: string;
  sub: string;
  shares: [number, number, number];
  n: number;
}

const COLORS = {
  absent: '#c2410c', //   0 — nothing in the text bears on the question
  partial: '#a8a29e', // 1 — gestures at it
  explicit: '#0f766e', // 2 — stated clearly enough to act on
};

function shares(xs: number[]): [number, number, number] {
  const c = [0, 0, 0];
  for (const v of xs) c[v]++;
  const t = xs.length || 1;
  return [(c[0] / t) * 100, (c[1] / t) * 100, (c[2] / t) * 100];
}

export function buildChart(root: string): string {
  const arms: Record<string, { real: number[]; synthetic: number[] }> = {
    agent: { real: [], synthetic: [] },
    human: { real: [], synthetic: [] },
  };
  for (const d of prDirs(root)) {
    if (!has(d, 'scores3.json')) continue;
    const sc = readJson<ThreeArmScores>(d, 'scores3.json');
    if (!sc) continue;
    const prov = readMeta(d).provenance;
    for (const s of sc.scores) {
      arms[prov].real.push(s.real);
      arms[prov].synthetic.push(s.synthetic);
    }
  }

  const bars: Bar[] = [
    { label: 'Agent-attested', sub: 'the record its author left', shares: shares(arms.agent.real), n: arms.agent.real.length },
    { label: '', sub: 'a model, from the diff alone', shares: shares(arms.agent.synthetic), n: arms.agent.synthetic.length },
    { label: 'Human-authored', sub: 'the record its author left', shares: shares(arms.human.real), n: arms.human.real.length },
    { label: '', sub: 'a model, from the diff alone', shares: shares(arms.human.synthetic), n: arms.human.synthetic.length },
  ];

  const W = 860;
  const LEFT = 250;
  const BAR_W = 540;
  const BAR_H = 46;
  const GAP = 12;
  const GROUP_GAP = 26;
  const TOP = 118;
  const H = TOP + bars.length * (BAR_H + GAP) + GROUP_GAP + 96;

  const p1 = (v: number) => v.toFixed(1);
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif">`);
  out.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  out.push(`<text x="24" y="38" font-size="19" font-weight="700" fill="#1c1917">Can the written record answer questions about the change?</text>`);
  out.push(`<text x="24" y="62" font-size="13.5" fill="#57534e">Share of mechanism questions answered, by what the reader is given. 1,000 merged PRs, 3,182 questions.</text>`);
  out.push(`<text x="24" y="81" font-size="13.5" fill="#57534e">Questions generated from the diff alone; each text scored on its own, blind to source.</text>`);

  // Legend
  const legend: [string, string][] = [
    [COLORS.absent, '0 — nothing in the text bears on it'],
    [COLORS.partial, '1 — gestures at it'],
    [COLORS.explicit, '2 — stated clearly enough to act on'],
  ];
  let lx = 24;
  for (const [c, t] of legend) {
    out.push(`<rect x="${lx}" y="${TOP - 30}" width="12" height="12" rx="2" fill="${c}"/>`);
    out.push(`<text x="${lx + 18}" y="${TOP - 19}" font-size="12" fill="#44403c">${t}</text>`);
    lx += t.length * 6.6 + 42;
  }

  let y = TOP;
  bars.forEach((b, i) => {
    if (i === 2) y += GROUP_GAP;
    if (b.label) {
      out.push(`<text x="24" y="${y + 20}" font-size="14.5" font-weight="700" fill="#1c1917">${b.label}</text>`);
    }
    out.push(`<text x="24" y="${y + (b.label ? 38 : 29)}" font-size="12.5" fill="#57534e">${b.sub}</text>`);

    let x = LEFT;
    const segs: [number, string][] = [
      [b.shares[0], COLORS.absent],
      [b.shares[1], COLORS.partial],
      [b.shares[2], COLORS.explicit],
    ];
    segs.forEach(([pctVal, colour], si) => {
      const w = (pctVal / 100) * BAR_W;
      out.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${BAR_H}" fill="${colour}"/>`);
      // Only label a segment wide enough to hold the text without spilling.
      if (w > 46) {
        out.push(
          `<text x="${(x + w / 2).toFixed(1)}" y="${y + BAR_H / 2 + 5}" font-size="13.5" font-weight="${si === 2 || si === 0 ? 700 : 400}" fill="#ffffff" text-anchor="middle">${p1(pctVal)}%</text>`
        );
      }
      x += w;
    });
    y += BAR_H + GAP;
  });

  const noteY = y + 22;
  out.push(`<text x="24" y="${noteY}" font-size="12.5" fill="#44403c"><tspan font-weight="700">Absence.</tspan> For 68.9% of questions, the human-authored record contains nothing at all.</text>`);
  out.push(`<text x="24" y="${noteY + 20}" font-size="12.5" fill="#44403c"><tspan font-weight="700">Reproducibility.</tspan> Where records are full, the two agent bars have nearly the same shape — a model matches them from the diff.</text>`);
  out.push(`<text x="24" y="${noteY + 40}" font-size="12.5" fill="#78716c">Even so, the best-documented cut leaves 30.5% of mechanism questions unanswered. This is not a story about lazy humans.</text>`);
  out.push('</svg>');
  return out.join('\n');
}
