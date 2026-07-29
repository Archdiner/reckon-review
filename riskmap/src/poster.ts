/**
 * THE POSTER — every measurement we have, in one image.
 *
 * ── WHY A POSTER RATHER THAN MORE CHARTS ───────────────────────────────────────────────────
 *
 * The individual charts each answer one question and each need a paragraph to set up. Stacked in
 * a thread they read as an audit. The finding, though, is a single fact that repeats at every
 * scale we can measure — question, pull request, arm, repository, directory — and a reader who
 * sees it repeat is convinced by the repetition rather than by any one panel. So: one canvas,
 * every scale, the same encoding throughout.
 *
 * ── THE ONE ENCODING ──────────────────────────────────────────────────────────────────────
 *
 * ONE SQUARE IS ONE PULL REQUEST, and its colour is the share of mechanism questions about that
 * change which its written record answers explicitly. Dark is unexplained, pale is explained. The
 * ramp is the brand's own blue family, which is a sequential scale by nature and stays readable
 * under every form of colour-vision deficiency because lightness carries the signal.
 *
 * Nothing on this poster is a summary statistic standing in for data we have. There are 1,000
 * scored pull requests, so 1,000 squares get drawn, three times over — once for the real record,
 * once for a paraphrase of it, once for a model's account written from the diff alone. Each panel is
 * sorted by its own score so the three shapes are comparable distributions; see `triptych` for why
 * that beat sharing one order, and for what it gives up.
 *
 * ZERO GETS ITS OWN COLOUR, and this is the one departure from a plain sequential bin. 38.4% of
 * substantive records — 55.7% of all of them — answer NOTHING explicitly, so a bin boundary drawn
 * by dividing [0,1] into sevenths would put the single largest feature of this data in a bin
 * shared with values that are merely low. The legend says so; a fabricated smooth gradient over a
 * spike would be the more attractive and less honest choice.
 *
 * ── WHERE THE COLOUR VARIETY COMES FROM, AND WHERE IT DOES NOT ────────────────────────────
 *
 * Coverage — the one quantity — keeps the one ramp everywhere it appears. Variety comes from the
 * CATEGORICAL variables getting their own hues: who wrote the change, and what kind of record it
 * left. Those are nominal, so distinct hues are the correct encoding rather than decoration, and
 * they are chosen on the blue-amber axis, which is the colour-vision-safe one.
 *
 * What is NOT allowed: a second ramp for the same quantity, or a hue that means one thing in one
 * panel and another thing elsewhere. That is how a poster becomes pretty and unreadable.
 *
 * ── WHAT IS DRAWN FROM MEASUREMENT AND WHAT IS TYPESET ────────────────────────────────────
 *
 * Every number on the canvas is computed at render time from the published result files. Nothing
 * is transcribed from a report, because a transcribed number is a number that goes stale silently
 * — this session found four of them. If a file is missing, the panel it feeds is omitted and the
 * poster says which, rather than drawing a plausible shape.
 *
 * No individual is ever named, here as everywhere: the inputs carry a repository and a
 * provenance arm and nothing else.
 */

import { readFileSync, existsSync } from 'node:fs';
import { LIGHT_RAMP, relativeLuminance, contrastRatio, esc } from './treemap.js';

// ── PALETTE ───────────────────────────────────────────────────────────────────────────────────

/** The page. The brand's pale ice, as on reckonreview.dev. */
export const PAGE = '#eef5f8';
/** The hero band and every heavy rule. */
export const NAVY = '#0d2f4a';
export const NAVY_DEEP = '#08202f';
/** The wordmark's mid teal. Carries "human" wherever provenance is encoded. */
export const TEAL = '#4a90ab';
export const ICE = '#eaf3f7';
export const INK = '#0b1f30';
export const MUTED = '#4a6577';
/** The warm accent. Carries "agent" wherever provenance is encoded, and callout rules. */
export const AMBER = '#c97a22';
export const AMBER_LIGHT = '#e8a33d';
/**
 * Records with nothing in them. A category, not a low value on the ramp.
 *
 * Deepened from #b4553f: at that value ice text on it came to 4.33:1 and near-black to 3.44:1, so
 * NEITHER ink cleared AA and the count inside the segment was unreadable whichever way it was drawn.
 * The rule is the same one the treemap ramp follows — a fill that carries a label has to leave one of
 * the two inks a legible option.
 */
export const CORAL = '#a94a34';
/**
 * Hero subtitle ink. Brighter than it looks like it needs to be, because it sits over the dither:
 * an ice cell at the top of the opacity range lightens the band underneath it, and the ink has to
 * clear AA against THAT rather than against the flat navy. `MAX_DITHER_ALPHA` and `ditherOver` exist
 * so the test can assert the worst case rather than trusting the eye.
 */
export const HERO_SUB = '#cfe3ee';
export const MAX_DITHER_ALPHA = 0.18;

/** Alpha-composite `fg` over `bg`. Used to compute the worst-case background a dither cell makes. */
export function blend(fg: string, bg: string, alpha: number): string {
  const parse = (c: string): [number, number, number] => [
    parseInt(c.slice(1, 3), 16),
    parseInt(c.slice(3, 5), 16),
    parseInt(c.slice(5, 7), 16),
  ];
  const [fr, fg2, fb] = parse(fg);
  const [br, bg2, bb] = parse(bg);
  const mix = (a: number, b: number): string =>
    Math.round(a * alpha + b * (1 - alpha))
      .toString(16)
      .padStart(2, '0');
  return `#${mix(fr, br)}${mix(fg2, bg2)}${mix(fb, bb)}`;
}

/** The lightest background the hero text can land on: an ice dither cell at full opacity over navy. */
export const ditherOver = (band: string): string => blend('#eaf3f7', band, MAX_DITHER_ALPHA);

/**
 * The coverage ramp, with an EXPLICIT ZERO BIN at the dark end.
 *
 * `LIGHT_RAMP` is the shared 10-step brand ramp; the poster takes seven samples of it so a legend
 * can carry seven readable swatches, and reserves index 0 for exactly-zero.
 */
export const POSTER_BINS = 7;
export const POSTER_RAMP: string[] = Array.from({ length: POSTER_BINS }, (_, i) => {
  const t = i / (POSTER_BINS - 1);
  return LIGHT_RAMP[Math.round(t * (LIGHT_RAMP.length - 1))]!;
});

/**
 * Bin index for a coverage share in [0,1].
 *
 * Bin 0 is exactly zero and nothing else. The remaining six bins cut (0,1] evenly. A value of
 * 0.001 therefore lands in bin 1 rather than bin 0, which is the point: "wrote nothing down" and
 * "wrote something down that answered almost nothing" are different states and the largest single
 * feature of this data is the first one.
 */
export function binOf(coverage: number): number {
  if (!(coverage > 0)) return 0;
  const b = 1 + Math.floor(coverage * (POSTER_BINS - 1));
  return Math.min(POSTER_BINS - 1, b);
}

export function colourFor(coverage: number | null): string {
  if (coverage === null || !Number.isFinite(coverage)) return '#c3c7cd';
  return POSTER_RAMP[binOf(coverage)]!;
}

/** Ink that clears WCAG AA against a given fill. Asserted in the tests, not assumed. */
export function inkOn(fill: string): string {
  return relativeLuminance(fill) > 0.19 ? INK : ICE;
}

// ── DATA ──────────────────────────────────────────────────────────────────────────────────────

export interface PrRow {
  id: string;
  repo: string;
  /** 'human' | 'agent'. The corpus carries no finer attribution and neither does this. */
  provenance: string;
  /** 'empty' | 'trivial' | 'substantive' — the study's record tier. */
  tier: string;
  nQuestions: number;
  /** Share of questions the REAL record answers explicitly, in [0,1]. */
  real: number;
  /** Same, for a paraphrase of the real record: controls for wording. */
  paraphrase: number;
  /** Same, for a model's account written from the diff alone: the ceiling. */
  synthetic: number;
  recordChars: number;
  /** Length of the model's account written from the diff alone. The comparison point. */
  syntheticChars: number;
}

export interface RegionRow {
  path: string;
  coverage: number | null;
  ciLo: number | null;
  ciHi: number | null;
  questions: number;
  /** Too thin to colour: below the scored-commit floor or a wider interval than the rule allows. */
  thin: boolean;
}

export interface GateRow {
  repo: string;
  /** 'pass' | 'weak' | 'fail' — measured, not asserted. */
  verdict: string;
  /** Share of the last 200 commits carrying a body beyond the subject. */
  substantiveShare: number;
}

export interface AblationRow {
  /** Coverage of the full record (subject + body). */
  full: number;
  /** Coverage of the subject line alone — the record a squash-to-title repository leaves. */
  subject: number;
}

export interface PosterData {
  prs: PrRow[];
  regions: RegionRow[];
  regionRepo: string;
  /** Region-level questions actually scored, for the footer. */
  regionQuestions: number;
  ablation: AblationRow[];
  gate: GateRow[];
  missing: string[];
}

/** Minimal CSV split. The study's writers quote nothing and the headers are ASCII; asserted below. */
function rows(path: string): Record<string, string>[] {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const header = (lines.shift() ?? '').split(',');
  if (text.includes('"')) {
    // Bail rather than mis-parse. A quoted field would silently shift every column after it.
    throw new Error(`${path} contains a quoted field; this parser cannot read it`);
  }
  return lines.map((l) => {
    const parts = l.split(',');
    const o: Record<string, string> = {};
    header.forEach((h, i) => {
      o[h] = parts[i] ?? '';
    });
    return o;
  });
}

const num = (s: string | undefined): number => {
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
};

/**
 * The three-arm file is the source for the pull-request panels, not `per-pr-scores.csv`.
 *
 * It is the only published file carrying the record TIER and all three arms on the same row, and
 * a poster that read arms from one file and tiers from another would be one join away from a
 * mismatch nobody would see. Percentages there are 0-100; everything here works in [0,1].
 */
export function loadPrs(path: string): PrRow[] {
  return rows(path).map((r) => ({
    id: r.id ?? '',
    repo: r.repo ?? '',
    provenance: r.provenance ?? '',
    tier: r.tier ?? '',
    nQuestions: num(r.nQuestions),
    real: num(r.realPct2) / 100,
    paraphrase: num(r.paraphrasePct2) / 100,
    synthetic: num(r.syntheticPct2) / 100,
    recordChars: num(r.recordChars),
    syntheticChars: num(r.syntheticChars),
  }));
}

export function loadAblation(path: string): AblationRow[] {
  return rows(path).map((r) => ({ full: num(r.fullPct2) / 100, subject: num(r.subjectPct2) / 100 }));
}

export function loadRegions(path: string): { repo: string; rows: RegionRow[]; questions: number } {
  const j = JSON.parse(readFileSync(path, 'utf8')) as {
    repo: string;
    overall: { total: number } | null;
    cells: {
      path: string;
      coverage: number | null;
      ciLo: number | null;
      ciHi: number | null;
      questions: number;
      greyReason: string | null;
    }[];
  };
  return {
    repo: j.repo,
    questions: j.overall?.total ?? 0,
    rows: j.cells.map((c) => ({
      path: c.path,
      coverage: c.coverage,
      ciLo: c.ciLo,
      ciHi: c.ciHi,
      questions: c.questions,
      thin: c.greyReason !== null,
    })),
  };
}

export function loadGate(path: string): GateRow[] {
  const j = JSON.parse(readFileSync(path, 'utf8')) as {
    results?: { repo: string; verdict: string; substantiveShare: number }[];
    rows?: { repo: string; verdict: string; substantiveShare: number }[];
  };
  const list = j.results ?? j.rows ?? [];
  return list
    .filter((r) => typeof r.substantiveShare === 'number' && Number.isFinite(r.substantiveShare))
    .map((r) => ({ repo: r.repo, verdict: r.verdict, substantiveShare: r.substantiveShare }));
}

export interface LoadOpts {
  studyResults: string;
  recordMapJson: string;
  gateJson: string;
}

/** Load everything, recording what was absent instead of substituting for it. */
export function loadPosterData(opts: LoadOpts): PosterData {
  const missing: string[] = [];
  const three = `${opts.studyResults}/three-arm-scores.csv`;
  const unit = `${opts.studyResults}/unit-mismatch-scores.csv`;

  let prs: PrRow[] = [];
  if (existsSync(three)) prs = loadPrs(three);
  else missing.push(three);

  let ablation: AblationRow[] = [];
  if (existsSync(unit)) ablation = loadAblation(unit);
  else missing.push(unit);

  let gate: GateRow[] = [];
  if (existsSync(opts.gateJson)) gate = loadGate(opts.gateJson);
  else missing.push(opts.gateJson);

  let regions: RegionRow[] = [];
  let regionRepo = '';
  let regionQuestions = 0;
  if (existsSync(opts.recordMapJson)) {
    const r = loadRegions(opts.recordMapJson);
    regions = r.rows;
    regionRepo = r.repo;
    regionQuestions = r.questions;
  } else missing.push(opts.recordMapJson);

  return { prs, regions, regionRepo, regionQuestions, ablation, gate, missing };
}

// ── SMALL STATISTICS, COMPUTED HERE SO NOTHING IS TRANSCRIBED ────────────────────────────────

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const share = (xs: number[], p: (x: number) => boolean): number =>
  xs.length ? xs.filter(p).length / xs.length : 0;

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Pearson correlation. Returns null when either side has no variation. */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// ── SVG PRIMITIVES ────────────────────────────────────────────────────────────────────────────

const f = (n: number): string => (Math.round(n * 100) / 100).toString();

function rect(x: number, y: number, w: number, h: number, fill: string, extra = ''): string {
  return `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${fill}"${extra}/>`;
}

function text(x: number, y: number, s: string, cls: string, extra = ''): string {
  return `<text x="${f(x)}" y="${f(y)}" class="${cls}"${extra}>${esc(s)}</text>`;
}

const pctLabel = (v: number, digits = 0): string => `${(v * 100).toFixed(digits)}%`;

/**
 * The dither. The site's hero is a pixel mosaic, and the poster's hero band answers it.
 *
 * Deterministic by construction — a 32-bit integer hash of the cell index, never `Math.random`,
 * so the same poster is byte-identical on every run and a diff of two builds shows only real
 * changes.
 */
function ditherBand(w: number, h: number, cell = 7): string {
  const parts: string[] = [];
  const cols = Math.ceil(w / cell);
  const rowsN = Math.ceil(h / cell);
  for (let i = 0; i < cols * rowsN; i++) {
    let x = (i * 2654435761) % 4294967296;
    x ^= x >>> 15;
    x = (x * 2246822519) % 4294967296;
    x ^= x >>> 13;
    const r = (x % 1000) / 1000;
    const cx = (i % cols) * cell;
    const cy = Math.floor(i / cols) * cell;
    // Density RISES to the right, so the title on the left sits on the quiet side of the band.
    // It ran the other way first and put the densest texture directly behind the headline.
    const density = 0.06 + 0.4 * Math.pow(cx / w, 1.7);
    if (r > density) continue;
    const o = 0.05 + ((x >>> 7) % 100) / 100 * (MAX_DITHER_ALPHA - 0.05);
    parts.push(rect(cx, cy, cell - 1, cell - 1, ICE, ` opacity="${f(o)}"`));
  }
  return parts.join('');
}

// ── PANELS ────────────────────────────────────────────────────────────────────────────────────

export interface MosaicPlan {
  cols: number;
  rows: number;
  cell: number;
  width: number;
  height: number;
}

/**
 * Lay out `n` squares in a block no wider than `maxWidth`, preferring a shape close to `aspect`.
 *
 * The column count is derived rather than fixed, because a fixed count is what broke the earlier
 * hero: a block sized for 63 items inherited its column count for 2,000 and rendered a tower 2,316
 * pixels tall inside a 1,200-pixel canvas.
 */
export function planMosaic(n: number, maxWidth: number, maxHeight: number, aspect = 1.6): MosaicPlan {
  if (n <= 0) return { cols: 0, rows: 0, cell: 0, width: 0, height: 0 };
  let best: MosaicPlan | null = null;
  for (let cols = 1; cols <= n; cols++) {
    const rowsN = Math.ceil(n / cols);
    const cell = Math.min(maxWidth / cols, maxHeight / rowsN);
    if (cell < 1) continue;
    const w = cols * cell;
    const h = rowsN * cell;
    // Prefer the largest cell; break ties toward the requested aspect.
    const score = cell - Math.abs(w / h - aspect) * 0.35;
    if (!best || score > best.cell - Math.abs(best.width / best.height - aspect) * 0.35) {
      best = { cols, rows: rowsN, cell, width: w, height: h };
    }
  }
  return best ?? { cols: n, rows: 1, cell: maxWidth / n, width: maxWidth, height: maxWidth / n };
}

/** One mosaic of coverage values, in the caller's order. Returns the SVG and the plan used. */
function mosaic(values: (number | null)[], plan: MosaicPlan, gap = 1): string {
  const parts: string[] = [];
  values.forEach((v, i) => {
    const cx = (i % plan.cols) * plan.cell;
    const cy = Math.floor(i / plan.cols) * plan.cell;
    parts.push(rect(cx, cy, Math.max(1, plan.cell - gap), Math.max(1, plan.cell - gap), colourFor(v)));
  });
  return parts.join('');
}

/** A legend for the coverage ramp, drawn rather than described. */
function coverageLegend(x: number, y: number, w: number): string {
  const parts: string[] = [];
  const sw = Math.min(34, (w - 10) / POSTER_BINS);
  parts.push(text(x, y - 10, 'share of the mechanism the record explains', 'lbl'));
  for (let i = 0; i < POSTER_BINS; i++) {
    parts.push(rect(x + i * (sw + 3), y, sw, 13, POSTER_RAMP[i]!, ' stroke="#c9d6de" stroke-width="0.5"'));
  }
  parts.push(text(x, y + 28, 'nothing', 'tick'));
  parts.push(
    text(x + POSTER_BINS * (sw + 3) - 3, y + 28, 'all of it', 'tick', ' text-anchor="end"')
  );
  parts.push(
    text(x, y + 44, 'the darkest square is exactly zero — its own bin, not a low value', 'tick')
  );
  return `<g transform="translate(0,0)">${parts.join('')}</g>`;
}

export interface PanelResult {
  svg: string;
  height: number;
}

/**
 * THE TRIPTYCH. Three arms, 1,000 squares each.
 *
 * This is the study in one image and it is the reason the poster exists. The middle panel is the
 * control that stops the right-hand one being dismissed: if a model's account from the diff scores
 * higher than the human record, the first objection is that the scorer likes machine prose. So the
 * real record is also PARAPHRASED by a model and rescored. If wording were doing the work, the
 * paraphrase would move with the synthetic arm. It does not, and the reader can see that rather
 * than take it on trust.
 *
 * EACH PANEL IS SORTED BY ITS OWN VALUE, and the caption says so. The first version used one shared
 * order — the left panel's — which is the study's paired design and is defensible, but it renders
 * the other two panels as visual noise: the same distribution scattered rather than stacked. A
 * reader sees instability where there is none. Sorting each panel independently turns all three
 * into stacked bands whose SHAPES are directly comparable, which is the comparison the panel is
 * making. What it gives up is the within-change pairing, and the pairing is not legible at one
 * thousand squares anyway — the paired estimate with its interval belongs in the report, where it is.
 */
function triptych(d: PosterData, x: number, y: number, w: number): PanelResult {
  const gap = 46;
  const panelW = (w - 2 * gap) / 3;
  const plan = planMosaic(d.prs.length, panelW, 330, panelW / 300);

  const arms: { key: 'real' | 'paraphrase' | 'synthetic'; title: string; sub: string }[] = [
    { key: 'real', title: 'the record as written', sub: 'description + commit messages' },
    { key: 'paraphrase', title: 'the same record, reworded', sub: 'controls for prose style' },
    { key: 'synthetic', title: 'written from the diff alone', sub: 'what was available to say' },
  ];

  const parts: string[] = [];
  arms.forEach((arm, ai) => {
    const px = x + ai * (panelW + gap);
    const values = d.prs.map((p) => p[arm.key]).sort((a, b) => a - b);
    const m = mean(values);
    const zero = share(values, (v) => v === 0);
    parts.push(`<g transform="translate(${f(px)},${f(y)})">`);
    parts.push(text(0, 0, arm.title, 'panelTitle'));
    parts.push(text(0, 19, arm.sub, 'panelSub'));
    parts.push(`<g transform="translate(0,34)">${mosaic(values, plan)}</g>`);
    const by = 34 + plan.height + 30;
    parts.push(text(0, by, pctLabel(m, 1), 'bigNum'));
    parts.push(text(0, by + 20, 'of mechanism questions answered', 'lbl'));
    parts.push(
      text(0, by + 36, `${pctLabel(zero, 1)} of these changes explain nothing at all`, 'lbl')
    );
    // The zero share as a rule under the number, so the three are comparable at a glance without
    // reading any digits.
    const barW = plan.width;
    parts.push(rect(0, by + 46, barW, 7, '#d3e2e9'));
    parts.push(rect(0, by + 46, barW * zero, 7, arm.key === 'synthetic' ? TEAL : NAVY));
    parts.push('</g>');
  });

  const height = 34 + plan.height + 30 + 62;
  return { svg: parts.join(''), height };
}

/**
 * WHO WROTE IT. Human and agent changes, as paired mosaics with their empty-record rates.
 *
 * Provenance is nominal, so it gets hues rather than ramp positions: teal for human, amber for
 * agent. The mosaics still use the coverage ramp, because coverage is still coverage.
 *
 * The TIER BAR under each mosaic is the other categorical variable in the corpus: what kind of
 * record the change left at all, before anything is scored. Three states, three hues — nothing
 * written, a line or two, a real body — which is a distinct question from how much a body explains
 * and so gets a distinct encoding. It is also the honest context for the number above it: a
 * population whose records are mostly empty is not the same population as one whose records are
 * mostly written and unclear, and averaging over both would hide which problem a team has.
 */
function provenancePanel(d: PosterData, x: number, y: number, w: number): PanelResult {
  const groups = [
    { key: 'human', label: 'written by a person', hue: TEAL },
    { key: 'agent', label: 'written by an agent', hue: AMBER },
  ];
  const parts: string[] = [];
  const gap = 34;
  const colW = (w - gap) / 2;
  const maxN = Math.max(...groups.map((g) => d.prs.filter((p) => p.provenance === g.key).length), 1);
  const plan = planMosaic(maxN, colW, 190, colW / 170);

  groups.forEach((g, gi) => {
    const set = d.prs
      .filter((p) => p.provenance === g.key)
      .sort((a, b) => a.real - b.real || a.id.localeCompare(b.id));
    const px = x + gi * (colW + gap);
    parts.push(`<g transform="translate(${f(px)},${f(y)})">`);
    parts.push(rect(0, -2, 12, 12, g.hue));
    parts.push(text(19, 9, g.label, 'panelTitle'));
    parts.push(text(0, 30, `${set.length} changes`, 'panelSub'));
    parts.push(`<g transform="translate(0,42)">${mosaic(set.map((p) => p.real), plan)}</g>`);
    const by = 42 + plan.height + 28;
    parts.push(text(0, by, pctLabel(share(set.map((p) => p.real), (v) => v === 0), 1), 'bigNum'));
    parts.push(text(0, by + 19, 'left a record that explains nothing', 'lbl'));
    parts.push(
      text(0, by + 35, `record coverage ${pctLabel(mean(set.map((p) => p.real)), 1)} on average`, 'lbl')
    );

    // The tier bar: what kind of record exists, before any scoring.
    const tiers: [string, string][] = [
      ['empty', CORAL],
      ['trivial', AMBER_LIGHT],
      ['substantive', TEAL],
    ];
    const tby = by + 54;
    const tw = plan.width;
    let tx = 0;
    parts.push(text(0, tby, 'and what kind of record it left at all', 'lbl'));
    for (const [tier, hue] of tiers) {
      const n = set.filter((p) => p.tier === tier).length;
      if (n === 0) continue;
      const seg = (n / Math.max(1, set.length)) * tw;
      parts.push(rect(tx, tby + 10, Math.max(1, seg), 22, hue));
      // A count only fits when the segment is wide enough to hold it; below that the legend carries it.
      if (seg > 42) {
        // Ink chosen per segment. Hardcoding ice put the count on the teal segment at 3.18:1 — caught
        // by the contrast test, not by looking at it.
        parts.push(
          text(tx + seg / 2, tby + 25, String(n), 'segNum', ` fill="${inkOn(hue)}" text-anchor="middle"`)
        );
      }
      tx += seg;
    }
    let lx2 = 0;
    for (const [tier, hue] of tiers) {
      const n = set.filter((p) => p.tier === tier).length;
      parts.push(rect(lx2, tby + 40, 9, 9, hue));
      const t = `${tier} ${n}`;
      parts.push(text(lx2 + 14, tby + 48, t, 'tick'));
      lx2 += 14 + t.length * 6.4 + 16;
    }
    parts.push('</g>');
  });

  return { svg: parts.join(''), height: 42 + plan.height + 28 + 44 + 54 + 56 };
}

/**
 * THE ONE THING THAT WOULD SINK THE MEASUREMENT IF IT WERE NOT TESTED.
 *
 * If a repository squashes every pull request to its title, then a tool reading commit messages is
 * measuring the merge button. So the study rescored a subsample against THE SUBJECT LINE ALONE.
 * The drop is the size of the channel a squash-to-title repository throws away, and it is why the
 * record map refuses to draw a repository below a measured body-density floor rather than colouring
 * it and hedging in a footnote.
 */
function ablationPanel(d: PosterData, x: number, y: number, w: number, h: number): PanelResult {
  if (d.ablation.length === 0) return { svg: '', height: 0 };
  const full = d.ablation.map((r) => r.full);
  const subj = d.ablation.map((r) => r.subject);
  const parts: string[] = [];
  parts.push(`<g transform="translate(${f(x)},${f(y)})">`);
  parts.push(text(0, 0, 'the subject line is not the record', 'panelTitle'));
  parts.push(
    text(
      0,
      19,
      `${d.ablation.length} merged pull requests — a separate draw — each scored twice`,
      'panelSub'
    )
  );

  const barsY = 44;
  const barH = 30;
  const gap2 = 22;
  const labelW = 132;
  const barW = w - labelW - 62;
  const pairs = [
    { label: 'full record', v: mean(full), fill: NAVY },
    { label: 'subject only', v: mean(subj), fill: CORAL },
  ];
  pairs.forEach((p, i) => {
    const by = barsY + i * (barH + gap2);
    parts.push(text(0, by + barH * 0.7, p.label, 'lbl'));
    parts.push(rect(labelW, by, barW, barH, '#dceaf0'));
    parts.push(rect(labelW, by, Math.max(2, barW * p.v), barH, p.fill));
    parts.push(
      text(labelW + Math.max(2, barW * p.v) + 10, by + barH * 0.7, pctLabel(p.v, 1), 'barNum')
    );
  });

  const lost = mean(full) - mean(subj);
  const ly = barsY + 2 * (barH + gap2) + 12;
  parts.push(rect(0, ly, 4, 62, AMBER));
  parts.push(text(16, ly + 19, `${(lost * 100).toFixed(1)} points`, 'bigNumSm'));
  parts.push(text(16, ly + 38, 'of explanation live in the body, not the title', 'lbl'));
  parts.push(
    text(16, ly + 56, 'so a repository that squashes to its title is unmeasurable, not merely worse', 'lbl')
  );
  parts.push('</g>');
  return { svg: parts.join(''), height: ly + 70 };
}

/**
 * AND IT IS NOT ONE NUMBER. The same measurement, per project in the corpus.
 *
 * A single pooled figure invites the reply "that is not my team". This panel answers it with the
 * spread that is already in the data: five projects, the same questions, the same rubric, ranging
 * across tens of points. It also carries the warning a pooled number hides — the projects differ in
 * how much agent-authored work they contain, and that is most of what separates the top from the
 * bottom, so the ordering is not a league table of engineering culture.
 *
 * Bars are the coverage ramp at the bar's own value, so a reader can read this panel against the
 * mosaics above without learning a second encoding.
 */
function repoPanel(d: PosterData, x: number, y: number, w: number): PanelResult {
  const byRepo = new Map<string, PrRow[]>();
  for (const p of d.prs) {
    const list = byRepo.get(p.repo);
    if (list) list.push(p);
    else byRepo.set(p.repo, [p]);
  }
  if (byRepo.size < 2) return { svg: '', height: 0 };
  const rowsOut = [...byRepo]
    .map(([repo, list]) => ({
      repo,
      n: list.length,
      cov: mean(list.map((p) => p.real)),
      agentShare: share(list.map((p) => (p.provenance === 'agent' ? 1 : 0)), (v) => v === 1),
    }))
    .sort((a, b) => b.cov - a.cov);

  const parts: string[] = [];
  parts.push(`<g transform="translate(${f(x)},${f(y)})">`);
  parts.push(text(0, 0, 'and it is not one number', 'panelTitle'));
  parts.push(text(0, 19, `the same measurement, per project in the corpus`, 'panelSub'));

  const labelW = 206;
  const barW = w - labelW - 118;
  const rowH = 26;
  const top = 40;
  rowsOut.forEach((r, i) => {
    const by = top + i * rowH;
    parts.push(text(0, by + 13, r.repo, 'repoName'));
    parts.push(rect(labelW, by + 2, barW, 15, '#dceaf0'));
    parts.push(rect(labelW, by + 2, Math.max(2, barW * r.cov), 15, colourFor(r.cov)));
    parts.push(text(labelW + barW + 8, by + 13, pctLabel(r.cov), 'tickStrong'));
    parts.push(text(labelW + barW + 52, by + 13, `n=${r.n}`, 'tick'));
  });
  const ly = top + rowsOut.length * rowH + 12;
  parts.push(
    text(0, ly, 'Projects differ in how much agent-written work they carry, which is most of this spread.', 'tick')
  );
  parts.push('</g>');
  return { svg: parts.join(''), height: ly + 12 };
}

/**
 * CAN THIS BE MEASURED AT ALL, AND WHERE? The gate, across every repository it has been run on.
 *
 * The panel above establishes that the body carries the explanation. This one asks the follow-up a
 * reader will have immediately: how many real repositories still have a body by the time a change
 * lands. It is the honest answer to "does this work on my codebase" — a measured pass rate with the
 * failures named, rather than a claim of universality. A repository below the floor is REFUSED
 * rather than coloured and hedged, which is why the failures are drawn in the same panel as the
 * passes instead of being left out of the poster.
 *
 * Verdict is categorical, so it gets hues; the bar length is the measured share. Repositories are
 * public projects, not people, and naming them is what makes the claim checkable.
 */
function gatePanel(d: GateRow[], x: number, y: number, w: number): PanelResult {
  if (d.length === 0) return { svg: '', height: 0 };
  const parts: string[] = [];
  const sorted = [...d].sort((a, b) => b.substantiveShare - a.substantiveShare);
  const pass = sorted.filter((r) => r.verdict === 'pass').length;
  const fail = sorted.filter((r) => r.verdict === 'fail').length;
  const weak = sorted.length - pass - fail;

  parts.push(`<g transform="translate(${f(x)},${f(y)})">`);
  parts.push(text(0, 0, 'where the record can be measured at all', 'panelTitle'));
  parts.push(
    text(
      0,
      19,
      `${sorted.length} large open-source repositories, by the share of their last 200 commits carrying a body`,
      'panelSub'
    )
  );

  // Two columns of bars, because 24 rows in one column would be taller than the panels beside it.
  const cols = 2;
  const colW = (w - 40) / cols;
  const per = Math.ceil(sorted.length / cols);
  const rowH = 21;
  const labelW = 206;
  const barW = colW - labelW - 52;
  const top = 46;
  const hueFor = (v: string): string => (v === 'pass' ? TEAL : v === 'weak' ? AMBER : CORAL);

  sorted.forEach((r, i) => {
    const c = Math.floor(i / per);
    const ri = i % per;
    const bx = c * (colW + 40);
    const by = top + ri * rowH;
    parts.push(text(bx, by + 11, r.repo, 'repoName'));
    parts.push(rect(bx + labelW, by + 1, barW, 13, '#dceaf0'));
    parts.push(rect(bx + labelW, by + 1, Math.max(1.5, barW * r.substantiveShare), 13, hueFor(r.verdict)));
    parts.push(text(bx + labelW + barW + 8, by + 11, pctLabel(r.substantiveShare), 'tickStrong'));
    // The two thresholds, drawn on every bar so the verdict is visibly a rule and not a judgement.
    for (const th of [0.1, 0.25]) {
      parts.push(
        `<line x1="${f(bx + labelW + barW * th)}" y1="${f(by)}" x2="${f(bx + labelW + barW * th)}" y2="${f(by + 15)}" stroke="${NAVY}" stroke-width="1" opacity="0.35"/>`
      );
    }
  });

  const ly = top + per * rowH + 16;
  const chips: [string, string, number][] = [
    ['measurable', TEAL, pass],
    ['weak evidence', AMBER, weak],
    ['refused', CORAL, fail],
  ];
  let cx = 0;
  for (const [label, hue, n] of chips) {
    parts.push(rect(cx, ly, 12, 12, hue));
    const t = `${label} — ${n}`;
    parts.push(text(cx + 18, ly + 11, t, 'lbl'));
    cx += 22 + t.length * 7.4 + 26;
  }
  parts.push(
    text(0, ly + 32, 'the two rules on every bar: 25% for a full estimate, 10% below which no map is drawn', 'tick')
  );
  parts.push('</g>');
  return { svg: parts.join(''), height: ly + 44 };
}

/**
 * WHERE THE GAP IS — and where it closes. This panel was drafted twice on claims the data refused.
 *
 * DRAFT ONE said "length is not comprehension", which is the intuition. The correlation, computed at
 * render time, came back r = 0.66, and r = 0.49 within the 711 substantive records alone: length is
 * strongly associated with coverage and the headline contradicted the chart under it.
 *
 * DRAFT TWO said the opposite — that at comparable length a model's account from the diff explains
 * far more, so length is not the binding constraint. That was checked before it was drawn, and it is
 * also false: among records of 900 to 1,700 characters, real and synthetic medians are IDENTICAL at
 * 66.7%, and over the longest hundred records the real record wins, 75% against 33%.
 *
 * WHAT THE DATA ACTUALLY SHOWS is better than either draft, and it is drawn rather than asserted: two
 * median lines that CROSS. In the short bins the model's account is far ahead; from roughly 1.5k
 * characters on, the written record catches it and passes it. The headline gap is therefore not a gap
 * in people's ability to explain their own changes — where a real explanation exists, it does the job.
 * It is a gap in whether one gets written at all, which is a different problem with a different fix.
 *
 * THE CONFOUND, STATED ON THE PANEL: longer records also describe bigger changes, and the study
 * measured the synthetic arm getting worse as changes get bigger (66.7% at 20-49 lines against 38.5%
 * at 500+). Part of the crossing is that. The panel says so rather than letting a reader take the
 * crossing for a pure length effect.
 *
 * The x axis is log, because record length spans four orders of magnitude.
 */
function lengthPanel(d: PosterData, x: number, y: number, w: number, h: number): PanelResult {
  const set = d.prs.filter((p) => p.recordChars > 0);
  if (set.length < 10) return { svg: '', height: 0 };
  const parts: string[] = [];
  parts.push(`<g transform="translate(${f(x)},${f(y)})">`);
  parts.push(text(0, 0, 'where the gap is — and where it closes', 'panelTitle'));
  parts.push(
    text(0, 19, `${set.length} records by length, against the model's account of the same change`, 'panelSub')
  );

  const plotX = 46;
  const plotY = 40;
  const plotW = w - plotX - 14;
  const plotH = h - plotY - 46;
  const lx = (chars: number) => {
    const lo = Math.log10(20);
    const hi = Math.log10(Math.max(200, ...set.map((p) => p.recordChars)));
    return plotX + ((Math.log10(Math.max(20, chars)) - lo) / (hi - lo)) * plotW;
  };
  const ly = (v: number) => plotY + plotH - v * plotH;

  for (const g of [0, 0.25, 0.5, 0.75, 1]) {
    parts.push(
      `<line x1="${f(plotX)}" y1="${f(ly(g))}" x2="${f(plotX + plotW)}" y2="${f(ly(g))}" stroke="#d3e2e9" stroke-width="1"/>`
    );
    parts.push(text(plotX - 8, ly(g) + 4, pctLabel(g), 'tick', ' text-anchor="end"'));
  }
  for (const p of set) {
    parts.push(
      `<circle cx="${f(lx(p.recordChars))}" cy="${f(ly(p.real))}" r="2.6" fill="${colourFor(p.real)}" opacity="0.72"/>`
    );
  }
  // Median coverage within length bins, for BOTH arms, drawn on top: the eye cannot median a point
  // cloud, and the whole point of the panel is where the two medians cross.
  const sorted = [...set].sort((a, b) => a.recordChars - b.recordChars);
  const binsN = 8;
  const line = (pick: (p: PrRow) => number): string[] => {
    const out: string[] = [];
    for (let i = 0; i < binsN; i++) {
      const slice = sorted.slice(
        Math.floor((i * sorted.length) / binsN),
        Math.floor(((i + 1) * sorted.length) / binsN)
      );
      if (slice.length === 0) continue;
      out.push(`${f(lx(median(slice.map((p) => p.recordChars))))},${f(ly(median(slice.map(pick))))}`);
    }
    return out;
  };
  const arms: [string, string, (p: PrRow) => number][] = [
    ['the model, from the diff alone', AMBER, (p) => p.synthetic],
    ['the record as written', NAVY, (p) => p.real],
  ];
  for (const [label, stroke, pick] of arms) {
    const pts = line(pick);
    parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${stroke}" stroke-width="3"/>`);
    for (const pt of pts) {
      const [cx, cy] = pt.split(',');
      parts.push(`<circle cx="${cx}" cy="${cy}" r="4.5" fill="${stroke}" stroke="${PAGE}" stroke-width="1.5"/>`);
    }
    // Label each line on its OWN curve rather than both at the right edge, where they converge and
    // one label lands on the other's line.
    const anchor = stroke === NAVY ? pts[pts.length - 1] : pts[Math.min(1, pts.length - 1)];
    if (anchor) {
      const [cx, cy] = anchor.split(',').map(Number);
      const end = stroke === NAVY;
      parts.push(
        text(
          end ? cx! - 8 : cx! + 10,
          end ? cy! - 12 : cy! - 14,
          label,
          'lineLabel',
          ` fill="${stroke}" text-anchor="${end ? 'end' : 'start'}"`
        )
      );
    }
  }

  const logChars = (p: PrRow) => Math.log10(Math.max(20, p.recordChars));
  const rAll = pearson(set.map(logChars), set.map((p) => p.real));
  const subst = set.filter((p) => p.tier === 'substantive');
  const rSub = subst.length > 10 ? pearson(subst.map(logChars), subst.map((p) => p.real)) : null;

  // The correlations sit INSIDE the plot, top-left. Below the axis they collided with the captions.
  parts.push(
    text(
      plotX + 10,
      plotY + 16,
      rAll === null ? 'correlation undefined' : `length vs coverage: r = ${rAll.toFixed(2)} over all ${set.length}`,
      'tickStrong'
    )
  );
  parts.push(
    text(
      plotX + 10,
      plotY + 32,
      rSub === null
        ? 'no substantive subset to restrict to'
        : `r = ${rSub.toFixed(2)} among the ${subst.length} substantive alone, so it is not only that empty records are short`,
      'tick'
    )
  );
  parts.push(text(plotX, plotY + plotH + 22, 'record length, characters (log)', 'tick'));
  // The band where the two medians are indistinguishable, measured rather than eyeballed.
  const band = set.filter((p) => p.recordChars >= 900 && p.recordChars <= 1700);
  if (band.length > 20) {
    parts.push(
      text(
        plotX,
        plotY + plotH + 44,
        `at 900-1,700 characters the two medians are the same: ${pctLabel(median(band.map((p) => p.real)))} ` +
          `and ${pctLabel(median(band.map((p) => p.synthetic)))} over ${band.length} records.`,
        'tick'
      )
    );
    parts.push(
      text(plotX, plotY + plotH + 60, 'Where an explanation exists, it does the job.', 'tickStrong')
    );
  }
  parts.push(
    text(
      plotX,
      plotY + plotH + 78,
      'Longer records also describe bigger changes, and the model gets worse as changes grow.',
      'tick'
    )
  );
  parts.push('</g>');
  return { svg: parts.join(''), height: h + 60 };
}

/**
 * FROM PULL REQUESTS TO CODE. One repository's directories, measured the same way.
 *
 * The corpus panels are about changes; a team acts on places. Each dot is a directory-level area of
 * one repository, positioned by the share of mechanism questions its commits answer, sized by the
 * questions the estimate rests on, and hollow where the estimate is too thin to colour. Vertical
 * position is a deterministic spread to stop overlap and carries no meaning — stated on the panel,
 * because an unexplained second axis will be read as one.
 */
function regionPanel(d: PosterData, x: number, y: number, w: number, h: number): PanelResult {
  if (d.regions.length === 0) return { svg: '', height: 0 };
  const scored = d.regions.filter((r) => r.coverage !== null);
  const parts: string[] = [];
  parts.push(`<g transform="translate(${f(x)},${f(y)})">`);
  parts.push(text(0, 0, `inside one repository — ${d.regionRepo}`, 'panelTitle'));
  parts.push(
    text(
      0,
      19,
      `${d.regions.length} directory areas, ${d.regionQuestions.toLocaleString('en-US')} questions asked of their commits`,
      'panelSub'
    )
  );

  const axY = y === 0 ? 0 : 0; // keep the linter honest; geometry below is all local
  const plotX = 8;
  const plotW = w - 130;
  const top = 46;
  const bandH = h - top - 52;
  const maxCov = Math.max(0.35, ...scored.map((r) => r.coverage!));
  const sx = (v: number) => plotX + (v / maxCov) * plotW;

  for (let i = 0; i <= 5; i++) {
    const v = (maxCov * i) / 5;
    parts.push(
      `<line x1="${f(sx(v))}" y1="${f(top)}" x2="${f(sx(v))}" y2="${f(top + bandH)}" stroke="#d3e2e9" stroke-width="1"/>`
    );
    parts.push(text(sx(v), top + bandH + 20, pctLabel(v), 'tick', ' text-anchor="middle"'));
  }

  // Deterministic vertical spread, hashed from the PATH rather than from the sort index. Indexing it
  // made the offset a function of coverage, which drew visible diagonal stripes — an artefact of the
  // jitter that reads as structure in the data. Hashing the name breaks that correlation and still
  // gives the same picture on every run.
  const ordered = [...d.regions].sort((a, b) => (a.coverage ?? -1) - (b.coverage ?? -1));
  ordered.forEach((r) => {
    const cov = r.coverage;
    let hash = 2166136261;
    for (let k = 0; k < r.path.length; k++) {
      hash ^= r.path.charCodeAt(k);
      hash = (hash * 16777619) >>> 0;
    }
    const cy = top + 14 + ((hash % 10000) / 10000) * (bandH - 28);
    const rad = 4 + Math.sqrt(Math.max(1, r.questions)) * 0.62;
    if (cov === null) return;
    if (r.thin) {
      parts.push(
        `<circle cx="${f(sx(cov))}" cy="${f(cy)}" r="${f(rad)}" fill="none" stroke="#8fa6b3" stroke-width="1.6" stroke-dasharray="3 2"/>`
      );
      return;
    }
    if (r.ciLo !== null && r.ciHi !== null) {
      parts.push(
        `<line x1="${f(sx(r.ciLo))}" y1="${f(cy)}" x2="${f(sx(Math.min(maxCov, r.ciHi)))}" y2="${f(cy)}" stroke="${NAVY}" stroke-width="1" opacity="0.28"/>`
      );
    }
    parts.push(
      `<circle cx="${f(sx(cov))}" cy="${f(cy)}" r="${f(rad)}" fill="${colourFor(cov)}" stroke="${NAVY}" stroke-width="0.8"/>`
    );
  });

  const rx = w - 112;
  parts.push(text(rx, top + 6, 'each dot is', 'tick'));
  parts.push(text(rx, top + 22, 'one directory', 'tickStrong'));
  parts.push(text(rx, top + 44, 'size = questions', 'tick'));
  parts.push(text(rx, top + 60, 'behind the estimate', 'tick'));
  parts.push(
    `<circle cx="${f(rx + 8)}" cy="${f(top + 84)}" r="7" fill="none" stroke="#8fa6b3" stroke-width="1.6" stroke-dasharray="3 2"/>`
  );
  parts.push(text(rx + 22, top + 88, 'too thin', 'tick'));
  parts.push(text(rx, top + 108, 'to colour', 'tick'));
  parts.push(
    text(plotX, top + bandH + 40, 'vertical position is spread to avoid overlap and means nothing', 'tick')
  );
  parts.push('</g>');
  void axY;
  return { svg: parts.join(''), height: h };
}

// ── THE POSTER ────────────────────────────────────────────────────────────────────────────────

export interface PosterOpts {
  width?: number;
  /** Printed in the footer so a reader can date the numbers. */
  stamp?: string;
  /** Provenance line: where the numbers come from. */
  source?: string;
}

export function renderPoster(d: PosterData, opts: PosterOpts = {}): string {
  const W = opts.width ?? 1640;
  const M = 58;
  const inner = W - 2 * M;

  const all = d.prs.map((p) => p.real);
  const syn = d.prs.map((p) => p.synthetic);
  const zeroShare = share(all, (v) => v === 0);

  const body: string[] = [];

  // ── HERO BAND ────────────────────────────────────────────────────────────────────────────
  const heroH = 268;
  body.push(rect(0, 0, W, heroH, NAVY));
  body.push(`<g clip-path="url(#heroClip)">${ditherBand(W, heroH)}</g>`);
  body.push(text(M, 96, 'What the record', 'hero'));
  body.push(text(M, 168, "doesn't say", 'hero'));
  body.push(
    text(
      M,
      212,
      `${d.prs.length.toLocaleString('en-US')} merged pull requests, scored question by question`,
      'heroSub'
    )
  );
  // The single number, on the quiet side of the band.
  const kx = W - M;
  body.push(text(kx, 118, pctLabel(zeroShare, 1), 'heroNum', ' text-anchor="end"'));
  body.push(text(kx, 148, 'explain none of their own mechanism', 'heroSub', ' text-anchor="end"'));
  body.push(
    text(
      kx,
      176,
      `a model reading only the diff explains ${pctLabel(mean(syn), 0)} of it`,
      'heroSub',
      ' text-anchor="end"'
    )
  );

  let y = heroH + 56;

  // ── LEGEND ───────────────────────────────────────────────────────────────────────────────
  body.push(coverageLegend(M, y, 320));
  body.push(
    text(
      M + 380,
      y + 4,
      `One square is one merged pull request. All three panels below hold the same ${d.prs.length.toLocaleString('en-US')} changes,`,
      'lead'
    )
  );
  body.push(
    text(
      M + 380,
      y + 26,
      'each sorted by its own score — so the shapes are distributions, and only the record being read changes.',
      'lead'
    )
  );
  y += 74;

  // ── TRIPTYCH ─────────────────────────────────────────────────────────────────────────────
  const tri = triptych(d, M, y, inner);
  body.push(tri.svg);
  y += tri.height + 54;

  body.push(`<line x1="${f(M)}" y1="${f(y)}" x2="${f(W - M)}" y2="${f(y)}" stroke="#c6d8e1" stroke-width="1"/>`);
  y += 44;

  // ── ROW: PROVENANCE | ABLATION ───────────────────────────────────────────────────────────
  const colGap = 54;
  const halfW = (inner - colGap) / 2;
  const prov = provenancePanel(d, M, y, halfW);
  const abl = ablationPanel(d, M + halfW + colGap, y, halfW, 240);
  body.push(prov.svg);
  body.push(abl.svg);
  // The per-project panel goes UNDER the ablation panel rather than in a row of its own: the
  // provenance column is much the taller of the two and the right column had a block of dead page
  // beneath it.
  const repos = repoPanel(d, M + halfW + colGap, y + abl.height + 34, halfW);
  body.push(repos.svg);
  y += Math.max(prov.height, abl.height + 34 + repos.height) + 52;

  body.push(`<line x1="${f(M)}" y1="${f(y)}" x2="${f(W - M)}" y2="${f(y)}" stroke="#c6d8e1" stroke-width="1"/>`);
  y += 44;

  // ── ROW: THE GATE, FULL WIDTH ────────────────────────────────────────────────────────────
  const gate = gatePanel(d.gate, M, y, inner);
  if (gate.height > 0) {
    body.push(gate.svg);
    y += gate.height + 46;
    body.push(
      `<line x1="${f(M)}" y1="${f(y)}" x2="${f(W - M)}" y2="${f(y)}" stroke="#c6d8e1" stroke-width="1"/>`
    );
    y += 44;
  }

  // ── ROW: LENGTH | REGIONS ────────────────────────────────────────────────────────────────
  const rowH = 300;
  const len = lengthPanel(d, M, y, halfW, rowH);
  const reg = regionPanel(d, M + halfW + colGap, y, halfW, rowH);
  body.push(len.svg);
  body.push(reg.svg);
  y += Math.max(len.height, reg.height, rowH) + 46;

  // ── FOOTER ───────────────────────────────────────────────────────────────────────────────
  const footH = 118;
  body.push(rect(0, y, W, footH, NAVY_DEEP));
  const fy = y + 34;
  body.push(
    text(
      M,
      fy,
      'Questions are generated from the diff alone; a second model scores the written record against them and never sees the code.',
      'foot'
    )
  );
  body.push(
    text(
      M,
      fy + 24,
      'A tripped separation guard aborts the run rather than warning. Explicit means the record answers the question outright, not that a reader could infer it.',
      'foot'
    )
  );
  body.push(
    text(
      M,
      fy + 48,
      opts.source ??
        'Source: study/results/three-arm-scores.csv, unit-mismatch-scores.csv, and the record map JSON. Every number here is computed from those files at render time.',
      'footDim'
    )
  );
  if (d.missing.length > 0) {
    body.push(text(M, fy + 70, `Omitted for want of data: ${d.missing.join(', ')}`, 'footDim'));
  }
  if (opts.stamp) body.push(text(W - M, fy, opts.stamp, 'footDim', ' text-anchor="end"'));
  // The wordmark: "reckon" in ice, "review" in the teal that carries it on the site.
  body.push(
    `<text x="${f(W - M)}" y="${f(fy + 46)}" text-anchor="end"><tspan class="markA">reckon</tspan><tspan class="markB">review</tspan><tspan class="markC">  ·  reckonreview.dev</tspan></text>`
  );

  const H = y + footH;

  const style = [
    `.hero{font:700 62px ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:${ICE};letter-spacing:-1.2px}`,
    `.heroSub{font:400 17px ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:${HERO_SUB}}`,
    `.heroNum{font:700 64px ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:${AMBER_LIGHT};letter-spacing:-1.5px}`,
    `.lead{font:400 17px ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:${INK}}`,
    `.panelTitle{font:700 20px ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:${INK}}`,
    `.panelSub{font:400 14px ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:${MUTED}}`,
    `.bigNum{font:700 40px ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:${NAVY};letter-spacing:-1px}`,
    `.bigNumSm{font:700 26px ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:${NAVY}}`,
    `.barNum{font:700 16px ui-monospace,SFMono-Regular,Menlo,monospace;fill:${INK}}`,
    `.lbl{font:400 14px ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:${MUTED}}`,
    `.tick{font:400 12px ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:${MUTED}}`,
    `.tickStrong{font:600 12.5px ui-monospace,SFMono-Regular,Menlo,monospace;fill:${INK}}`,
    `.repoName{font:400 13px ui-monospace,SFMono-Regular,Menlo,monospace;fill:${INK}}`,
    `.segNum{font:700 12.5px ui-monospace,SFMono-Regular,Menlo,monospace}`,
    `.lineLabel{font:700 12.5px ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}`,
    `.foot{font:400 14px ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:#c6dde8}`,
    `.markA{font:700 20px ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:${ICE}}`,
    `.markB{font:700 20px ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:#6fb3cc}`,
    `.markC{font:400 13px ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:#7fa2b5}`,
    `.footDim{font:400 12.5px ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:#7fa2b5}`,
  ].join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(W)} ${f(H)}" width="${f(W)}" height="${f(H)}" role="img" aria-label="What the record does not say: record coverage across ${d.prs.length} merged pull requests and ${d.regions.length} directory areas">`,
    `<defs><clipPath id="heroClip"><rect x="0" y="0" width="${f(W)}" height="${f(heroH)}"/></clipPath></defs>`,
    `<style>${style}</style>`,
    rect(0, 0, W, H, PAGE),
    body.join(''),
    '</svg>',
  ].join('\n');
}

/**
 * Contrast pairs the tests assert, each with THE FLOOR THAT APPLIES TO IT.
 *
 * Not one blanket 4.5. WCAG's AA threshold is 4.5:1 for body text and 3:1 for large text — 24px, or
 * 18.66px bold — and the distinction is not a loophole: the ratio exists because thin strokes at
 * small sizes lose legibility faster. The 64px bold hero number genuinely sits under the large-text
 * rule. Writing the floor next to each pair means the exemption is visible and argued rather than
 * quietly assumed, and it means the test still holds every small label to 4.5.
 *
 * Backgrounds are the WORST CASE, not the nominal one: text over the hero band is checked against a
 * fully-opaque dither cell, because that is the lightest thing under it.
 */
export const CONTRAST_PAIRS: [string, string, string, number][] = [
  ['hero title on the band (62px bold)', ICE, NAVY, 3],
  ['hero title over the densest dither (62px bold)', ICE, ditherOver(NAVY), 3],
  ['hero number on the band (64px bold)', AMBER_LIGHT, NAVY, 3],
  ['hero number over the densest dither (64px bold)', AMBER_LIGHT, ditherOver(NAVY), 3],
  ['hero subtitle over the densest dither (17px)', HERO_SUB, ditherOver(NAVY), 4.5],
  ['panel title on the page', INK, PAGE, 4.5],
  ['muted label on the page', MUTED, PAGE, 4.5],
  ['footer text on the deep band', '#c6dde8', NAVY_DEEP, 4.5],
  ['footer provenance line on the deep band', '#7fa2b5', NAVY_DEEP, 4.5],
  ['tier count on the substantive segment', inkOn(TEAL), TEAL, 4.5],
  ['tier count on the trivial segment', inkOn(AMBER_LIGHT), AMBER_LIGHT, 4.5],
  ['tier count on the empty segment', inkOn(CORAL), CORAL, 4.5],
];

export { contrastRatio };
