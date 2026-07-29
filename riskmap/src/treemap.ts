/**
 * The region map — squarified treemap layout, and a static SVG renderer for it.
 *
 * One rectangle per region. AREA is how much code changed there. COLOUR is how much of that
 * change the written record actually explains. That is the whole artifact.
 *
 * THREE RULES THIS FILE EXISTS TO ENFORCE, in the order they would otherwise be broken:
 *
 * 1. COLOUR IS THE ABSOLUTE COVERAGE SHARE, NEVER A PERCENTILE. "Your commit history explains
 *    18% of what changed here" is legible and hard to argue with. "34th percentile" invites
 *    "against which corpus, and why those five repositories" — an argument about the corpus
 *    instead of about the codebase. Percentiles belong in the table, where the corpus can be
 *    described in the same breath; a heatmap has no room for that caveat.
 *
 * 2. A THIN ESTIMATE IS GREYED AND HATCHED, NEVER COLOURED. This is the single most likely way
 *    this artifact ships something false. A table shows `n=2` next to a number and the reader
 *    discounts it; a heatmap paints the same number as a confident block of colour and the
 *    uncertainty disappears. So a cell resting on too few commits, or carrying too wide an
 *    interval, is dropped out of the colour scale entirely and marked with a hatch that cannot
 *    be mistaken for a mid-scale value at any zoom or in any print.
 *
 * 3. IT IS A MAP OF WHAT THE RECORD EXPLAINS, NEVER OF WHAT ANYONE UNDERSTOOD. The study this
 *    calibrates against argues specifically that the written record cannot be evidence that a
 *    human understood a change. A legend reading "understood" would contradict the project's own
 *    central claim inside the same picture. The words are "explained by the commit record" and
 *    "unexplained by the commit record", everywhere, without exception.
 *
 * AND ONE ABSENCE, WHICH IS THE POINT: this artifact carries NO PERSON DATA AT ALL. No
 * contributor counts, no ownership share, no departure proxy — nothing derived from a person.
 * That is what makes it the one part of this tool with no naming problem to work around. Do not
 * add a person-derived field here, however useful it looks.
 *
 * Rendering constraints, matching render.ts: self-contained output, no external references, no
 * scripts, no fonts beyond generic families, and deterministic — the same input must produce the
 * same bytes, or "the same clone yields the same map" stops being true.
 */

// ---------------------------------------------------------------------------------------------
// The input contract. Supplied by the caller; not this module's business how it was computed.
// ---------------------------------------------------------------------------------------------

export interface TreemapCell {
  /** Region path, e.g. "pkg/services". Never contains a person's name. */
  path: string;
  /** > 0. Area is proportional to this. (Lines changed in the window.) */
  weight: number;
  /** [0,1] share of mechanism questions the record answers. null = not scored. */
  coverage: number | null;
  /** Half-width of the interval on `coverage`. null when unscored. */
  ciHalfWidth: number | null;
  /** How many commits the estimate rests on. */
  scoredCommits: number;
  /** Changed recently — carried by the BORDER, not by colour or size. */
  active: boolean;
}

/** One laid-out rectangle. Geometry only. */
export interface TreemapRect {
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------------------------
// The greying rule. Exported because it is a claim about evidence, and a reader who disagrees
// with it should be able to point at the number they disagree with.
// ---------------------------------------------------------------------------------------------

/**
 * Below this many scored commits the cell is greyed rather than coloured.
 *
 * Three commits can produce a coverage of exactly 0.00 or exactly 1.00, and either one painted
 * at full saturation is a lie about how much is known.
 */
export const MIN_SCORED_COMMITS = 4;

/**
 * Above this interval half-width the cell is greyed rather than coloured.
 *
 * 0.15 is a third of the usable range: an estimate that could be 0.20 or 0.50 does not have a
 * colour, it has a range, and a heatmap cannot draw a range.
 */
export const MAX_CI_HALF_WIDTH = 0.15;

/** Number of steps in the colour ramp. Ten, so every anchor is a round ten per cent. */
export const COVERAGE_STEPS = 10;

/**
 * Is this cell's estimate too thin to colour? Grey when there is no estimate, when it rests on
 * too few commits, or when its interval is too wide to point at a single hue.
 */
export function isThinEstimate(cell: TreemapCell): boolean {
  if (cell.coverage === null) return true;
  if (cell.scoredCommits < MIN_SCORED_COMMITS) return true;
  if (cell.ciHalfWidth !== null && cell.ciHalfWidth > MAX_CI_HALF_WIDTH) return true;
  return false;
}

/** Which ramp step an absolute coverage share falls in. Never a percentile. [0, COVERAGE_STEPS) */
export function coverageStep(coverage: number): number {
  const c = coverage < 0 ? 0 : coverage > 1 ? 1 : coverage;
  const i = Math.floor(c * COVERAGE_STEPS);
  return i >= COVERAGE_STEPS ? COVERAGE_STEPS - 1 : i;
}

// ---------------------------------------------------------------------------------------------
// Layout — squarified treemap (Bruls, Huizing, van Wijk 2000).
//
// Slice-and-dice would be four lines shorter and useless: with a realistic weight distribution
// it produces slivers a hundred times longer than they are wide, which cannot be compared by
// area, cannot hold a label, and cannot be clicked. Aspect ratios near 1 are the entire reason
// to write this.
// ---------------------------------------------------------------------------------------------

interface Free {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The worst (largest) aspect ratio in a row of `to - from` items laid along `side`.
 *
 * The row's thickness is fixed by its total area, so the largest item is the flattest and the
 * smallest is the thinnest; checking those two bounds the whole row.
 */
function worstRatio(areas: number[], from: number, to: number, sum: number, side: number): number {
  let min = Infinity;
  let max = 0;
  for (let i = from; i < to; i++) {
    const a = areas[i];
    if (a < min) min = a;
    if (a > max) max = a;
  }
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/**
 * Lay `cells` out in a `width` x `height` canvas, largest first, and return one rectangle per
 * cell. Area is exactly proportional to weight and the rectangles exactly tile the canvas.
 *
 * Sorted descending by weight, tie-broken by path, so the output is a pure function of the input
 * set and not of the order it happened to arrive in.
 */
export function squarify(cells: TreemapCell[], width: number, height: number): TreemapRect[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`squarify: canvas must be finite and positive, got ${width}x${height}`);
  }
  if (cells.length === 0) return [];

  for (const c of cells) {
    if (!Number.isFinite(c.weight) || c.weight <= 0) {
      // Not tolerated rather than dropped. A dropped cell silently breaks the one property the
      // reader relies on — that area is comparable across the whole picture — and the caller
      // cannot see that it happened.
      throw new Error(`squarify: weight must be finite and > 0, got ${c.weight} for ${c.path}`);
    }
  }

  const order = [...cells].sort((a, b) => (b.weight - a.weight) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  let total = 0;
  for (const c of order) total += c.weight;
  const scale = (width * height) / total;
  const areas = order.map((c) => c.weight * scale);

  const out: TreemapRect[] = [];
  const free: Free = { x: 0, y: 0, w: width, h: height };
  const n = order.length;
  let start = 0;

  while (start < n) {
    if (free.w <= 0 || free.h <= 0) {
      // Unreachable while area remains: every row consumes exactly its own area. Guarded so a
      // future change to the snapping below cannot turn a rounding slip into an infinite loop.
      throw new Error('squarify: the free rectangle collapsed with cells still to place');
    }

    const side = Math.min(free.w, free.h);

    // Grow the row while adding the next cell improves the worst aspect ratio in it. The first
    // cell always joins: a row of one is the baseline everything else is measured against.
    let end = start + 1;
    let sum = areas[start];
    let best = worstRatio(areas, start, end, sum, side);
    while (end < n) {
      const nextSum = sum + areas[end];
      const cand = worstRatio(areas, start, end + 1, nextSum, side);
      if (cand > best) break;
      best = cand;
      sum = nextSum;
      end++;
    }

    const lastRow = end === n;
    const alongHeight = free.h <= free.w; // the row runs down the left edge rather than across the top

    // Thickness follows from the row's area, except on the final row, where it is snapped to
    // whatever is left. The two agree to within float error; snapping means the canvas is tiled
    // exactly rather than nearly, so "no gaps" and "area conserved" hold as equalities.
    let thickness = sum / side;
    if (lastRow) thickness = alongHeight ? free.w : free.h;

    let offset = alongHeight ? free.y : free.x;
    const limit = alongHeight ? free.y + free.h : free.x + free.w;

    for (let i = start; i < end; i++) {
      const extent = areas[i] / thickness;
      // The last cell in the row is snapped to the row's end for the same reason.
      const next = i === end - 1 ? limit : offset + extent;
      out.push(
        alongHeight
          ? { path: order[i].path, x: free.x, y: offset, w: thickness, h: next - offset }
          : { path: order[i].path, x: offset, y: free.y, w: next - offset, h: thickness }
      );
      offset = next;
    }

    if (alongHeight) {
      free.x += thickness;
      free.w -= thickness;
    } else {
      free.y += thickness;
      free.h -= thickness;
    }
    start = end;
  }

  return out;
}

/** Aspect ratio of a rectangle, always >= 1. 1 is a square, which is what squarifying is for. */
export function aspectRatio(r: TreemapRect): number {
  if (r.w <= 0 || r.h <= 0) return Infinity;
  return r.w >= r.h ? r.w / r.h : r.h / r.w;
}

// ---------------------------------------------------------------------------------------------
// Colour.
//
// A sequential ramp on the ABSOLUTE coverage share. Low coverage is alarming, high coverage is
// calm, and the value is carried by LIGHTNESS as much as by hue so it survives greyscale
// printing and every form of colour blindness. Nothing here needs red-against-green
// discrimination: the ramp is a single warm-to-neutral sweep with monotone luminance, so the
// two ends differ in brightness even when they do not differ in hue to the reader.
//
// The two themes invert the direction of lightness on purpose, because what encodes alarm is
// CONTRAST AGAINST THE PAGE, and the page flips:
//
//   light theme — low coverage is dark and heavy, high coverage is pale and recedes into white
//   dark theme  — low coverage is bright and hot, high coverage sinks towards the background
//
// So in both themes an unexplained region is the thing your eye lands on first, and luminance is
// monotone in coverage within each theme (ascending in one, descending in the other), which is
// what the greyscale claim rests on. There is a test for that monotonicity.
// ---------------------------------------------------------------------------------------------

type RGB = [number, number, number];

function hex(c: RGB): string {
  return (
    '#' +
    c
      .map((v) => {
        const n = Math.max(0, Math.min(255, Math.round(v)));
        return n.toString(16).padStart(2, '0');
      })
      .join('')
  );
}

function parseHex(s: string): RGB {
  return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
}

/** Ramp through hand-picked control stops, sampled to COVERAGE_STEPS. Deterministic by construction. */
function ramp(stops: string[], steps: number): string[] {
  const pts = stops.map(parseHex);
  const out: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : (i / (steps - 1)) * (pts.length - 1);
    const lo = Math.min(pts.length - 1, Math.floor(t));
    const hi = Math.min(pts.length - 1, lo + 1);
    const f = t - lo;
    out.push(hex([0, 1, 2].map((k) => pts[lo][k] + (pts[hi][k] - pts[lo][k]) * f) as RGB));
  }
  return out;
}

/** WCAG relative luminance. Used to pick label colours, and asserted monotone in the tests. */
export function relativeLuminance(color: string): number {
  const [r, g, b] = parseHex(color).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * THE BRAND RAMP, and why it runs dark-to-pale rather than red-to-green.
 *
 * Reckon's palette is a single blue family: deep navy through the mid teal that carries the
 * wordmark and the install button, out to a pale ice. That is a sequential scale by nature, which
 * is exactly the right shape for this quantity — coverage is one ordered thing from "nothing
 * written down" to "fully explained", not two opposed categories.
 *
 * A red-to-green diverging scale would have been wrong twice over: it implies a neutral midpoint
 * this quantity does not have, and it is the least accessible choice available, since red-green
 * deficiency is the common one. A monochrome blue ramp stays readable under every form of colour
 * vision deficiency, because the signal is carried by lightness rather than by hue.
 *
 * DIRECTION: dark is unexplained, pale is explained. Dark reads as unlit territory, and it keeps
 * the heaviest ink on the cells a reader should look at first. The dark-mode ramp inverts
 * luminance rather than hue, so an unexplained cell still stands out against a dark page instead
 * of disappearing into it.
 */
const BRAND_NAVY = '#0d2f4a';
const BRAND_TEAL = '#4a90ab';
const BRAND_ICE = '#eaf3f7';

/** Low coverage (unexplained, deep navy) to high (explained, pale ice). Luminance ascending. */
export const LIGHT_RAMP: string[] = ramp(
  [BRAND_NAVY, '#1b5476', '#2f7897', BRAND_TEAL, '#86bacd', '#c3dde8', BRAND_ICE],
  COVERAGE_STEPS
);

/** Low coverage (unexplained, bright) to high (explained, sunk into the page). Luminance descending. */
export const DARK_RAMP: string[] = ramp(
  ['#bfe0ed', '#93c6d9', BRAND_TEAL, '#3a7691', '#2a5670', '#1a3a4e', '#121a22'],
  COVERAGE_STEPS
);

/** Near-black ink, for the pale end of a ramp. */
const INK_ON_LIGHT = '#0b1f30';
/** Near-white ink, for the dark end of a ramp. */
const INK_ON_DARK = '#f2f8fb';

/**
 * Where to switch between the two inks.
 *
 * NOT the middle of the range. Contrast is a ratio of (L + 0.05), so the point where near-black
 * and near-white are equally legible sits at L ≈ 0.19, not at 0.5 — picking the midpoint puts
 * white text on a mid-ramp orange at about 2:1, which is unreadable, and the label would be lost
 * on exactly the cells large enough to carry one. The crossover value is the worst case, and the
 * tests assert what that worst case actually is.
 */
const INK_CROSSOVER = 0.19;

/** Label colour for a fill: whichever of the two inks has more contrast against it. */
function inkFor(fill: string): string {
  return relativeLuminance(fill) > INK_CROSSOVER ? INK_ON_LIGHT : INK_ON_DARK;
}

/** WCAG contrast ratio between two colours. Used to keep every label legible on its own cell. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The label colour this module would put on a given ramp fill. Exported so a test can check it. */
export function labelInkFor(fill: string): string {
  return inkFor(fill);
}

// ---------------------------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------------------------

export interface TreemapOptions {
  /** Total SVG width. Default 960. */
  width?: number;
  /** Height of the map itself, excluding heading and legend. Default 560. */
  height?: number;
  /** Heading above the map. Pass null for none. */
  title?: string | null;
  /** One line under the heading — repo, window, commit count. Pass null for none. */
  subtitle?: string | null;
  /**
   * Prefix for the element ids and for the scoping of the embedded CSS. Change it only to put
   * two of these on one page; it must stay stable across runs or the output stops being
   * byte-identical.
   */
  idPrefix?: string;
}

/**
 * Escape everything that reaches the SVG. A region path can legitimately contain `&` and `<` —
 * `a&b/<generated>` is a valid directory name — and one unescaped ampersand makes the whole
 * document unparseable rather than merely wrong.
 */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The output grid: two decimals, which is finer than any display and keeps the bytes short. */
const snap = (v: number) => Math.round(v * 100) / 100;

/** Trim a float for output. Identical run to run, and `-0` never reaches the file. */
function num(v: number): string {
  const r = snap(v);
  return Object.is(r, -0) ? '0' : String(r);
}

/**
 * Emit a rectangle's attributes by snapping its EDGES to the output grid rather than its width
 * and height.
 *
 * Rounding x and w independently lets two neighbours that share an edge in the layout end up
 * overlapping — or gapping — by a hundredth of a pixel. Invisible, but it means the SVG's own
 * numbers no longer satisfy the property the layout tests assert, and the next person to check
 * the picture against the geometry has to work out why. Snapping edges makes shared boundaries
 * round to the same value, so the tiling survives serialisation exactly.
 */
function rectAttrs(x: number, y: number, w: number, h: number): string {
  const x0 = snap(x);
  const y0 = snap(y);
  return `x="${num(x0)}" y="${num(y0)}" width="${num(snap(x + w) - x0)}" height="${num(snap(y + h) - y0)}"`;
}

const FONT = "ui-sans-serif,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

const LABEL_SIZE = 12;
const SUB_SIZE = 10.5;
const PAD = 6;
/**
 * Ascent and descent as fractions of the font size. Used to keep glyphs inside the rectangle:
 * the baseline sits ASCENT below the padded top, and the descender must still clear the padded
 * bottom. Conservative for a generic sans; the fit test below has to hold for whatever font the
 * reader's machine actually resolves.
 */
const ASCENT = 0.78;
const DESCENT = 0.22;
/**
 * Advance width per character as a fraction of the font size, used to decide whether a label
 * fits. Deliberately generous: the renderer has no font metrics, and the rule is that a label
 * that does not fit is OMITTED rather than clipped, so an over-estimate costs a label and an
 * under-estimate puts text outside its own rectangle.
 */
const CHAR_W = 0.63;

const textWidth = (s: string, size: number) => s.length * CHAR_W * size;

/** Baselines and the heights they require, derived once so the fit test and the drawing agree. */
const LINE1_BASELINE = PAD + ASCENT * LABEL_SIZE;
const LINE2_BASELINE = LINE1_BASELINE + SUB_SIZE + 2;
const NEED_H1 = LINE1_BASELINE + DESCENT * LABEL_SIZE + PAD;
const NEED_H2 = LINE2_BASELINE + DESCENT * SUB_SIZE + PAD;

export interface LabelPlan {
  /** The path line: the full path when it fits, otherwise the leaf segment. */
  head: string;
  /** The coverage line, or null when there is only room for one line. */
  sub: string | null;
}

/** The coverage line for a cell, phrased so a thin estimate can never read as a solid one. */
export function coverageLabel(cell: TreemapCell): string {
  if (cell.coverage === null) return 'not estimated';
  const p = `${Math.round(cell.coverage * 100)}% explained`;
  // A tilde and an explicit hedge, on top of the grey hatched fill. Two independent signals,
  // because this is the number that would otherwise be quoted back with a confidence it has not
  // earned.
  return isThinEstimate(cell) ? `~${p} (thin)` : p;
}

/**
 * What can be written inside this rectangle without any part of it leaving the rectangle, or
 * null when nothing can. Small cells simply go unlabelled — the legend and the colour still
 * carry them, and clipped text is worse than no text.
 */
export function planLabel(rect: TreemapRect, cell: TreemapCell): LabelPlan | null {
  const inner = rect.w - 2 * PAD;
  const leaf = cell.path.split('/').filter(Boolean).pop() ?? cell.path;

  if (inner <= 0 || rect.h < NEED_H1) return null;

  let head: string | null = null;
  if (textWidth(cell.path, LABEL_SIZE) <= inner) head = cell.path;
  else if (textWidth(leaf, LABEL_SIZE) <= inner) head = leaf;
  if (head === null) return null;

  const sub = coverageLabel(cell);
  const roomForTwo = rect.h >= NEED_H2 && textWidth(sub, SUB_SIZE) <= inner;

  return { head, sub: roomForTwo ? sub : null };
}

/**
 * The whole artifact, as one self-contained SVG string.
 *
 * No external references, no script, no web font, no dependence on the host page's CSS. It can
 * be embedded in the HTML report, saved as a .svg, or attached to an email, and it looks the
 * same in all three.
 */
export function renderTreemapSvg(cells: TreemapCell[], opts: TreemapOptions = {}): string {
  const W = opts.width ?? 960;
  const H = opts.height ?? 560;
  const id = opts.idPrefix ?? 'tm';
  const title = opts.title === undefined ? 'What the commit record explains' : opts.title;
  const subtitle = opts.subtitle ?? null;

  const headH = (title ? 30 : 0) + (subtitle ? 20 : 0) + (title || subtitle ? 12 : 0);
  const legendH = 104;
  const totalH = headH + H + legendH;

  const byPath = new Map<string, TreemapCell>();
  for (const c of cells) byPath.set(c.path, c);
  const rects = squarify(cells, W, H);

  // ---- fills ----
  const fills: string[] = [];
  const borders: string[] = [];
  const labels: string[] = [];

  for (const r of rects) {
    const cell = byPath.get(r.path)!;
    const thin = isThinEstimate(cell);
    const cls = thin ? 'thin' : `s${coverageStep(cell.coverage as number)}`;
    const tip = `${cell.path} — ${coverageLabel(cell)}${cell.active ? ', changed recently' : ''}`;

    fills.push(
      `<rect class="cell ${cls}" ${rectAttrs(r.x, r.y + headH, r.w, r.h)}><title>${esc(tip)}</title></rect>`
    );

    if (cell.active) {
      // Drawn INSIDE the cell, not on its edge: a stroke centred on the boundary would bleed
      // into the neighbour and read as that neighbour's border too.
      const i = 1.5;
      if (r.w > 2 * i + 1 && r.h > 2 * i + 1) {
        borders.push(
          `<rect class="active" ${rectAttrs(r.x + i, r.y + headH + i, r.w - 2 * i, r.h - 2 * i)}/>`
        );
      }
    }

    const plan = planLabel(r, cell);
    if (plan) {
      const ink = thin ? 'ink-thin' : `ink-s${coverageStep(cell.coverage as number)}`;
      const x = num(r.x + PAD);
      labels.push(
        `<text class="lab ${ink}" x="${x}" y="${num(r.y + headH + LINE1_BASELINE)}">${esc(plan.head)}</text>`
      );
      if (plan.sub !== null) {
        labels.push(
          `<text class="sub ${ink}" x="${x}" y="${num(r.y + headH + LINE2_BASELINE)}">${esc(plan.sub)}</text>`
        );
      }
    }
  }

  // ---- the embedded stylesheet ----
  //
  // Scoped to the root id so that inlining this into the HTML report cannot restyle the page,
  // and so two maps on one page do not fight. Every colour appears twice: once for a light page
  // and once inside prefers-color-scheme, which is the only mechanism available without script.
  const stepRules = (r: string[]) =>
    r.map((c, i) => `#${id} .s${i}{fill:${c}}#${id} .ink-s${i}{fill:${inkFor(c)}}`).join('');

  const style = [
    `#${id}{font-family:${FONT}}`,
    `#${id} .bg{fill:#ffffff}`,
    `#${id} .cell{stroke:#ffffff;stroke-width:1}`,
    `#${id} .active{fill:none;stroke:#16181d;stroke-width:2.5;stroke-dasharray:5 3}`,
    // The path line is monospaced, matching the <code> paths in render.ts — and because a
    // monospace advance is uniform, which is what makes the "does this label fit" estimate below
    // reliable rather than hopeful.
    `#${id} .lab{font-family:${MONO};font-size:${LABEL_SIZE}px;font-weight:600}`,
    `#${id} .sub{font-size:${SUB_SIZE}px;font-weight:400}`,
    `#${id} .h1{font-size:17px;font-weight:700;fill:#16181d}`,
    `#${id} .h2{font-size:12px;fill:#5c6270}`,
    `#${id} .key{font-size:11.5px;fill:#16181d}`,
    `#${id} .keym{font-size:11px;fill:#5c6270}`,
    `#${id} .tick{font-size:10px;fill:#5c6270}`,
    `#${id} .rule{stroke:#e3e6ea;stroke-width:1}`,
    `#${id} .swatch{stroke:#c9ced6;stroke-width:1}`,
    `#${id} .keybox{fill:none}`,
    `#${id} .thin{fill:url(#${id}-hatch)}`,
    `#${id} .hatch-bg{fill:#c3c7cd}`,
    `#${id} .hatch-line{stroke:#8d939c;stroke-width:2.5}`,
    `#${id} .ink-thin{fill:#1f2226}`,
    stepRules(LIGHT_RAMP),
    `@media (prefers-color-scheme:dark){`,
    `#${id} .bg{fill:#14161a}`,
    `#${id} .cell{stroke:#14161a}`,
    `#${id} .active{stroke:#e8eaed}`,
    `#${id} .h1{fill:#e8eaed}`,
    `#${id} .h2{fill:#9aa1ad}`,
    `#${id} .key{fill:#e8eaed}`,
    `#${id} .keym{fill:#9aa1ad}`,
    `#${id} .tick{fill:#9aa1ad}`,
    `#${id} .rule{stroke:#2a2e36}`,
    `#${id} .swatch{stroke:#454b55}`,
    `#${id} .hatch-bg{fill:#4a4f58}`,
    `#${id} .hatch-line{stroke:#7b828c}`,
    `#${id} .ink-thin{fill:#f2f4f6}`,
    stepRules(DARK_RAMP),
    `}`,
  ].join('');

  const head: string[] = [];
  if (title) head.push(`<text class="h1" x="0" y="19">${esc(title)}</text>`);
  if (subtitle) head.push(`<text class="h2" x="0" y="${title ? 37 : 15}">${esc(subtitle)}</text>`);

  const legend = renderLegend(id, W, headH + H, LIGHT_RAMP.length);

  // The accessible description says what the picture means, in the same words as the legend.
  const desc =
    'Each rectangle is a directory. Its area is how many lines changed there in the window. ' +
    'Its colour is the share of mechanism questions that the commit record answers for those ' +
    'changes — dark or hot is unexplained by the commit record, pale or sunken is explained. ' +
    'Grey hatched rectangles have too few scored commits to estimate. A dashed border means the ' +
    'region changed recently. No person data appears in this map.';

  return `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" role="img" viewBox="0 0 ${num(W)} ${num(totalH)}" width="${num(W)}" height="${num(totalH)}" aria-labelledby="${id}-t"><title id="${id}-t">${esc(
    title ?? 'What the commit record explains'
  )}</title><desc>${esc(desc)}</desc><style>${style}</style><defs><pattern id="${id}-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="hatch-bg" width="6" height="6"/><line class="hatch-line" x1="0" y1="0" x2="0" y2="6"/></pattern></defs><rect class="bg" x="0" y="0" width="${num(
    W
  )}" height="${num(totalH)}"/>${head.join('')}<g>${fills.join('')}</g><g>${borders.join(
    ''
  )}</g><g>${labels.join('')}</g>${legend}</svg>`;
}

/**
 * The legend. Not decoration: without the numeric anchors the colours are a mood, and without
 * the hatched swatch a reader has no way to know that some cells are not measurements.
 *
 * Wording is fixed here on purpose. "Explained by the commit record" — never "understood".
 */
function renderLegend(id: string, W: number, top: number, steps: number): string {
  const sw = 30;
  const swH = 12;
  const rampW = sw * steps;
  const ry = top + 22;
  const parts: string[] = [];

  parts.push(`<line class="rule" x1="0" y1="${num(top + 8)}" x2="${num(W)}" y2="${num(top + 8)}"/>`);

  // The ramp, on the left. Ten steps so that every anchor below it is a round ten per cent.
  for (let i = 0; i < steps; i++) {
    parts.push(
      `<rect class="swatch s${i}" x="${num(i * sw)}" y="${num(ry)}" width="${num(sw)}" height="${num(swH)}"/>`
    );
  }
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const anchor = t === 0 ? 'start' : t === 1 ? 'end' : 'middle';
    parts.push(
      `<text class="tick" x="${num(t * rampW)}" y="${num(ry + swH + 12)}" text-anchor="${anchor}">${Math.round(
        t * 100
      )}%</text>`
    );
  }

  // The two keys that are not on the ramp, to its right. Both are about things colour cannot say.
  const kx = rampW + 40;
  const tx = kx + sw + 9;
  parts.push(
    `<rect class="swatch thin" x="${num(kx)}" y="${num(ry)}" width="${num(sw)}" height="${num(swH)}"/>`,
    `<text class="key" x="${num(tx)}" y="${num(ry + 10)}">too few commits to estimate</text>`
  );
  const ay = ry + 22;
  parts.push(
    `<rect class="swatch keybox" x="${num(kx)}" y="${num(ay)}" width="${num(sw)}" height="${num(swH)}"/>`,
    `<rect class="active" x="${num(kx + 1.5)}" y="${num(ay + 1.5)}" width="${num(sw - 3)}" height="${num(
      swH - 3
    )}"/>`,
    `<text class="key" x="${num(tx)}" y="${num(ay + 10)}">changed recently</text>`
  );

  // The wording. Fixed, and checked by a test: "explained by the commit record", never
  // "understood" — the study this calibrates against argues that the record cannot be evidence
  // that anyone understood anything, so the stronger word would refute the project inside its
  // own picture.
  const notes = [
    'Colour: the share of mechanism questions the commit record answers. 0% = unexplained by the commit record; 100% = explained.',
    'An absolute share, not a percentile. Area: lines changed in the window. No person data appears in this map.',
    `Greyed and hatched where the estimate is too thin to colour: fewer than ${MIN_SCORED_COMMITS} scored commits, or an interval wider than ±${Math.round(
      MAX_CI_HALF_WIDTH * 100
    )} points.`,
  ];
  let ny = ry + swH + 32;
  for (const line of notes) {
    parts.push(`<text class="keym" x="0" y="${num(ny)}">${esc(line)}</text>`);
    ny += 14;
  }

  return `<g id="${id}-legend">${parts.join('')}</g>`;
}
