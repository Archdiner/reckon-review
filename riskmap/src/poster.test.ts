/**
 * Tests for the poster.
 *
 * The bugs this file exists to catch are the ones that are invisible in the source and obvious in
 * the output. Two hero visuals shipped with geometry outside their own viewBox this session — a
 * mosaic that inherited a column count sized for a different n, and a swarm whose relaxation loop
 * had no clamp — and neither was visible in code review. So every assertion here is about the
 * RENDERED string: what is inside the canvas, what colour carries what, and what words are absent.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import {
  binOf,
  colourFor,
  planMosaic,
  renderPoster,
  loadPosterData,
  loadPrs,
  pearson,
  median,
  CONTRAST_PAIRS,
  contrastRatio,
  POSTER_RAMP,
  POSTER_BINS,
  type PosterData,
  type PrRow,
} from './poster.js';
import { relativeLuminance } from './treemap.js';

let failures = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ok    ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// ── BINNING ──────────────────────────────────────────────────────────────────────────────────

console.log('binning: zero is its own bin');
ok('exactly zero lands in bin 0', binOf(0) === 0);
ok('a hair above zero does NOT land in bin 0', binOf(0.0001) === 1, `got ${binOf(0.0001)}`);
ok('one lands in the top bin', binOf(1) === POSTER_BINS - 1, `got ${binOf(1)}`);
ok('every bin index is in range', [0, 0.01, 0.2, 0.5, 0.9, 1].every((v) => binOf(v) >= 0 && binOf(v) < POSTER_BINS));
ok('bin 0 and bin 1 are different colours', POSTER_RAMP[0] !== POSTER_RAMP[1]);
ok(
  'the ramp ascends in luminance, so lightness alone carries the quantity',
  POSTER_RAMP.every((c, i) => i === 0 || relativeLuminance(c) > relativeLuminance(POSTER_RAMP[i - 1]!))
);
ok('an unmeasured value is not given a ramp colour', !POSTER_RAMP.includes(colourFor(null)));

// ── MOSAIC LAYOUT: THE TOWER CASE ────────────────────────────────────────────────────────────

console.log('\nmosaic layout stays inside its box at every n');
for (const n of [1, 7, 63, 337, 1000, 2000]) {
  const p = planMosaic(n, 480, 300);
  ok(
    `n=${n} fits its box (${Math.round(p.width)}x${Math.round(p.height)})`,
    p.width <= 480.01 && p.height <= 300.01,
    `${p.width}x${p.height}`
  );
  ok(`n=${n} has room for every square`, p.cols * p.rows >= n, `${p.cols}x${p.rows}`);
}
{
  // THE TOWER CASE. A block sized for a small n must not keep that column count for a large one.
  const small = planMosaic(63, 480, 300);
  const large = planMosaic(2000, 480, 300);
  ok('a 2,000-item block is not 30x taller than a 63-item one', large.height < small.height * 3, `${small.height} vs ${large.height}`);
}

// ── CONTRAST ─────────────────────────────────────────────────────────────────────────────────

console.log('\nWCAG AA: every text/background pair, against the floor that applies to it');
let worstMargin = Infinity;
for (const [what, fg, bg, floor] of CONTRAST_PAIRS) {
  const r = contrastRatio(fg, bg);
  worstMargin = Math.min(worstMargin, r - floor);
  ok(`${what}: ${r.toFixed(2)}:1 (floor ${floor})`, r >= floor, `${r.toFixed(2)}:1 is below ${floor}`);
}
console.log(`        (tightest margin over its own floor: ${worstMargin.toFixed(2)})`);

// ── SYNTHETIC RENDER: GEOMETRY AND CONTENT ───────────────────────────────────────────────────

function synthetic(n: number): PosterData {
  const prs: PrRow[] = Array.from({ length: n }, (_, i) => ({
    id: `repo__${i}`,
    repo: i % 2 ? 'a/one' : 'b/two',
    provenance: i % 3 ? 'human' : 'agent',
    tier: i % 5 === 0 ? 'empty' : i % 7 === 0 ? 'trivial' : 'substantive',
    nQuestions: 3,
    real: i % 5 === 0 ? 0 : ((i * 37) % 100) / 100,
    paraphrase: i % 6 === 0 ? 0 : ((i * 53) % 100) / 100,
    synthetic: ((i * 71) % 100) / 100,
    recordChars: 20 + ((i * 911) % 4000),
    syntheticChars: 900 + ((i * 37) % 600),
  }));
  return {
    prs,
    regions: Array.from({ length: 40 }, (_, i) => ({
      path: `pkg/area${i}`,
      coverage: i % 9 === 0 ? null : ((i * 13) % 60) / 100,
      ciLo: 0.02,
      ciHi: 0.5,
      questions: 8 + i,
      thin: i % 4 === 0,
    })),
    regionRepo: 'x/y',
    regionQuestions: 1234,
    ablation: Array.from({ length: 50 }, (_, i) => ({ full: ((i * 17) % 90) / 100, subject: ((i * 7) % 40) / 100 })),
    repoAreas: Array.from({ length: 21 }, (_, i) => ({
      repo: `owner${i}/project${i}`,
      coverage: i >= 19 ? null : 0.05 + i * 0.03,
      questions: i >= 19 ? 0 : 400 + i * 20,
      // Ragged on purpose, with a thin cell every few rows: the panel must handle both.
      areas: i >= 19 ? [] : Array.from({ length: 8 + (i % 13) }, (_, j) => (j % 7 === 3 ? null : ((j * 11) % 60) / 100)),
      areasNotScored: i % 4,
      refused: i >= 19,
      bodyDensity: i >= 19 ? 0.04 : 0.5,
    })),
    gate: Array.from({ length: 24 }, (_, i) => ({
      repo: `owner${i}/project${i}`,
      verdict: i < 20 ? 'pass' : i < 21 ? 'weak' : 'fail',
      substantiveShare: 1 - i * 0.04,
    })),
    missing: [],
  };
}

console.log('\nrendered geometry is inside the viewBox');
for (const n of [12, 200, 1000]) {
  const svg = renderPoster(synthetic(n));
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  ok(`n=${n}: viewBox present`, vb !== null);
  if (!vb) continue;
  const W = Number(vb[1]);
  const H = Number(vb[2]);

  let out = 0;
  let worstY = 0;
  for (const m of svg.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
    // Rects inside translated groups cannot be checked absolutely; the group offsets are what the
    // panel functions control, so this checks the ones that are positioned absolutely (the bands
    // and rules) and relies on the circle/text checks below for the rest.
    const y = Number(m[2]);
    const h = Number(m[4]);
    if (y + h > H + 0.5) {
      out++;
      worstY = Math.max(worstY, y + h);
    }
  }
  ok(`n=${n}: no absolutely-positioned rect below the canvas`, out === 0, `${out} rects, worst y2=${worstY}`);
  ok(`n=${n}: canvas is a sane poster shape`, H > W * 0.5 && H < W * 3, `${W}x${H}`);
  ok(`n=${n}: the height responds to content`, H > 900, `${H}`);

  // Every arm mosaic must draw exactly n squares, three times. Anything else means the layout
  // silently dropped data, which is the failure mode a mosaic cannot show you.
  const squares = [...svg.matchAll(/<rect [^>]*fill="(#[0-9a-f]{6})"/gi)].filter((m) =>
    POSTER_RAMP.includes(m[1]!.toLowerCase())
  ).length;
  ok(
    `n=${n}: at least 3n ramp-coloured squares are drawn (${squares})`,
    squares >= 3 * n,
    `${squares} < ${3 * n}`
  );
}

console.log('\nthe poster never names a person and never overclaims');
{
  const svg = renderPoster(synthetic(300));
  ok('no email-shaped string anywhere', !/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(svg));
  ok('no "@" handle in any label', !/>\s*@/.test(svg));
  // "understood" is the word the whole artifact is careful not to claim: coverage measures what a
  // record SAYS, not whether anybody understood anything.
  const understood = /understood|understands/i.test(svg);
  ok('does not claim anyone understood anything', !understood);
  ok('says "explains" or "explain" instead', /explain/i.test(svg));
  ok('states that vertical position is meaningless where it is', /means nothing|carries no meaning/i.test(svg));
  ok('carries a drawn legend, not a described one', svg.includes('nothing') && svg.includes('all of it'));
  ok('the separation guard is stated', /never sees the code/i.test(svg));
  // The predictive claim a heatmap invites was tested and failed, so the poster has to disown it.
  ok('disowns the predictive claim', /not what will break/i.test(svg));
  ok('and says where that was tested', /223 areas across four repositories/.test(svg));
}

console.log('\nthe repository matrix draws every row and hides nothing');
{
  const d = synthetic(300);
  const svg = renderPoster(d);
  ok('the panel is drawn', svg.includes('the same measurement, every repository'));
  for (const r of d.repoAreas) {
    ok(`row present: ${r.repo}`, svg.includes(r.repo));
  }
  // The wording shortens in two-column mode, so the assertion matches the invariant — a refusal states
  // its measured body density instead of showing colour — not one particular sentence.
  ok('a refused repository says why instead of showing colour', /refused — 4% (of its commits|body density)/.test(svg));
  ok('thin cells are hatched, not given a ramp colour', svg.includes('url(#thinHatch)'));
  ok('the hatch pattern is defined', svg.includes('<pattern id="thinHatch"'));
  ok('the pooled figure and the between-repository range are both printed', /Pooled .*Between repositories/.test(svg));
  ok('unscored areas are disclosed', />\+\d</.test(svg));
  ok('says a cell is one directory area', /One cell is one directory area/.test(svg));
  // A refused repository has no coverage, so it must never contribute to the pool.
  const scored = d.repoAreas.filter((r) => !r.refused);
  const pooled = scored.reduce((a, r) => a + (r.coverage ?? 0) * r.questions, 0) / scored.reduce((a, r) => a + r.questions, 0);
  ok(
    `the pooled figure excludes refusals (${(pooled * 100).toFixed(1)}%)`,
    svg.includes(`Pooled ${(pooled * 100).toFixed(1)}%`),
    svg.split('Pooled ')[1]?.slice(0, 40) ?? 'no pooled line'
  );
}

console.log('\nmissing inputs are reported rather than filled in');
{
  const d = synthetic(50);
  d.ablation = [];
  d.regions = [];
  d.gate = [];
  d.repoAreas = [];
  d.missing = ['some/file.csv'];
  const svg = renderPoster(d);
  ok('the omission is printed', svg.includes('Omitted for want of data'));
  ok('no ablation panel is drawn', !svg.includes('the subject line is not the record'));
  ok('no region panel is drawn', !svg.includes('inside one repository'));
  ok('no gate panel is drawn', !svg.includes('where the record can be measured'));
  ok('no matrix panel is drawn', !svg.includes('the same measurement, every repository'));
  ok('the poster still renders', /viewBox="0 0 [\d.]+ [\d.]+"/.test(svg));
}

// ── STATISTICS ───────────────────────────────────────────────────────────────────────────────

console.log('\nthe small statistics are the standard ones');
ok('median of an even-length set averages the middle two', median([1, 2, 3, 4]) === 2.5);
ok('median of an odd-length set is the middle', median([5, 1, 3]) === 3);
ok('pearson of a perfect line is 1', Math.abs((pearson([1, 2, 3, 4], [2, 4, 6, 8]) ?? 0) - 1) < 1e-9);
ok('pearson of a constant series is null', pearson([1, 1, 1, 1], [1, 2, 3, 4]) === null);

// ── AGAINST THE REAL FILES, WHEN THEY ARE THERE ──────────────────────────────────────────────

const studyResults = join(ROOT, '..', 'study', 'results');
const recordMap = join(ROOT, 'out', 'recordmap', 'grafana-grafana-record-map.json');
const gateJson = join(ROOT, 'out', 'gate', 'gate.json');
if (existsSync(join(studyResults, 'three-arm-scores.csv'))) {
  console.log('\nagainst the published results');
  const prs = loadPrs(join(studyResults, 'three-arm-scores.csv'));
  ok(`${prs.length} scored pull requests load`, prs.length > 900, `${prs.length}`);
  ok('every coverage value is a share in [0,1]', prs.every((p) => p.real >= 0 && p.real <= 1 && p.synthetic >= 0 && p.synthetic <= 1));
  ok('provenance is only human or agent', prs.every((p) => p.provenance === 'human' || p.provenance === 'agent'));
  ok(
    'tier is one of the three the study defines',
    prs.every((p) => ['empty', 'trivial', 'substantive'].includes(p.tier)),
    [...new Set(prs.map((p) => p.tier))].join(',')
  );

  const d = loadPosterData({ studyResults, recordMapJson: recordMap, gateJson });
  ok('nothing is missing', d.missing.length === 0, d.missing.join(', '));
  const svg = renderPoster(d, { stamp: 'test' });
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)!;
  console.log(`        (real poster: ${vb[1]}x${vb[2]}, ${(svg.length / 1024).toFixed(0)} KiB)`);
  ok('the real poster renders inside a sane canvas', Number(vb[2]) > 1000 && Number(vb[2]) < 4000, vb[2]);
  ok('the real poster draws no NaN coordinate', !/NaN/.test(svg));
}

console.log('');
if (failures > 0) {
  console.log(`${failures} poster test(s) failed`);
  process.exit(1);
}
console.log('all poster tests passed');
