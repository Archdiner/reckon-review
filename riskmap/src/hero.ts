/**
 * The hero visual: every question asked, drawn once.
 *
 * ── THE IDEA ───────────────────────────────────────────────────────────────────────────────
 *
 * The audit views answer a reviewer's questions. This one answers a stranger's, in about two
 * seconds, from a phone: **most of what changed here was never explained.**
 *
 * It works by drawing the unit of measurement instead of summarising it. 2,931 mechanism
 * questions were asked about grafana's changes and 737 got an answer from the commit record. A
 * bar chart of 25% is a number. Two thousand one hundred and ninety-four unlit dots is a
 * quantity you feel, and every one of them is a real question that was really scored.
 *
 * The dots are GROUPED BY AREA and the areas ordered worst-first, so the same picture carries the
 * distribution too: the blocks at the top are nearly black, the blocks at the bottom are lit, and
 * a reader can see which directories those are without reading a table. One mark type, two
 * colours, no axes.
 *
 * ── WHY THIS PALETTE, HAVING ARGUED AGAINST ADDING COLOUR ─────────────────────────────────
 *
 * Earlier ramps were monochrome blue because coverage is one ordered quantity and a sequential
 * scale is the honest encoding for it. Here the encoding is CATEGORICAL — a question was answered
 * or it was not — so two hues are correct rather than decorative.
 *
 * The pair is teal and amber, and that choice is not arbitrary either. Blue-versus-yellow is the
 * one colour axis that survives every common form of colour vision deficiency; red-versus-green is
 * the one that does not. So the most striking available pairing is also the most accessible one,
 * which is a rare place to be and worth taking.
 *
 * Amber is given to the ANSWERED dots — the minority. Bright ink on the rare thing makes its
 * rarity the subject: a field of dark with a scatter of light in it reads as absence, which is
 * what is being reported. Reversing it would produce a cheerful poster about a bad number.
 *
 * ── WHAT IT MUST NOT DO ───────────────────────────────────────────────────────────────────
 *
 * No person appears, and none can: this module is handed counts per area and never sees an author.
 * The word "understood" is never used — the study's central claim is that a record cannot be
 * evidence that anyone understood anything, so the legend says EXPLAINED, and a test asserts it.
 */

export interface HeroArea {
  path: string;
  /** Questions answered outright. */
  explicit: number;
  /** Questions asked. */
  total: number;
  /** Estimate too thin to lean on; drawn but marked. */
  thin: boolean;
}

export interface HeroMeta {
  repo: string;
  windowMonths: number;
  commits: number;
}

const SANS = 'ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace';

/** Brand navy and ice, plus the amber counterpoint. */
const INK = '#08202f';
const NAVY = '#0d2f4a';
const UNLIT = '#1c4460';
const AMBER = '#f0a94a';
const AMBER_DIM = '#8a6a3a';
const ICE = '#eaf3f7';
const TEAL = '#4a90ab';

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const commas = (n: number) => n.toLocaleString('en-US');

/**
 * Lay out one area's questions as a compact block of dots.
 *
 * Answered dots are placed FIRST so the lit ones cluster at the top-left of each block. Scattering
 * them would read as texture; clustering them makes the lit fraction of each block directly
 * comparable to its neighbours by eye, which is the comparison the picture exists to support.
 */
function block(
  a: HeroArea,
  x: number,
  y: number,
  cols: number,
  d: number,
  gap: number
): { svg: string; rows: number } {
  const step = d + gap;
  const rows = Math.ceil(a.total / cols);
  let s = '';
  for (let i = 0; i < a.total; i++) {
    const cx = x + (i % cols) * step;
    const cy = y + Math.floor(i / cols) * step;
    const lit = i < a.explicit;
    s += `<rect x="${cx}" y="${cy}" width="${d}" height="${d}" rx="1" class="${
      lit ? (a.thin ? 'lit-thin' : 'lit') : a.thin ? 'unlit-thin' : 'unlit'
    }"/>`;
  }
  return { svg: s, rows };
}

/** Row budget for the pooled tail block. Past it, marks stand for several questions each. */
const TAIL_MAX_ROWS = 22;

export interface HeroOpts {
  width?: number;
  /** Areas drawn as named blocks. The rest are pooled into one trailing block. */
  namedAreas?: number;
}

export function renderHero(areas: HeroArea[], m: HeroMeta, opts: HeroOpts = {}): string {
  const W = opts.width ?? 1200;
  const named = opts.namedAreas ?? 12;

  const usable = areas.filter((a) => a.total > 0);
  const totalQ = usable.reduce((n, a) => n + a.total, 0);
  const totalE = usable.reduce((n, a) => n + a.explicit, 0);
  const unanswered = totalQ - totalE;
  const rate = totalQ ? totalE / totalQ : 0;

  // Worst first — an area with no answers at all leads, and thin estimates sink below solid ones
  // at the same rate so the top of the picture is the part that survives scrutiny.
  const ranked = [...usable].sort(
    (a, b) =>
      Number(a.thin) - Number(b.thin) ||
      a.explicit / a.total - b.explicit / b.total ||
      b.total - a.total
  );
  const head = ranked.slice(0, named);
  const tail = ranked.slice(named);
  const tailArea: HeroArea | null = tail.length
    ? {
        path: `${tail.length} other areas`,
        explicit: tail.reduce((n, a) => n + a.explicit, 0),
        total: tail.reduce((n, a) => n + a.total, 0),
        thin: false,
      }
    : null;

  // ---- geometry -----------------------------------------------------------------------------
  const PAD = 56;
  const D = 7;
  const GAP = 3;
  const COLS = 14;
  const COL_W = 176;
  const perRow = Math.max(1, Math.floor((W - 2 * PAD) / COL_W));
  const blocks = [...head, ...(tailArea ? [tailArea] : [])];

  // THE POOLED BLOCK NEEDS ITS OWN GEOMETRY, and getting this wrong is what broke the first
  // render. The named areas hold ~50 questions each, so 14 columns gives them four tidy rows. The
  // tail pools fifty-odd areas and carries about two thousand questions — at 14 columns that is
  // 143 rows, a 1,450px column that made the whole canvas 2,316px tall and reduced the actual
  // subject of the picture to a strip at the top. It gets a full-width band and as many columns as
  // fit, which turns the same marks into a compact block instead of a tower.
  const top = 300;
  let bx = PAD;
  let by = top;
  let rowMax = 0;
  let body = '';
  const named_ = blocks.filter((a) => a !== tailArea);
  named_.forEach((a, i) => {
    if (i > 0 && i % perRow === 0) {
      by += rowMax + 46;
      bx = PAD;
      rowMax = 0;
    }
    const b = block(a, bx, by + 22, COLS, D, GAP);
    const share = a.total ? a.explicit / a.total : 0;
    const label = a.path.length > 24 ? `…${a.path.slice(-23)}` : a.path;
    body += `<g>
  <text x="${bx}" y="${by + 8}" class="blabel">${esc(label)}</text>
  <text x="${bx + COLS * (D + GAP) - GAP}" y="${by + 8}" class="bpct" text-anchor="end">${Math.round(share * 100)}%</text>
  ${b.svg}
</g>`;
    rowMax = Math.max(rowMax, b.rows * (D + GAP) + 22);
    bx += COL_W;
  });

  if (tailArea) {
    by += rowMax + 52;
    rowMax = 0;
    const wideCols = Math.max(1, Math.floor((W - 2 * PAD) / (D + GAP)));

    // A HARD ROW BUDGET, because one mark per question does not scale. On a repository with
    // hundreds of areas the tail carries tens of thousands of questions, and at one mark each the
    // canvas grew without limit — 400 areas produced a 2,082px page whose subject was a footer.
    // Sixteen thousand marks are not legible anyway, so past the budget each mark stands for
    // several questions and THE LABEL SAYS SO. Downsampling silently would be the dishonest
    // version of the same fix.
    const perMark = Math.max(1, Math.ceil(tailArea.total / (wideCols * TAIL_MAX_ROWS)));
    const scaled: HeroArea = {
      path: tailArea.path,
      total: Math.max(1, Math.round(tailArea.total / perMark)),
      explicit: Math.round(tailArea.explicit / perMark),
      thin: false,
    };
    const b = block(scaled, PAD, by + 22, wideCols, D, GAP);
    const share = tailArea.explicit / tailArea.total;
    const scaleNote = perMark > 1 ? ` · one mark = ${perMark} questions` : '';
    body += `<g>
  <text x="${PAD}" y="${by + 8}" class="blabel">${esc(tailArea.path)} · ${commas(tailArea.total)} questions${scaleNote}</text>
  <text x="${W - PAD}" y="${by + 8}" class="bpct" text-anchor="end">${Math.round(share * 100)}%</text>
  ${b.svg}
</g>`;
    rowMax = b.rows * (D + GAP) + 22;
  }
  const height = by + rowMax + 118;

  // ---- the one-line stat bar ----------------------------------------------------------------
  const barY = 214;
  const barW = W - 2 * PAD;
  const litW = Math.max(2, barW * rate);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-label="Every mechanism question asked about this repository's changes, one mark each, lit if the commit record answered it">
<defs>
  <linearGradient id="hg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${INK}"/><stop offset="1" stop-color="${NAVY}"/>
  </linearGradient>
</defs>
<style>
  #hero text { font-family:${SANS}; fill:${ICE} }
  #hero .kicker { font-size:13px; fill:${TEAL}; letter-spacing:.14em; font-weight:700 }
  #hero .big { font-size:80px; font-weight:800; letter-spacing:-.035em; fill:${AMBER} }
  #hero .big2 { font-size:44px; font-weight:800; letter-spacing:-.025em }
  #hero .lede { font-size:17px; fill:#a9c6d6 }
  #hero .legend { font-size:12.5px; fill:#a9c6d6 }
  #hero .blabel { font-family:${MONO}; font-size:11px; fill:#cfe2ea }
  #hero .bpct { font-size:11.5px; font-weight:800; fill:${AMBER} }
  #hero .foot { font-size:11.5px; fill:#7396ab }
  #hero .lit { fill:${AMBER} }
  #hero .lit-thin { fill:${AMBER_DIM} }
  #hero .unlit { fill:${UNLIT} }
  #hero .unlit-thin { fill:#16344a }
</style>
<g id="hero">
<rect width="${W}" height="${height}" fill="url(#hg)"/>

<text x="${PAD}" y="${PAD + 6}" class="kicker">${esc(m.repo.toUpperCase())} · ${m.windowMonths} MONTHS · ${commas(m.commits)} COMMITS</text>

<text x="${PAD}" y="${PAD + 84}" class="big">${commas(unanswered)}</text>
<text x="${PAD}" y="${PAD + 126}" class="big2">questions about this code</text>
<text x="${PAD}" y="${PAD + 170}" class="big2">have no written answer.</text>

<text x="${W - PAD}" y="${PAD + 60}" class="lede" text-anchor="end">Of ${commas(totalQ)} questions asked about what</text>
<text x="${W - PAD}" y="${PAD + 84}" class="lede" text-anchor="end">changed, the commit history answered</text>
<text x="${W - PAD}" y="${PAD + 108}" class="lede" text-anchor="end"><tspan class="bpct" style="font-size:26px">${commas(totalE)}</tspan> — ${Math.round(rate * 100)}%.</text>

<rect x="${PAD}" y="${barY}" width="${barW}" height="10" rx="5" class="unlit"/>
<rect x="${PAD}" y="${barY}" width="${litW.toFixed(1)}" height="10" rx="5" class="lit"/>
<text x="${PAD}" y="${barY + 34}" class="legend"><tspan class="bpct">▮</tspan> answered by the record &#160;&#160; <tspan fill="${UNLIT}">▮</tspan> not answered &#160;&#160; one mark = one question</text>
<text x="${W - PAD}" y="${barY + 34}" class="legend" text-anchor="end">areas ordered least explained first</text>

${body}

<text x="${PAD}" y="${height - 62}" class="foot">Questions are generated from each change's diff alone and scored against its commit messages by a separate model that never sees the code.</text>
<text x="${PAD}" y="${height - 44}" class="foot">This measures what the record EXPLAINS, not what anyone understood — a written record cannot be evidence of comprehension, which is the point.</text>
<text x="${PAD}" y="${height - 26}" class="foot">Dimmed marks are areas whose estimate is too thin to lean on. Translation and fixture directories excluded. No individual is measured or named.</text>
</g>
</svg>`;
}

/**
 * Alternative hero: the swarm.
 *
 * Same data, a different rhetorical move. The dot field argues by MASS — here is the volume of
 * what went unexplained. The swarm argues by SPREAD — your codebase is not uniformly anything, and
 * these particular corners of it are dark while others are lit.
 *
 * One circle per area, positioned by the share explained, area proportional to lines changed, so
 * a big poorly-explained directory is a large dark disc sitting on the left. Collision resolution
 * is a simple downhill relaxation: circles keep their x and are nudged in y until they stop
 * overlapping, which preserves the axis that carries meaning and spends only the axis that does
 * not. No gridlines, no ticks beyond four labels, no rows of text.
 *
 * Colour diverges teal-to-amber about the repository's own median rather than a fixed point, so
 * the picture cannot be argued with on where the neutral sits — it is wherever this codebase
 * actually is. Blue-versus-yellow again, for the accessibility reason.
 */
export function renderSwarm(areas: HeroArea[], m: HeroMeta, opts: { width?: number } = {}): string {
  const W = opts.width ?? 1200;
  const H = 700;
  const PAD = 64;
  const usable = areas.filter((a) => a.total > 0);
  const totalQ = usable.reduce((n, a) => n + a.total, 0);
  const totalE = usable.reduce((n, a) => n + a.explicit, 0);
  const rate = totalQ ? totalE / totalQ : 0;

  const rates = usable.map((a) => a.explicit / a.total).sort((x, y) => x - y);
  const median = rates[Math.floor(rates.length / 2)] ?? 0;
  const lo = 0;
  const hi = Math.max(0.05, Math.ceil(Math.max(...rates) * 20) / 20);

  const plotL = PAD + 12;
  const plotR = W - PAD - 12;
  const bandTop = 200;
  const bandBot = H - 108;
  const cy0 = (bandTop + bandBot) / 2;
  const xs = (v: number) => plotL + ((v - lo) / (hi - lo)) * (plotR - plotL);

  // Radius on area, not on diameter — a directory with four times the change should look four
  // times the size, and doubling a radius quadruples the ink.
  const wMax = Math.max(...usable.map((a) => a.total));
  const rr = (t: number) => 7 + 26 * Math.sqrt(t / wMax);

  // Downhill relaxation. x is meaning and is never moved; y is free.
  type Node = { a: HeroArea; x: number; y: number; r: number };
  const nodes: Node[] = [...usable]
    .sort((a, b) => b.total - a.total)
    .map((a) => ({ a, x: xs(a.explicit / a.total), y: cy0, r: rr(a.total) }));
  // CLAMPED, which the first version was not — discs drifted to y=757 inside a 620-tall canvas,
  // over the headline at one end and off the page at the other. Every pass pins y back inside the
  // band, so relaxation can only ever redistribute within the space that exists. A few residual
  // overlaps in a crowded column are a far smaller problem than a disc rendered off-canvas.
  const clamp = (n: Node) => {
    n.y = Math.min(bandBot - n.r, Math.max(bandTop + n.r, n.y));
  };
  for (let pass = 0; pass < 600; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const p = nodes[i]!;
        const q = nodes[j]!;
        const dy = q.y - p.y;
        const need = p.r + q.r + 2.5;
        const dist = Math.hypot(q.x - p.x, dy) || 0.01;
        if (dist < need) {
          const push = (need - dist) / 2;
          const uy = dy === 0 ? (i % 2 ? 1 : -1) : dy / dist;
          p.y -= uy * push;
          q.y += uy * push;
          clamp(p);
          clamp(q);
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  for (const n of nodes) clamp(n);

  const band = (v: number) => {
    const t = median === 0 ? 1 : v / median;
    if (t < 0.5) return 'd0';
    if (t < 0.85) return 'd1';
    if (t < 1.15) return 'd2';
    if (t < 1.6) return 'd3';
    return 'd4';
  };

  const discs = nodes
    .map(
      (n) =>
        `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r.toFixed(1)}" class="${
          n.a.thin ? 'dthin' : band(n.a.explicit / n.a.total)
        }"/>`
    )
    .join('');

  // Label only the discs big enough to carry text, and only on the dark side where the argument is.
  const labels = nodes
    .filter((n) => n.r > 15 && n.a.explicit / n.a.total <= median && !n.a.thin)
    .slice(0, 6)
    .map((n) => {
      const t = n.a.path.length > 22 ? `…${n.a.path.slice(-21)}` : n.a.path;
      return `<text x="${n.x.toFixed(1)}" y="${(n.y + n.r + 15).toFixed(1)}" class="slabel" text-anchor="middle">${esc(t)}</text>`;
    })
    .join('');

  let ticks = '';
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    ticks += `<text x="${xs(v).toFixed(1)}" y="${H - 74}" class="tick" text-anchor="middle">${Math.round(v * 100)}%</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="One circle per area, placed by how much of its change the record explains and sized by how much changed">
<defs><linearGradient id="sg" x1="0" y1="0" x2="1" y2="0">
  <stop offset="0" stop-color="${INK}"/><stop offset="1" stop-color="#0f3854"/>
</linearGradient></defs>
<style>
  #sw text { font-family:${SANS}; fill:${ICE} }
  #sw .kicker { font-size:13px; fill:${TEAL}; letter-spacing:.14em; font-weight:700 }
  #sw .big { font-size:58px; font-weight:800; letter-spacing:-.03em }
  #sw .amber { fill:${AMBER} }
  #sw .lede { font-size:16px; fill:#a9c6d6 }
  #sw .slabel { font-family:${MONO}; font-size:10.5px; fill:#bcd6e2 }
  #sw .tick { font-size:12px; fill:#7396ab; font-variant-numeric:tabular-nums }
  #sw .foot { font-size:11.5px; fill:#7396ab }
  #sw .d0 { fill:#f0a94a } #sw .d1 { fill:#c98f52 } #sw .d2 { fill:#6f8fa2 }
  #sw .d3 { fill:#4a90ab } #sw .d4 { fill:#7fc4d8 }
  #sw .dthin { fill:none; stroke:#3a6d86; stroke-width:1.5; stroke-dasharray:3 3 }
  #sw .axis { stroke:#1c4460; stroke-width:1 }
  #sw .med { stroke:#a9c6d6; stroke-width:1; stroke-dasharray:5 4; opacity:.6 }
</style>
<g id="sw">
<rect width="${W}" height="${H}" fill="url(#sg)"/>
<text x="${PAD}" y="${PAD - 6}" class="kicker">${esc(m.repo.toUpperCase())} · ${m.windowMonths} MONTHS · ${commas(m.commits)} COMMITS</text>
<text x="${PAD}" y="${PAD + 56}" class="big">Some corners of this codebase</text>
<text x="${PAD}" y="${PAD + 112}" class="big">explain <tspan class="amber">almost nothing</tspan> of what</text>
<text x="${PAD}" y="${PAD + 168}" class="big">they change.</text>
<text x="${W - PAD}" y="${PAD + 40}" class="lede" text-anchor="end">${usable.length} areas · ${commas(totalQ)} questions</text>
<text x="${W - PAD}" y="${PAD + 64}" class="lede" text-anchor="end">${Math.round(rate * 100)}% answered overall</text>
<text x="${W - PAD}" y="${PAD + 88}" class="lede" text-anchor="end">circle size = lines changed</text>

<line x1="${plotL}" y1="${H - 96}" x2="${plotR}" y2="${H - 96}" class="axis"/>
<line x1="${xs(median).toFixed(1)}" y1="180" x2="${xs(median).toFixed(1)}" y2="${H - 96}" class="med"/>
<text x="${xs(median).toFixed(1)}" y="172" class="tick" text-anchor="middle">median ${Math.round(median * 100)}%</text>
${discs}${labels}${ticks}
<text x="${plotL}" y="${H - 52}" class="tick">← less of the change explained</text>
<text x="${plotR}" y="${H - 52}" class="tick" text-anchor="end">more explained →</text>
<text x="${PAD}" y="${H - 26}" class="foot">Questions come from each diff alone and are scored against commit messages by a model that never sees the code. Dashed circles are estimates too thin to lean on. No individual is measured.</text>
</g>
</svg>`;
}
