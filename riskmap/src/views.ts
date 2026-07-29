/**
 * Alternative views of the same measurement, so the framing can be chosen on evidence.
 *
 * Four renderers over one row type. They are not decoration — each answers a different question,
 * and which question the artifact should lead with is a judgement worth making explicitly:
 *
 *   ranked   — "which areas are least explained, and how sure are you?"  Position on a common
 *              scale, sorted, one row per area, interval drawn. Most accurate encoding available.
 *   quadrant — "where does a lot change AND almost none of it get written down?"  Volume against
 *              coverage. The lower-right region is the only quadrant anyone needs to act on, and
 *              no other view isolates it.
 *   bands    — "what shape is this repository in overall?"  Count of areas per coverage band.
 *              Answers the distribution question the other three only imply.
 *   treemap  — "how much of the codebase does each area represent?"  Retained because it is the
 *              right chart when regions are evenly sized, and measurably wrong when they are not.
 *
 * ── FIXES CARRIED BY ALL FOUR ─────────────────────────────────────────────────────────────
 *
 * LOW-MEANING PATHS ARE DROPPED, NOT COLOURED. Locale and translation trees produce enormous
 * diffs with no mechanism to explain, and on grafana `public/locales` was the single largest
 * rectangle in the treemap — a quarter of the visual field spent telling a reader their
 * translation files are underdocumented. That is the first objection any engineer there would
 * raise, and it would be right. The risk map already had this concept; the record map failed to
 * apply it.
 *
 * COLOUR IS BINNED ON THE OCCUPIED RANGE. Every measured area on grafana sits between 2% and
 * 61%, so a ramp built for 0-100% crushed all the signal into its bottom four swatches and the
 * map read as one flat wash. Bins are quantiles of the data actually present, with the boundaries
 * printed, so adjacent areas step visibly and the reader can see what the steps mean.
 *
 * THE LEGEND IS DRAWN, NOT DESCRIBED. The previous caption asserted "dark is unexplained, pale is
 * explained" — true in light mode and FALSE IN DARK MODE, where the ramp inverts luminance by
 * design so unexplained areas stay visible against a dark page. A reader in dark mode read the
 * entire map backwards on the strength of that sentence. Prose cannot describe a theme-dependent
 * scale; a rendered swatch strip can, and it cannot disagree with the fill it came from.
 */

import { isLowMeaningPath } from './filters.js';

export interface ViewRow {
  path: string;
  coverage: number | null;
  ciLo: number | null;
  ciHi: number | null;
  weight: number;
  questions: number;
  scoredCommits: number;
  active: boolean;
  thin: boolean;
}

export interface ViewMeta {
  repo: string;
  headSha: string;
  windowMonths: number;
  commits: number;
  overallRate: number;
  overallExplicit: number;
  overallTotal: number;
  bodyDensity: number;
}

const SANS = 'ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace';

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * Drop the areas whose churn is real but whose mechanism is not.
 *
 * Reported rather than silent: the count of dropped areas goes on the page, because a reader who
 * knows their repository will notice `locales` missing and should be told it was excluded on
 * purpose rather than left to wonder.
 */
export function partitionMeaningful(rows: ViewRow[]): { kept: ViewRow[]; dropped: ViewRow[] } {
  const kept: ViewRow[] = [];
  const dropped: ViewRow[] = [];
  for (const r of rows) {
    if (r.coverage === null) continue;
    (isLowMeaningPath(`${r.path}/`) ? dropped : kept).push(r);
  }
  return { kept, dropped };
}

/** Quantile bin edges over the values actually present. Five bins, so steps are distinguishable. */
export function quantileBins(values: number[], bins = 5): number[] {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return [];
  const edges: number[] = [];
  for (let i = 1; i < bins; i++) edges.push(s[Math.floor((i / bins) * (s.length - 1))]!);
  return [...new Set(edges)];
}

export function binOf(v: number, edges: number[]): number {
  let i = 0;
  while (i < edges.length && v >= edges[i]!) i++;
  return i;
}

/** Five steps from most-alarming to least, defined per theme by CSS custom properties. */
const BIN_CLASSES = ['b0', 'b1', 'b2', 'b3', 'b4'];

/**
 * Shared chrome: the headline, which is the reason the page exists and was previously set in
 * small grey text under the title.
 */
function header(m: ViewMeta, width: number, subtitle: string): { svg: string; height: number } {
  const svg = `
<text x="28" y="34" class="kicker">${esc(m.repo)} · ${esc(m.headSha.slice(0, 10))} · ${m.windowMonths}-month window · ${m.commits.toLocaleString('en-US')} commits</text>
<text x="28" y="82" class="headline">The commit history explains ${pct(m.overallRate)} of what changed</text>
<text x="28" y="106" class="headsub">${m.overallExplicit.toLocaleString('en-US')} of ${m.overallTotal.toLocaleString('en-US')} mechanism questions answered outright · ${subtitle}</text>`;
  void width;
  return { svg, height: 128 };
}

function styleBlock(id: string): string {
  return `
  #${id} { --ink:#0d2f4a; --mut:#5b7789; --line:#cfe2ea; --bg:#ffffff; --accent:#4a90ab;
           --b0:#0d2f4a; --b1:#255f7f; --b2:#4a90ab; --b3:#93c1d3; --b4:#d5e7ef;
           --thin:#a8cddb; }
  @media (prefers-color-scheme:dark) {
    #${id} { --ink:#eaf3f7; --mut:#8fb0c2; --line:#1d3f57; --bg:#0b1f30; --accent:#6fa9c2;
             --b0:#cfe7f2; --b1:#8fc0d5; --b2:#4a90ab; --b3:#2c5b74; --b4:#16344a;
             --thin:#3a6d86; }
  }
  #${id} .bgr { fill:var(--bg) }
  #${id} text { font-family:${SANS}; fill:var(--ink) }
  #${id} .kicker { font-size:11.5px; fill:var(--mut); letter-spacing:.02em }
  #${id} .headline { font-size:27px; font-weight:800; letter-spacing:-.015em }
  #${id} .headsub { font-size:12.5px; fill:var(--mut) }
  #${id} .h2 { font-size:12px; font-weight:700; letter-spacing:.03em }
  #${id} .sub { font-size:11px; fill:var(--mut) }
  #${id} .path { font-family:${MONO}; font-size:11.5px }
  #${id} .val { font-size:12.5px; font-weight:700; font-variant-numeric:tabular-nums }
  #${id} .num { font-size:10.5px; fill:var(--mut); font-variant-numeric:tabular-nums }
  #${id} .grid { stroke:var(--line); stroke-width:1 }
  #${id} .b0 { fill:var(--b0) } #${id} .b1 { fill:var(--b1) } #${id} .b2 { fill:var(--b2) }
  #${id} .b3 { fill:var(--b3) } #${id} .b4 { fill:var(--b4) }
  #${id} .ci { stroke:var(--accent); stroke-width:3; stroke-linecap:round }
  #${id} .ci-thin { stroke:var(--thin); stroke-width:3; stroke-linecap:round; stroke-dasharray:2 3 }
  #${id} .dot { fill:var(--ink) }
  #${id} .dot-thin { fill:var(--bg); stroke:var(--thin); stroke-width:2 }
  #${id} .live { fill:var(--accent) }`;
}

/** The drawn legend. Replaces a caption that could not stay true across themes. */
function legend(x: number, y: number, edges: number[], label: string): string {
  const w = 34;
  let s = `<text x="${x}" y="${y - 8}" class="sub">${esc(label)}</text>`;
  for (let i = 0; i < BIN_CLASSES.length; i++) {
    s += `<rect x="${x + i * w}" y="${y}" width="${w - 2}" height="10" class="${BIN_CLASSES[i]}" rx="1"/>`;
  }
  s += `<text x="${x}" y="${y + 24}" class="num">least explained</text>`;
  s += `<text x="${x + BIN_CLASSES.length * w - 2}" y="${y + 24}" class="num" text-anchor="end">most</text>`;
  if (edges.length) {
    s += `<text x="${x + BIN_CLASSES.length * w + 14}" y="${y + 9}" class="num">breaks at ${edges
      .map((e) => pct(e))
      .join(' · ')}</text>`;
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// VIEW 1 — ranked dot plot.
// ---------------------------------------------------------------------------------------------

/**
 * A marker that fires on everything is not a marker.
 *
 * At a 3-month window on an active repository, 63 of 63 measured areas counted as "recently
 * changed" — the dot was pure texture competing with the data for attention. Rather than trust a
 * fixed window to be informative on every repository, the renderers check: if the flag is nearly
 * universal or nearly absent, it is suppressed and the page says why. The recency window itself
 * was also tightened, but no window is safe on every repo, so this guard stays.
 */
export function markerIsInformative(rows: ViewRow[]): boolean {
  if (rows.length === 0) return false;
  const share = rows.filter((r) => r.active).length / rows.length;
  return share > 0.12 && share < 0.88;
}

export function renderRanked(rows: ViewRow[], m: ViewMeta, opts: { width?: number; topN?: number } = {}): string {
  const width = opts.width ?? 940;
  const topN = opts.topN ?? 16;
  const { kept, dropped } = partitionMeaningful(rows);
  const showLive = markerIsInformative(kept);
  const ranked = [...kept].sort(
    (a, b) => Number(a.thin) - Number(b.thin) || a.coverage! - b.coverage! || b.weight - a.weight
  );
  const shown = ranked.slice(0, topN);
  const hidden = ranked.length - shown.length;

  const h = header(m, width, `${kept.length} areas measured`);
  const LABEL_W = 250;
  const VOL_W = 84;
  const plotX = 28 + LABEL_W;
  const plotW = width - plotX - 28 - 46 - VOL_W;
  const lo = Math.min(...kept.map((r) => r.ciLo ?? r.coverage!));
  const hi = Math.max(...kept.map((r) => r.ciHi ?? r.coverage!));
  const dLo = Math.max(0, Math.floor(lo * 20) / 20);
  const dHi = Math.min(1, Math.ceil(hi * 20) / 20);
  const x = (v: number) => plotX + ((v - dLo) / (dHi - dLo)) * plotW;

  const axisY = h.height + 30;
  const rowsY = axisY + 12;
  const ROW_H = 25;
  const height = rowsY + shown.length * ROW_H + 66;
  const maxW = Math.max(1, ...shown.map((r) => r.weight));

  let grid = '';
  const ticks: number[] = [];
  for (let t = dLo; t <= dHi + 1e-9; t += (dHi - dLo) / 4) ticks.push(t);
  for (const t of ticks) {
    grid += `<line x1="${x(t).toFixed(1)}" y1="${axisY}" x2="${x(t).toFixed(1)}" y2="${rowsY + shown.length * ROW_H}" class="grid"/>`;
    grid += `<text x="${x(t).toFixed(1)}" y="${axisY - 7}" class="num" text-anchor="middle">${pct(t)}</text>`;
  }

  const body = shown
    .map((r, i) => {
      const y = rowsY + i * ROW_H + ROW_H / 2;
      const cx = x(r.coverage!);
      const a = x(r.ciLo ?? r.coverage!);
      const b = x(r.ciHi ?? r.coverage!);
      const vw = Math.max(2, (r.weight / maxW) * (VOL_W - 40));
      return `<g>
  ${i % 2 ? `<rect x="22" y="${rowsY + i * ROW_H}" width="${width - 44}" height="${ROW_H}" fill="var(--line)" opacity=".25"/>` : ''}
  <text x="28" y="${y + 4}" class="path">${esc(r.path)}</text>
  <line x1="${a.toFixed(1)}" y1="${y}" x2="${b.toFixed(1)}" y2="${y}" class="${r.thin ? 'ci-thin' : 'ci'}"/>
  <circle cx="${cx.toFixed(1)}" cy="${y}" r="4.5" class="${r.thin ? 'dot-thin' : 'dot'}"/>
  <text x="${width - 28 - VOL_W - 8}" y="${y + 4}" class="val" text-anchor="end">${pct(r.coverage!)}</text>
  <rect x="${width - 28 - VOL_W}" y="${y - 4}" width="${vw.toFixed(1)}" height="8" rx="1.5" fill="var(--thin)" opacity=".8"/>
  <text x="${width - 28}" y="${y + 4}" class="num" text-anchor="end">${compact(r.weight)}</text>
  ${showLive && r.active ? `<circle cx="18" cy="${y}" r="2.6" class="live"/>` : ''}
</g>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Record coverage by area, least explained first">
<style>${styleBlock('v1')}</style><g id="v1"><rect class="bgr" width="${width}" height="${height}"/>
${h.svg}
<text x="28" y="${axisY - 24}" class="h2">LEAST EXPLAINED AREAS</text>
<text x="${width - 28}" y="${axisY - 24}" class="sub" text-anchor="end">bar = 95% interval · right column = lines changed</text>
${grid}${body}
<text x="28" y="${rowsY + shown.length * ROW_H + 24}" class="sub">${hidden} further measured areas are in the data file${
    dropped.length ? `; ${dropped.length} translation and fixture areas were excluded as high-churn, low-mechanism` : ''
  }.</text>
<text x="28" y="${rowsY + shown.length * ROW_H + 42}" class="sub">A hollow point and dashed bar mark an estimate too thin to lean on.${
    showLive
      ? ' A dot in the left margin marks recent change.'
      : ` Recency is not shown: ${kept.filter((r) => r.active).length} of ${kept.length} areas changed in the window, so the marker would carry no information.`
  }</text>
</g></svg>`;
}

// ---------------------------------------------------------------------------------------------
// VIEW 2 — quadrant scatter. Volume against coverage.
// ---------------------------------------------------------------------------------------------

export function renderQuadrant(rows: ViewRow[], m: ViewMeta, opts: { width?: number } = {}): string {
  const width = opts.width ?? 940;
  const { kept, dropped } = partitionMeaningful(rows);
  const h = header(m, width, `${kept.length} areas measured`);

  const PL = 74;
  const PR = 210;
  const PT = h.height + 34;
  const PB = 74;
  const height = 620;
  const plotW = width - PL - PR;
  const plotH = height - PT - PB;

  const wMax = Math.max(...kept.map((r) => r.weight));
  const wMin = Math.max(1, Math.min(...kept.map((r) => r.weight)));
  const cMax = Math.max(...kept.map((r) => r.coverage!));
  const xs = (w: number) => PL + (Math.log10(w) - Math.log10(wMin)) / (Math.log10(wMax) - Math.log10(wMin)) * plotW;
  const ys = (c: number) => PT + plotH - (c / (cMax * 1.08)) * plotH;

  const medW = [...kept.map((r) => r.weight)].sort((a, b) => a - b)[Math.floor(kept.length / 2)]!;
  const medC = [...kept.map((r) => r.coverage!)].sort((a, b) => a - b)[Math.floor(kept.length / 2)]!;

  // The actionable quadrant: more change than typical, less explained than typical.
  const focus = kept
    .filter((r) => r.weight >= medW && r.coverage! <= medC && !r.thin)
    .sort((a, b) => b.weight - a.weight);

  let gy = '';
  for (let i = 0; i <= 4; i++) {
    const c = (cMax * 1.08 * i) / 4;
    gy += `<line x1="${PL}" y1="${ys(c).toFixed(1)}" x2="${PL + plotW}" y2="${ys(c).toFixed(1)}" class="grid"/>`;
    gy += `<text x="${PL - 10}" y="${ys(c) + 4}" class="num" text-anchor="end">${pct(c)}</text>`;
  }
  let gx = '';
  for (const v of [wMin, 100, 1000, 10000, wMax].filter((v, i, a) => v >= wMin && v <= wMax && a.indexOf(v) === i)) {
    gx += `<line x1="${xs(v).toFixed(1)}" y1="${PT}" x2="${xs(v).toFixed(1)}" y2="${PT + plotH}" class="grid"/>`;
    gx += `<text x="${xs(v).toFixed(1)}" y="${PT + plotH + 18}" class="num" text-anchor="middle">${compact(v)}</text>`;
  }

  const pts = kept
    .map((r) => {
      const cx = xs(r.weight);
      const cy = ys(r.coverage!);
      const inFocus = r.weight >= medW && r.coverage! <= medC;
      return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${inFocus && !r.thin ? 6 : 4}" class="${
        r.thin ? 'dot-thin' : inFocus ? 'b0' : 'b3'
      }" ${inFocus && !r.thin ? 'stroke="var(--bg)" stroke-width="1.5"' : ''}/>`;
    })
    .join('');

  const labels = focus
    .slice(0, 7)
    .map((r, i) => {
      const cy = PT + 26 + i * 19;
      return `<text x="${PL + plotW + 22}" y="${cy}" class="path">${esc(r.path.length > 30 ? `…${r.path.slice(-29)}` : r.path)}</text>
<text x="${width - 28}" y="${cy}" class="val" text-anchor="end">${pct(r.coverage!)}</text>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Change volume against record coverage, by area">
<style>${styleBlock('v2')}</style><g id="v2"><rect class="bgr" width="${width}" height="${height}"/>
${h.svg}
<text x="28" y="${PT - 14}" class="h2">A LOT CHANGED AND LITTLE WAS WRITTEN DOWN</text>
<rect x="${xs(medW).toFixed(1)}" y="${ys(medC).toFixed(1)}" width="${(PL + plotW - xs(medW)).toFixed(1)}" height="${(PT + plotH - ys(medC)).toFixed(1)}" fill="var(--accent)" opacity=".07"/>
<line x1="${xs(medW).toFixed(1)}" y1="${PT}" x2="${xs(medW).toFixed(1)}" y2="${PT + plotH}" stroke="var(--mut)" stroke-dasharray="4 4" stroke-width="1"/>
<line x1="${PL}" y1="${ys(medC).toFixed(1)}" x2="${PL + plotW}" y2="${ys(medC).toFixed(1)}" stroke="var(--mut)" stroke-dasharray="4 4" stroke-width="1"/>
${gy}${gx}${pts}
<text x="${PL + plotW - 6}" y="${PT + plotH - 8}" class="sub" text-anchor="end" opacity=".85">more change, less explained</text>
<text x="${PL - 56}" y="${PT + plotH / 2}" class="sub" transform="rotate(-90 ${PL - 56} ${PT + plotH / 2})" text-anchor="middle">share explained</text>
<text x="${PL + plotW / 2}" y="${PT + plotH + 40}" class="sub" text-anchor="middle">lines changed in the window (log scale)</text>
<text x="${PL + plotW + 22}" y="${PT + 6}" class="h2">WHERE TO START</text>
${labels}
<text x="28" y="${height - 34}" class="sub">Dashed lines are this repository's own medians, so the shaded quadrant is defined relative to itself and not to a fixed threshold.</text>
<text x="28" y="${height - 16}" class="sub">${dropped.length} translation and fixture areas excluded as high-churn, low-mechanism. Hollow points are estimates too thin to lean on.</text>
</g></svg>`;
}

// ---------------------------------------------------------------------------------------------
// VIEW 3 — banded distribution.
// ---------------------------------------------------------------------------------------------

export function renderBands(rows: ViewRow[], m: ViewMeta, opts: { width?: number } = {}): string {
  const width = opts.width ?? 940;
  const { kept, dropped } = partitionMeaningful(rows);
  const h = header(m, width, `${kept.length} areas measured`);
  const BANDS = [
    { lo: 0, hi: 0.1, label: 'under 10%' },
    { lo: 0.1, hi: 0.2, label: '10–20%' },
    { lo: 0.2, hi: 0.3, label: '20–30%' },
    { lo: 0.3, hi: 0.4, label: '30–40%' },
    { lo: 0.4, hi: 0.5, label: '40–50%' },
    { lo: 0.5, hi: 1.01, label: '50% and up' },
  ];
  const counts = BANDS.map((b) => kept.filter((r) => r.coverage! >= b.lo && r.coverage! < b.hi));
  const vol = counts.map((g) => g.reduce((n, r) => n + r.weight, 0));
  const totVol = Math.max(1, vol.reduce((a, b) => a + b, 0));
  const maxN = Math.max(1, ...counts.map((g) => g.length));

  const PL = 132;
  const top = h.height + 44;
  const ROW = 52;
  const plotW = width - PL - 210;
  const height = top + BANDS.length * ROW + 76;

  const body = BANDS.map((b, i) => {
    const y = top + i * ROW;
    const n = counts[i]!.length;
    const bw = (n / maxN) * plotW;
    const share = vol[i]! / totVol;
    const cls = BIN_CLASSES[Math.min(BIN_CLASSES.length - 1, i)]!;
    return `<g>
  <text x="${PL - 12}" y="${y + 26}" class="path" text-anchor="end">${b.label}</text>
  <rect x="${PL}" y="${y + 10}" width="${Math.max(2, bw).toFixed(1)}" height="26" rx="2" class="${cls}"/>
  <text x="${PL + Math.max(2, bw) + 10}" y="${y + 28}" class="val">${n}</text>
  <text x="${width - 28}" y="${y + 28}" class="num" text-anchor="end">${pct(share)} of all change</text>
</g>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Areas grouped by how much of their change the record explains">
<style>${styleBlock('v3')}</style><g id="v3"><rect class="bgr" width="${width}" height="${height}"/>
${h.svg}
<text x="28" y="${top - 18}" class="h2">HOW MANY AREAS SIT AT EACH LEVEL</text>
<text x="${width - 28}" y="${top - 18}" class="sub" text-anchor="end">bar length = number of areas</text>
${body}
<text x="28" y="${height - 34}" class="sub">The right column weights each band by lines changed, so a band holding few areas but much of the change is visible as such.</text>
<text x="28" y="${height - 16}" class="sub">${dropped.length} translation and fixture areas excluded as high-churn, low-mechanism.</text>
</g></svg>`;
}

// ---------------------------------------------------------------------------------------------
// VIEW 4 — treemap, repaired.
// ---------------------------------------------------------------------------------------------

interface Rect { x: number; y: number; w: number; h: number; row: ViewRow | null; folded?: number }

/** Squarified layout, with sub-threshold areas folded into one honest cell. */
function layout(rows: ViewRow[], W: number, H: number, minArea: number): Rect[] {
  const total = rows.reduce((n, r) => n + r.weight, 0);
  const scale = (W * H) / Math.max(1, total);
  const big = rows.filter((r) => r.weight * scale >= minArea);
  const small = rows.filter((r) => r.weight * scale < minArea);
  const items: { weight: number; row: ViewRow | null; folded?: number }[] = big
    .map((r) => ({ weight: r.weight, row: r as ViewRow | null }))
    .sort((a, b) => b.weight - a.weight);
  if (small.length) {
    items.push({ weight: small.reduce((n, r) => n + r.weight, 0), row: null, folded: small.length });
  }

  const out: Rect[] = [];
  let x = 0;
  let y = 0;
  let w = W;
  let h = H;
  let rest = items.slice();
  const sum = (a: typeof items) => a.reduce((n, i) => n + i.weight, 0);

  while (rest.length) {
    const horiz = w >= h;
    const remaining = sum(rest);
    const span = horiz ? h : w;
    let take = 1;
    let best = Infinity;
    for (let k = 1; k <= rest.length; k++) {
      const s = sum(rest.slice(0, k));
      const thick = (s / remaining) * (horiz ? w : h);
      let worst = 0;
      for (const it of rest.slice(0, k)) {
        const len = (it.weight / s) * span;
        worst = Math.max(worst, Math.max(thick / len, len / thick));
      }
      if (worst <= best) {
        best = worst;
        take = k;
      } else break;
    }
    const group = rest.slice(0, take);
    const s = sum(group);
    const thick = (s / remaining) * (horiz ? w : h);
    let off = 0;
    for (const it of group) {
      const len = (it.weight / s) * span;
      out.push(
        horiz
          ? { x, y: y + off, w: thick, h: len, row: it.row, ...(it.folded ? { folded: it.folded } : {}) }
          : { x: x + off, y, w: len, h: thick, row: it.row, ...(it.folded ? { folded: it.folded } : {}) }
      );
      off += len;
    }
    if (horiz) {
      x += thick;
      w -= thick;
    } else {
      y += thick;
      h -= thick;
    }
    rest = rest.slice(take);
  }
  return out;
}

export function renderTreemapBinned(rows: ViewRow[], m: ViewMeta, opts: { width?: number } = {}): string {
  const width = opts.width ?? 940;
  const { kept, dropped } = partitionMeaningful(rows);
  const h = header(m, width, `${kept.length} areas measured`);
  const edges = quantileBins(kept.map((r) => r.coverage!), 5);

  const top = h.height + 58;
  const W = width - 56;
  const H = 430;
  const height = top + H + 82;
  const rects = layout(kept, W, H, 2600);

  const cells = rects
    .map((r) => {
      const X = (28 + r.x).toFixed(1);
      const Y = (top + r.y).toFixed(1);
      const w = Math.max(0, r.w - 2).toFixed(1);
      const hh = Math.max(0, r.h - 2).toFixed(1);
      if (!r.row) {
        return `<g><rect x="${X}" y="${Y}" width="${w}" height="${hh}" fill="none" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 3" rx="2"/>
<text x="${(28 + r.x + r.w / 2).toFixed(1)}" y="${(top + r.y + r.h / 2).toFixed(1)}" class="num" text-anchor="middle">${r.folded} smaller areas</text></g>`;
      }
      const cls = BIN_CLASSES[binOf(r.row.coverage!, edges)]!;
      const fits = r.w > 92 && r.h > 30;
      const name = r.row.path.length * 6.4 > r.w - 12 ? `…${r.row.path.slice(-Math.max(4, Math.floor((r.w - 18) / 6.4)))}` : r.row.path;
      return `<g><rect x="${X}" y="${Y}" width="${w}" height="${hh}" class="${cls}" rx="2"/>
${
        fits
          ? `<text x="${(28 + r.x + 8).toFixed(1)}" y="${(top + r.y + 19).toFixed(1)}" class="tmlabel">${esc(name)}</text>
<text x="${(28 + r.x + 8).toFixed(1)}" y="${(top + r.y + 34).toFixed(1)}" class="tmval">${pct(r.row.coverage!)}</text>`
          : ''
      }</g>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Areas sized by lines changed, shaded by how much the record explains">
<style>${styleBlock('v4')}
  #v4 .tmlabel { font-family:${MONO}; font-size:10.5px; fill:#fff; paint-order:stroke; stroke:rgba(0,0,0,.28); stroke-width:2.4px }
  #v4 .tmval { font-size:12px; font-weight:800; fill:#fff; paint-order:stroke; stroke:rgba(0,0,0,.28); stroke-width:2.4px }
  @media (prefers-color-scheme:dark) {
    #v4 .tmlabel, #v4 .tmval { fill:#08202f; stroke:rgba(255,255,255,.3) }
  }</style><g id="v4"><rect class="bgr" width="${width}" height="${height}"/>
${h.svg}
<text x="28" y="${top - 34}" class="h2">SIZED BY LINES CHANGED</text>
${legend(width - 28 - 5 * 34 - 150, top - 42, edges, '')}
${cells}
<text x="28" y="${top + H + 26}" class="sub">Shading uses five quantile bins of this repository's own values, so adjacent areas step visibly instead of washing together.</text>
<text x="28" y="${top + H + 44}" class="sub">${dropped.length} translation and fixture areas excluded as high-churn, low-mechanism. Areas too small to label are folded into one cell rather than drawn as slivers.</text>
<text x="28" y="${top + H + 62}" class="sub">Read the shading from the strip above, not from a remembered rule — the scale inverts between light and dark themes so that the least explained areas always carry the strongest contrast.</text>
</g></svg>`;
}
