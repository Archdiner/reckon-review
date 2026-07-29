/**
 * The record chart: a ranked dot plot with visible confidence intervals.
 *
 * ── WHY THIS REPLACED A TREEMAP ────────────────────────────────────────────────────────────
 *
 * The treemap was measured on its own output and it failed on this data, structurally rather
 * than cosmetically:
 *
 *   - 46 of 64 regions occupied under 1% of the area each; the smallest twenty together came to
 *     0.6%. They were slivers, not cells.
 *   - Only 46 text elements existed for 64 regions, so MOST REGIONS NEVER GOT A LABEL — and the
 *     paths run to 37 characters, which no sliver can hold.
 *   - One region took 15.2% of the area, so the picture was one dominant block plus a field of
 *     noise.
 *
 * That is the known failure mode of treemaps: they need a size distribution that is not heavily
 * skewed, and lines-changed-per-directory is a power law. Worse, area is close to the least
 * accurate visual encoding a human can read, while position along a common scale is the most —
 * so the chart was spending its most precise channel on the label and its least on the number.
 *
 * ── AND IT MADE THE UNCERTAINTY WORSE, WHICH IS THE REAL ARGUMENT ─────────────────────────
 *
 * A treemap cell has one fill, so an estimate's confidence has nowhere to live. The workaround
 * was hatching thin cells grey — hiding the uncertain ones rather than showing their uncertainty.
 * A dot plot draws the interval, so a shaky estimate LOOKS shaky and stays in the chart where the
 * reader can weigh it. The honest presentation and the legible one turn out to be the same thing.
 *
 * ── WHAT THE READER NEEDS, IN ORDER ───────────────────────────────────────────────────────
 *
 *   1. Is this bad?      → the headline share, stated once, large.
 *   2. How bad, spread?  → a strip showing every region on the same scale.
 *   3. Where?            → named regions, sorted worst-first, paths in full.
 *   4. Can I trust it?   → the interval drawn on every row.
 *   5. Does it matter?   → change volume and recent activity, as secondary columns.
 *
 * Sorting is what makes it scannable, and a treemap cannot sort. That alone decides it.
 */

export interface ChartRow {
  path: string;
  /** Share of mechanism questions answered outright, [0,1]. Null when unscored. */
  coverage: number | null;
  ciLo: number | null;
  ciHi: number | null;
  /** Lines changed in the window. Secondary column, never the primary channel. */
  weight: number;
  questions: number;
  scoredCommits: number;
  active: boolean;
  /** True when the estimate is too thin to lean on. Shown, not hidden. */
  thin: boolean;
}

export interface ChartOpts {
  width?: number;
  /** Rows drawn in detail. The strip above always shows every region. */
  topN?: number;
  title?: string;
}

const FONT_SANS =
  'ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
const FONT_MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace';

/** Brand palette. Navy for ink and points, teal for intervals, ice for fills. */
const C = {
  navy: '#0d2f4a',
  navyMid: '#1b5476',
  teal: '#4a90ab',
  tealPale: '#a8cddb',
  ice: '#eaf3f7',
  iceEdge: '#cfe2ea',
  muted: '#5b7789',
};

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Compact volume: 12.4k rather than 12384, because the exact figure is not the point. */
export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * Sort worst-first, but push thin estimates below solid ones at the same value.
 *
 * A reader scans from the top and acts on what they find there, so the top rows have to be the
 * ones that survive scrutiny. Ordering purely by point estimate would let a 0%-from-9-questions
 * region outrank a 2%-from-50-questions one, and the first thing a sceptical reader would do is
 * check the top row.
 */
export function rankRows(rows: ChartRow[]): ChartRow[] {
  return [...rows]
    .filter((r) => r.coverage !== null)
    .sort(
      (a, b) =>
        Number(a.thin) - Number(b.thin) ||
        a.coverage! - b.coverage! ||
        b.weight - a.weight ||
        a.path.localeCompare(b.path)
    );
}

/** Layout constants, kept together so the geometry is inspectable rather than scattered. */
const PAD = 28;
const LABEL_W = 248;
const VALUE_W = 52;
const VOL_W = 96;
const ROW_H = 26;
const STRIP_H = 46;

export function renderRecordChart(rows: ChartRow[], opts: ChartOpts = {}): string {
  const width = opts.width ?? 920;
  const topN = opts.topN ?? 18;
  const ranked = rankRows(rows);
  const shown = ranked.slice(0, topN);
  const hidden = ranked.length - shown.length;

  const plotX = PAD + LABEL_W;
  const plotW = width - plotX - PAD - VALUE_W - VOL_W;
  const x = (v: number) => plotX + v * plotW;

  const stripY = 74;
  const axisY = stripY + STRIP_H + 34;
  const rowsY = axisY + 14;
  const height = rowsY + shown.length * ROW_H + 58;

  // ---- gridlines and axis -------------------------------------------------------------------
  let grid = '';
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    grid += `<line x1="${x(t).toFixed(1)}" y1="${axisY}" x2="${x(t).toFixed(1)}" y2="${
      rowsY + shown.length * ROW_H
    }" class="grid"/>`;
    grid += `<text x="${x(t).toFixed(1)}" y="${axisY - 8}" class="axis" text-anchor="${
      t === 0 ? 'start' : t === 1 ? 'end' : 'middle'
    }">${Math.round(t * 100)}%</text>`;
  }

  // ---- the strip: every region on the same scale, so nothing is hidden by the top-N cut -----
  const solid = ranked.filter((r) => !r.thin);
  const strip = ranked
    .map((r) => {
      const cx = x(r.coverage!);
      const h = r.thin ? 10 : 16;
      return `<line x1="${cx.toFixed(1)}" y1="${stripY + (STRIP_H - h) / 2}" x2="${cx.toFixed(1)}" y2="${
        stripY + (STRIP_H + h) / 2
      }" class="${r.thin ? 'tick-thin' : 'tick'}"/>`;
    })
    .join('');
  const median = solid.length ? solid[Math.floor(solid.length / 2)]!.coverage! : 0;

  // ---- detail rows --------------------------------------------------------------------------
  const maxWeight = Math.max(1, ...shown.map((r) => r.weight));
  const body = shown
    .map((r, i) => {
      const y = rowsY + i * ROW_H + ROW_H / 2;
      const cx = x(r.coverage!);
      const lo = r.ciLo === null ? cx : x(r.ciLo);
      const hi = r.ciHi === null ? cx : x(r.ciHi);
      const volW = Math.max(2, (r.weight / maxWeight) * (VOL_W - 46));
      const volX = width - PAD - VOL_W + 2;
      return `<g class="row">
  <rect x="${PAD - 6}" y="${rowsY + i * ROW_H}" width="${width - 2 * PAD + 12}" height="${ROW_H}" class="${
        i % 2 ? 'band' : 'band-alt'
      }"/>
  <text x="${PAD}" y="${y + 4}" class="path">${esc(r.path)}</text>
  <line x1="${lo.toFixed(1)}" y1="${y}" x2="${hi.toFixed(1)}" y2="${y}" class="${r.thin ? 'ci-thin' : 'ci'}"/>
  <line x1="${lo.toFixed(1)}" y1="${y - 3.5}" x2="${lo.toFixed(1)}" y2="${y + 3.5}" class="${r.thin ? 'cap-thin' : 'cap'}"/>
  <line x1="${hi.toFixed(1)}" y1="${y - 3.5}" x2="${hi.toFixed(1)}" y2="${y + 3.5}" class="${r.thin ? 'cap-thin' : 'cap'}"/>
  <circle cx="${cx.toFixed(1)}" cy="${y}" r="4.5" class="${r.thin ? 'dot-thin' : 'dot'}"/>
  <text x="${width - PAD - VOL_W - 10}" y="${y + 4}" class="val" text-anchor="end">${pct(r.coverage!)}</text>
  <rect x="${volX}" y="${y - 4}" width="${volW.toFixed(1)}" height="8" rx="1.5" class="vol"/>
  <text x="${width - PAD}" y="${y + 4}" class="volnum" text-anchor="end">${compact(r.weight)}</text>
  ${r.active ? `<circle cx="${PAD - 14}" cy="${y}" r="2.6" class="live"/>` : ''}
</g>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Record coverage by region, ranked lowest first">
<style>
  #rc { --ink:${C.navy}; --mut:${C.muted}; --line:${C.iceEdge}; --band:${C.ice};
        --pt:${C.navy}; --ci:${C.teal}; --cip:${C.tealPale}; --bg:#ffffff; }
  @media (prefers-color-scheme:dark) {
    #rc { --ink:${C.ice}; --mut:#8fb0c2; --line:#1d3f57; --band:#102b40;
          --pt:#bfe0ed; --ci:#6fa9c2; --cip:#3a6d86; --bg:#0b1f30; }
  }
  #rc .bg { fill:var(--bg) }
  #rc text { font-family:${FONT_SANS}; fill:var(--ink) }
  #rc .h1 { font-size:15px; font-weight:700 }
  #rc .sub { font-size:11.5px; fill:var(--mut) }
  #rc .axis { font-size:10.5px; fill:var(--mut); font-variant-numeric:tabular-nums }
  #rc .path { font-family:${FONT_MONO}; font-size:12px }
  #rc .val { font-size:12.5px; font-weight:700; font-variant-numeric:tabular-nums }
  #rc .volnum { font-size:10.5px; fill:var(--mut); font-variant-numeric:tabular-nums }
  #rc .grid { stroke:var(--line); stroke-width:1 }
  #rc .band { fill:var(--band); opacity:.5 }
  #rc .band-alt { fill:none }
  #rc .ci { stroke:var(--ci); stroke-width:3; stroke-linecap:round }
  #rc .ci-thin { stroke:var(--cip); stroke-width:3; stroke-linecap:round; stroke-dasharray:2 3 }
  #rc .cap { stroke:var(--ci); stroke-width:1.5 }
  #rc .cap-thin { stroke:var(--cip); stroke-width:1.5 }
  #rc .dot { fill:var(--pt) }
  #rc .dot-thin { fill:var(--bg); stroke:var(--cip); stroke-width:2 }
  #rc .vol { fill:var(--cip); opacity:.75 }
  #rc .live { fill:var(--ci) }
  #rc .tick { stroke:var(--pt); stroke-width:2; opacity:.75 }
  #rc .tick-thin { stroke:var(--cip); stroke-width:2; opacity:.6 }
  #rc .med { stroke:var(--ink); stroke-width:1; stroke-dasharray:3 3; opacity:.5 }
</style>
<g id="rc">
<rect class="bg" width="${width}" height="${height}"/>
<text x="${PAD}" y="26" class="h1">${esc(opts.title ?? 'How much of each area’s change the commit history explains')}</text>
<text x="${PAD}" y="44" class="sub">Every one of the ${ranked.length} measured areas appears on the strip. The rows below name the ${shown.length} least explained.</text>

<text x="${PAD}" y="${stripY + 6}" class="sub">All ${ranked.length} areas</text>
<line x1="${plotX}" y1="${stripY + STRIP_H / 2}" x2="${x(1).toFixed(1)}" y2="${stripY + STRIP_H / 2}" class="grid"/>
${strip}
<line x1="${x(median).toFixed(1)}" y1="${stripY + 2}" x2="${x(median).toFixed(1)}" y2="${stripY + STRIP_H - 2}" class="med"/>
<text x="${x(median).toFixed(1)}" y="${stripY + STRIP_H + 14}" class="sub" text-anchor="middle">median ${pct(median)}</text>

${grid}
<text x="${PAD}" y="${axisY - 8}" class="sub">Least explained first</text>
<text x="${width - PAD - VOL_W - 10}" y="${axisY - 8}" class="sub" text-anchor="end">explained</text>
<text x="${width - PAD}" y="${axisY - 8}" class="sub" text-anchor="end">lines changed</text>
${body}
<text x="${PAD}" y="${rowsY + shown.length * ROW_H + 22}" class="sub">${
    hidden > 0 ? `${hidden} further areas are on the strip above and in the data file.` : 'All measured areas are shown.'
  }</text>
<text x="${PAD}" y="${rowsY + shown.length * ROW_H + 38}" class="sub">Bars show a 95% interval. A hollow point and dashed interval mark an estimate too thin to lean on. A dot in the left margin marks an area changed recently.</text>
</g>
</svg>`;
}
