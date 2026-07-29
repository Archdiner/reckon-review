/**
 * Treemap tests.
 *
 * Two classes of failure are being guarded against here, and they are not equally bad.
 *
 * The geometry failures — overlapping rectangles, an unconserved total, a sliver — are visible.
 * Someone opens the picture, sees a gap, and stops trusting it. They are tested first because
 * they are easy to test, not because they matter most.
 *
 * The failure that matters is the one nobody would see: a cell resting on two commits painted
 * the same confident colour as a cell resting on two hundred, or a legend that quietly promotes
 * "the record explains this" into "somebody understood this". Both produce a picture that looks
 * exactly as correct as a correct one. The last three blocks are about those.
 */

import {
  squarify,
  aspectRatio,
  renderTreemapSvg,
  isThinEstimate,
  coverageStep,
  coverageLabel,
  planLabel,
  relativeLuminance,
  contrastRatio,
  labelInkFor,
  esc,
  LIGHT_RAMP,
  DARK_RAMP,
  MIN_SCORED_COMMITS,
  MAX_CI_HALF_WIDTH,
  COVERAGE_STEPS,
  type TreemapCell,
  type TreemapRect,
} from './treemap.js';

let failures = 0;
function ok(name: string, cond: boolean) {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

/** A cell with a solid estimate, so the defaults never accidentally exercise the grey path. */
function cell(path: string, weight: number, over: Partial<TreemapCell> = {}): TreemapCell {
  return {
    path,
    weight,
    coverage: 0.5,
    ciHalfWidth: 0.05,
    scoredCommits: 40,
    active: false,
    ...over,
  };
}

const cells = (weights: number[]): TreemapCell[] =>
  weights.map((w, i) => cell(`region/r${i}`, w));

function overlapArea(a: TreemapRect, b: TreemapRect): number {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > 0 && oy > 0 ? ox * oy : 0;
}

function worstOverlap(rects: TreemapRect[]): number {
  let worst = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const o = overlapArea(rects[i], rects[j]);
      if (o > worst) worst = o;
    }
  }
  return worst;
}

const totalArea = (rects: TreemapRect[]) => rects.reduce((s, r) => s + r.w * r.h, 0);

function insideCanvas(rects: TreemapRect[], W: number, H: number, eps = 1e-9): boolean {
  return rects.every(
    (r) => r.x >= -eps && r.y >= -eps && r.x + r.w <= W + eps && r.y + r.h <= H + eps && r.w >= 0 && r.h >= 0
  );
}

console.log('treemap tests');

// ---------------------------------------------------------------------------------------------
console.log('\n geometry');

{
  const W = 800;
  const H = 500;
  const input = cells([100, 62, 55, 41, 33, 28, 22, 19, 14, 9, 7, 4, 3, 2, 1]);
  const rects = squarify(input, W, H);

  ok('one rectangle per cell', rects.length === input.length);
  ok('area is conserved', Math.abs(totalArea(rects) - W * H) < 1e-6 * W * H);
  ok('no two rectangles overlap', worstOverlap(rects) < 1e-6);
  ok('every rectangle lies inside the canvas', insideCanvas(rects, W, H));

  // Area proportional to weight, cell by cell — the one property a reader is entitled to assume.
  const total = input.reduce((s, c) => s + c.weight, 0);
  const byPath = new Map(rects.map((r) => [r.path, r]));
  const worstErr = Math.max(
    ...input.map((c) => Math.abs(byPath.get(c.path)!.w * byPath.get(c.path)!.h - (c.weight / total) * W * H))
  );
  ok('each area is proportional to its weight', worstErr < 1e-6 * W * H);

  // Every point of the canvas is covered: conserved area plus no overlap already implies it, but
  // only if nothing sits outside, which is checked above. Spot-check the four corners are owned.
  const owns = (x: number, y: number) =>
    rects.some((r) => x >= r.x - 1e-9 && x <= r.x + r.w + 1e-9 && y >= r.y - 1e-9 && y <= r.y + r.h + 1e-9);
  ok('the canvas is tiled to its corners', owns(0, 0) && owns(W, 0) && owns(0, H) && owns(W, H));
}

{
  const rects = squarify([cell('only', 17)], 300, 200);
  const r = rects[0];
  ok(
    'a single cell fills the canvas',
    rects.length === 1 && r.x === 0 && r.y === 0 && r.w === 300 && r.h === 200
  );
}

{
  ok('an empty input gives an empty layout', squarify([], 100, 100).length === 0);

  let threw = false;
  try {
    squarify([cell('a', 0)], 100, 100);
  } catch {
    threw = true;
  }
  ok('a non-positive weight is refused rather than dropped', threw);

  let threw2 = false;
  try {
    squarify([cell('a', 1)], 0, 100);
  } catch {
    threw2 = true;
  }
  ok('a degenerate canvas is refused', threw2);
}

{
  // Deterministic order regardless of input order, and descending by weight.
  const a = squarify(cells([5, 5, 5, 9, 1]), 400, 300);
  const shuffled = [...cells([5, 5, 5, 9, 1])].reverse();
  const b = squarify(shuffled, 400, 300);
  ok(
    'layout does not depend on input order',
    JSON.stringify(a) === JSON.stringify(b)
  );
}

// ---------------------------------------------------------------------------------------------
console.log('\n aspect ratios — the reason for squarifying at all');

{
  // WILDLY UNEQUAL WEIGHTS. This is the realistic shape: one region holds a third of the churn
  // and the tail is dust. Slice-and-dice turns the tail into hairlines; squarified must not.
  const weights = [4000, 1200, 900, 700, 500, 380, 300, 240, 190, 150, 120, 95, 70, 55, 40, 30, 20, 12, 8, 5];
  const W = 900;
  const H = 560;
  const rects = squarify(cells(weights), W, H);
  const ratios = rects.map(aspectRatio).sort((x, y) => x - y);
  const median = ratios[Math.floor(ratios.length / 2)];
  const p90 = ratios[Math.floor(ratios.length * 0.9)];

  ok(`median aspect ratio is near 1 (${median.toFixed(2)})`, median < 2);
  ok(`the 90th percentile aspect ratio is bounded (${p90.toFixed(2)})`, p90 < 4);
  ok(`the worst aspect ratio is not a sliver (${Math.max(...ratios).toFixed(2)})`, Math.max(...ratios) < 8);

  // The big cells are the ones a reader compares by eye, so they are the ones that must be
  // square-ish.
  const byPath = new Map(rects.map((r) => [r.path, r]));
  const topTen = cells(weights)
    .sort((x, y) => y.weight - x.weight)
    .slice(0, 10)
    .map((c) => aspectRatio(byPath.get(c.path)!));
  ok(`the ten largest are all square-ish (worst ${Math.max(...topTen).toFixed(2)})`, Math.max(...topTen) < 3);

  ok('area is still conserved under a heavy tail', Math.abs(totalArea(rects) - W * H) < 1e-6 * W * H);
  ok('no overlap under a heavy tail', worstOverlap(rects) < 1e-6);
}

{
  // A very wide canvas. min(w,h) picks the short side every time, or rows run the wrong way and
  // every rectangle becomes a column the full height of the map.
  const rects = squarify(cells([50, 30, 20, 10, 5, 5, 3, 2]), 1600, 200);
  const median = rects.map(aspectRatio).sort((a, b) => a - b)[Math.floor(rects.length / 2)];
  ok(`a 8:1 canvas still squarifies (median ${median.toFixed(2)})`, median < 2.5);
  ok('a wide canvas is tiled exactly', Math.abs(totalArea(rects) - 1600 * 200) < 1e-6 * 1600 * 200);
}

{
  // TERMINATION on 200 cells, with a power-law tail. A layout loop that fails to advance hangs
  // the whole build, so this is a liveness test as much as a correctness one.
  const weights: number[] = [];
  for (let i = 0; i < 200; i++) weights.push(1000 / Math.pow(i + 1, 1.4));
  const W = 960;
  const H = 600;
  const t0 = Date.now();
  const rects = squarify(cells(weights), W, H);
  const elapsed = Date.now() - t0;

  ok('200 cells terminate', rects.length === 200);
  ok(`200 cells are laid out promptly (${elapsed}ms)`, elapsed < 2000);
  ok('200 cells conserve area', Math.abs(totalArea(rects) - W * H) < 1e-6 * W * H);
  ok('200 cells do not overlap', worstOverlap(rects) < 1e-6);
  ok('200 cells stay inside the canvas', insideCanvas(rects, W, H));
  ok('no rectangle is degenerate', rects.every((r) => r.w > 0 && r.h > 0));
}

{
  // Identical weights: the classic case where a bad row-break test collapses to one row.
  const rects = squarify(cells(new Array(36).fill(1)), 600, 600);
  const worst = Math.max(...rects.map(aspectRatio));
  ok(`36 equal cells are all near square (worst ${worst.toFixed(2)})`, worst < 2);
  ok('36 equal cells conserve area', Math.abs(totalArea(rects) - 600 * 600) < 1e-6 * 600 * 600);
}

// ---------------------------------------------------------------------------------------------
console.log('\n the greying rule — where a heatmap would ship something false');

{
  const solid = cell('a', 10, { coverage: 0.2, ciHalfWidth: 0.05, scoredCommits: 40 });
  ok('a solid estimate is coloured', !isThinEstimate(solid));
  ok('an unscored cell is grey', isThinEstimate({ ...solid, coverage: null, ciHalfWidth: null }));
  ok(
    `fewer than ${MIN_SCORED_COMMITS} scored commits is grey`,
    isThinEstimate({ ...solid, scoredCommits: MIN_SCORED_COMMITS - 1 })
  );
  ok(
    `exactly ${MIN_SCORED_COMMITS} scored commits is not grey`,
    !isThinEstimate({ ...solid, scoredCommits: MIN_SCORED_COMMITS })
  );
  ok(
    `an interval wider than ±${MAX_CI_HALF_WIDTH} is grey`,
    isThinEstimate({ ...solid, ciHalfWidth: MAX_CI_HALF_WIDTH + 1e-9 })
  );
  ok(
    `an interval of exactly ±${MAX_CI_HALF_WIDTH} is not grey`,
    !isThinEstimate({ ...solid, ciHalfWidth: MAX_CI_HALF_WIDTH })
  );
  ok('the thresholds are the documented ones', MIN_SCORED_COMMITS === 4 && MAX_CI_HALF_WIDTH === 0.15);

  // A thin cell must not be able to borrow a colour from the ramp. This is the assertion that
  // the whole grey rule exists for: a two-commit 0.2 and a two-hundred-commit 0.2 must not look
  // the same.
  const svg = renderTreemapSvg([
    cell('solid/thing', 10, { coverage: 0.2 }),
    cell('thin/thing', 10, { coverage: 0.2, scoredCommits: 2, ciHalfWidth: 0.4 }),
  ]);
  const solidRect = /<rect class="cell (s\d+)"[^>]*><title>solid\/thing/.exec(svg);
  const thinRect = /<rect class="cell (thin)"[^>]*><title>thin\/thing/.exec(svg);
  ok('a solid cell takes a ramp step', solidRect !== null);
  ok('a thin cell takes the hatch, not a ramp step', thinRect !== null);
  ok('the hatch pattern is defined in the document', svg.includes('<pattern id="tm-hatch"'));
  ok('the hatch is drawn as lines, not a flat grey', svg.includes('class="hatch-line"'));
  ok(
    'a thin cell says so in words too',
    coverageLabel(cell('x', 1, { coverage: 0.2, scoredCommits: 2 })).includes('thin')
  );
  ok(
    'an unscored cell says it was not estimated',
    coverageLabel(cell('x', 1, { coverage: null, ciHalfWidth: null })) === 'not estimated'
  );
  ok(
    'a solid cell gets a bare percentage',
    coverageLabel(cell('x', 1, { coverage: 0.18 })) === '18% explained'
  );
}

// ---------------------------------------------------------------------------------------------
console.log('\n colour');

{
  ok('the ramp has one step per ten per cent', LIGHT_RAMP.length === COVERAGE_STEPS && COVERAGE_STEPS === 10);
  ok('both themes have the same number of steps', DARK_RAMP.length === LIGHT_RAMP.length);

  // LIGHTNESS CARRIES THE VALUE. This is what makes the map survive greyscale printing and
  // colour blindness: monotone luminance means the ramp is readable with the hue thrown away.
  const lightLum = LIGHT_RAMP.map(relativeLuminance);
  const darkLum = DARK_RAMP.map(relativeLuminance);
  let lightMono = true;
  let darkMono = true;
  for (let i = 1; i < lightLum.length; i++) {
    if (!(lightLum[i] > lightLum[i - 1])) lightMono = false;
    if (!(darkLum[i] < darkLum[i - 1])) darkMono = false;
  }
  ok('light theme: luminance rises with coverage (dark = alarming)', lightMono);
  ok('dark theme: luminance falls with coverage (bright = alarming)', darkMono);

  // Alarm is contrast against the page, and the page flips between themes. Low coverage must be
  // the loud end in both.
  const white = relativeLuminance('#ffffff');
  const black = relativeLuminance('#14161a');
  const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  ok(
    'light theme: low coverage stands off the page more than high',
    contrast(lightLum[0], white) > contrast(lightLum[COVERAGE_STEPS - 1], white)
  );
  ok(
    'dark theme: low coverage stands off the page more than high',
    contrast(darkLum[0], black) > contrast(darkLum[COVERAGE_STEPS - 1], black)
  );

  // The ends must be far enough apart to be told apart at all, in both themes.
  ok('light theme ends are clearly different', contrast(lightLum[0], lightLum[COVERAGE_STEPS - 1]) > 4.5);
  ok('dark theme ends are clearly different', contrast(darkLum[0], darkLum[COVERAGE_STEPS - 1]) > 4.5);

  // Every label has to be legible on the cell it sits on, in both themes. A label that vanishes
  // into its own fill is the same failure as no label, except it also looks like a rendering bug.
  const worstInk = Math.min(
    ...[...LIGHT_RAMP, ...DARK_RAMP].map((c) => contrastRatio(c, labelInkFor(c)))
  );
  ok(`labels clear 3.5:1 on every ramp step in both themes (worst ${worstInk.toFixed(2)})`, worstInk > 3.5);

  // Absolute share, not a percentile: the step depends only on the value.
  ok('0.00 is the alarming end', coverageStep(0) === 0);
  ok('0.99 is the calm end', coverageStep(0.99) === COVERAGE_STEPS - 1);
  ok('1.00 does not fall off the ramp', coverageStep(1) === COVERAGE_STEPS - 1);
  ok('0.18 lands in the second step', coverageStep(0.18) === 1);
  ok('out-of-range values are clamped rather than crashing', coverageStep(-3) === 0 && coverageStep(9) === 9);
}

// ---------------------------------------------------------------------------------------------
console.log('\n labels stay inside their rectangles');

{
  ok('a rectangle too short for one line gets no label', planLabel({ path: 'a', x: 0, y: 0, w: 400, h: 8 }, cell('a', 1)) === null);
  ok('a rectangle too narrow for the leaf gets no label', planLabel({ path: 'x/y', x: 0, y: 0, w: 10, h: 400 }, cell('x/y', 1)) === null);

  const wide = planLabel({ path: 'pkg/services/auth', x: 0, y: 0, w: 400, h: 60 }, cell('pkg/services/auth', 1));
  ok('a large rectangle shows the full path', wide?.head === 'pkg/services/auth');
  ok('a large rectangle shows the coverage line', wide?.sub === '50% explained');

  const narrow = planLabel({ path: 'pkg/services/auth', x: 0, y: 0, w: 90, h: 60 }, cell('pkg/services/auth', 1));
  ok('a narrower rectangle falls back to the leaf segment', narrow?.head === 'auth');

  const short = planLabel({ path: 'auth', x: 0, y: 0, w: 400, h: 28 }, cell('auth', 1));
  ok('a one-line-tall rectangle drops the coverage line rather than overflowing', short?.head === 'auth' && short?.sub === null);
}

{
  // The real check: render a full map and prove every glyph box lands inside its own rectangle,
  // using the same conservative metrics the renderer used to decide.
  const input: TreemapCell[] = [];
  for (let i = 0; i < 40; i++) {
    input.push(
      cell(`pkg/area${i}/sub${i % 3}`, Math.round(4000 / Math.pow(i + 1, 1.3)), {
        coverage: (i * 7) % 100 / 100,
        scoredCommits: i % 9 === 0 ? 2 : 30,
        ciHalfWidth: i % 11 === 0 ? 0.3 : 0.06,
        active: i % 4 === 0,
      })
    );
  }
  const W = 960;
  const H = 560;
  const rects = squarify(input, W, H);
  const byPath = new Map(input.map((c) => [c.path, c]));

  let escapes = 0;
  let labelled = 0;
  for (const r of rects) {
    const plan = planLabel(r, byPath.get(r.path)!);
    if (!plan) continue;
    labelled++;
    const lines: [string, number][] = [[plan.head, 12]];
    if (plan.sub) lines.push([plan.sub, 10.5]);
    for (const [text, size] of lines) {
      // 6px padding, 0.63em advance — the renderer's own numbers.
      if (6 + text.length * 0.63 * size > r.w) escapes++;
    }
    if (12 * 0.78 + (plan.sub ? 10.5 + 2 + 10.5 * 0.22 : 12 * 0.22) + 12 > r.h) escapes++;
  }
  ok(`some cells are labelled (${labelled} of ${rects.length})`, labelled > 5);
  ok('no label escapes its rectangle', escapes === 0);
  ok('small cells go unlabelled rather than clipped', labelled < rects.length);
}

// ---------------------------------------------------------------------------------------------
console.log('\n the SVG itself');

{
  const input = [
    cell('a&b/<generated>', 40, { coverage: 0.1, active: true }),
    cell('quotes"and\'apostrophes', 20, { coverage: 0.9 }),
    cell('plain/thing', 10, { coverage: null, ciHalfWidth: null, scoredCommits: 0 }),
  ];
  const svg = renderTreemapSvg(input, { subtitle: 'repo & window <24 months>' });

  ok('it is an SVG document', svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  ok('it closes', svg.trimEnd().endsWith('</svg>'));

  // ESCAPING. One raw ampersand makes the document unparseable rather than merely wrong.
  const between = svg.replace(/&(amp|lt|gt|quot|#39);/g, '');
  ok('no unescaped ampersand survives', !between.includes('&'));
  ok('no stray angle bracket from a path', !svg.includes('<generated>'));
  ok('the path is escaped, not dropped', svg.includes('a&amp;b/&lt;generated&gt;'));
  ok('the subtitle is escaped too', svg.includes('repo &amp; window &lt;24 months&gt;'));
  ok('apostrophes are escaped', svg.includes('&#39;'));

  // SELF-CONTAINED. No network, no script, no font file — it has to work as an email attachment.
  ok('no script', !/<script/i.test(svg));
  ok('no external reference', !/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(svg));
  ok('no image or use href', !/xlink:href|<image|<use /.test(svg));
  ok('no @font-face', !/@font-face/i.test(svg));
  ok('only generic font families', /sans-serif/.test(svg) && /monospace/.test(svg));

  // DETERMINISM. "The same clone yields the same map" has to survive the picture too.
  ok('the same input gives the same bytes', renderTreemapSvg(input, { subtitle: 'repo & window <24 months>' }) === svg);
  ok(
    'input order does not change the bytes',
    renderTreemapSvg([...input].reverse(), { subtitle: 'repo & window <24 months>' }) === svg
  );
  ok('no timestamp leaks in', !/20\d\d-\d\d-\d\d/.test(svg));

  // BOTH THEMES, without script.
  ok('a dark theme is shipped in the same file', svg.includes('@media (prefers-color-scheme:dark)'));
  ok('the light ramp is present', LIGHT_RAMP.every((c) => svg.includes(c)));
  ok('the dark ramp is present', DARK_RAMP.every((c) => svg.includes(c)));
  // Every rule is scoped to the root id: inlined into the HTML report, an unscoped `.cell` or
  // `.sub` would restyle the page around it.
  const styleBody = /<style>([\s\S]*?)<\/style>/.exec(svg)?.[1] ?? '';
  const selectors = styleBody
    .replace(/@media\s*\([^)]*\)\s*\{/g, '')
    .split('}')
    .map((chunk) => chunk.split('{')[0].trim())
    .filter((s) => s.length > 0);
  ok('the stylesheet has rules', selectors.length > 20);
  ok(
    'every rule is scoped to this svg',
    selectors.every((s) => s.startsWith('#tm'))
  );

  // ACTIVITY IS A BORDER, NEVER A FILL.
  ok('an active cell gets a dashed outline', /class="active"/.test(svg) && /stroke-dasharray/.test(svg));
  const activeCell = /<rect class="cell (\S+)"[^>]*><title>a&amp;b/.exec(svg);
  ok('an active cell is filled from the coverage ramp like any other', activeCell?.[1] === 's1');

  ok('an empty map still renders', renderTreemapSvg([]).includes('</svg>'));
}

{
  // THE SERIALISED numbers must tile too, not just the floats the layout returned. Rounding x and
  // w independently would leave hundredth-of-a-pixel overlaps between neighbours, which is
  // invisible but means the picture no longer satisfies the property the geometry tests assert.
  const input = cells([4000, 1500, 900, 700, 480, 330, 240, 180, 130, 96, 70, 50, 36, 25, 18, 12]);
  const W = 900;
  const H = 520;
  const svg = renderTreemapSvg(input, { width: W, height: H, title: null, subtitle: null });
  const parsed: TreemapRect[] = [];
  const re = /<rect class="cell \S+" x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g;
  for (let m; (m = re.exec(svg)); ) {
    parsed.push({ path: '', x: +m[1], y: +m[2], w: +m[3], h: +m[4] });
  }
  ok('every cell is serialised', parsed.length === input.length);
  // 1e-9 rather than 0 because two decimal strings that abut exactly still differ by ~1e-13 once
  // this test adds them back up in binary floating point. The point is the two orders of
  // magnitude: rounding width and height independently leaves overlaps around 1 px².
  ok('the serialised rectangles do not overlap', worstOverlap(parsed) < 1e-9);
  ok('the serialised rectangles tile the canvas exactly', Math.abs(totalArea(parsed) - W * H) < 1e-9);
  ok('the serialised rectangles stay inside the canvas', insideCanvas(parsed, W, H, 0));
}

{
  // THE LEGEND, which is the only part a reader is guaranteed to read.
  const svg = renderTreemapSvg([cell('a', 1, { coverage: 0.3 })]);

  ok('the legend explains the colour in absolute terms', svg.includes('explained by the commit record'));
  ok('and says explicitly that it is not a percentile', /not a percentile/.test(svg));
  ok('the legend carries numeric anchors', ['0%', '25%', '50%', '75%', '100%'].every((s) => svg.includes(`>${s}</text>`)));
  ok('the grey swatch is labelled as too thin to estimate', svg.includes('too few commits to estimate'));
  ok('the grey rule prints its own thresholds', svg.includes(`fewer than ${MIN_SCORED_COMMITS} scored commits`) && svg.includes('±15 points'));
  ok('the active border is in the key', svg.includes('changed recently'));
  ok('area is explained', /Area: lines changed in the window/.test(svg));

  // THE LABELLING TRAP. The study argues the record cannot be evidence that a human understood
  // anything, so this artifact may never say it did. If this test fails, the artifact contradicts
  // the project's central claim inside its own legend.
  ok('the word "understood" appears nowhere', !/understood/i.test(svg));
  ok('the word "understand" appears nowhere', !/understand/i.test(svg));
  ok('it never claims knowledge, only a record', !/\bknowledge\b/i.test(svg));

  // NO PERSON DATA, AT ALL. This is the one artifact in the tool with no naming problem, and it
  // stays that way by containing no person-derived field to begin with.
  for (const word of ['author', 'contributor', 'owner', 'ownership', 'departed', 'orphan', 'bus factor', 'committer']) {
    ok(`the map never mentions "${word}"`, !new RegExp(word, 'i').test(svg));
  }
  ok('and it says so', svg.includes('No person data appears in this map'));

  // The input contract itself has no person field. A compile-time fact, asserted so that adding
  // one is a test failure and not a quiet commit.
  const keys = Object.keys(cell('a', 1)).sort().join(',');
  ok(
    'the cell contract carries exactly the six non-person fields',
    keys === 'active,ciHalfWidth,coverage,path,scoredCommits,weight'
  );
}

{
  ok('esc handles every hostile character', esc(`&<>"'`) === '&amp;&lt;&gt;&quot;&#39;');
  ok('esc does not double-escape its own output', esc('a&b').includes('&amp;b'));
}

console.log('\nbrand ramp accessibility');

{
  const mono = (a: number[]) => a.every((v, i) => i === 0 || v >= a[i - 1]!);
  const lumL = LIGHT_RAMP.map(relativeLuminance);
  const lumD = DARK_RAMP.map(relativeLuminance);
  ok('light ramp luminance ascends, so lightness alone carries the signal', mono(lumL));
  ok('dark ramp luminance descends', mono([...lumD].reverse()));

  // THE WCAG FLOOR, PINNED. The brand ramp initially failed this at 4.16 because one step in each
  // direction landed at luminance ~0.19, where neither navy nor ice ink clears 4.5:1. The ramp now
  // steps over that band. Without this test the next palette tweak would silently reintroduce it.
  const worst = Math.min(
    ...[...LIGHT_RAMP, ...DARK_RAMP].map((c) => contrastRatio(c, labelInkFor(c)))
  );
  console.log(`        (worst label contrast across both ramps: ${worst.toFixed(2)}:1)`);
  ok('THE AA FLOOR: every ramp step can carry a legible label', worst >= 4.5);

  // Hue is not allowed to be the carrier: the ramp must stay in one family so that colour vision
  // deficiency does not destroy the reading. Checked as "blue channel is never the smallest".
  const blueLed = [...LIGHT_RAMP, ...DARK_RAMP].every((c) => {
    const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
    return b >= r && b >= g;
  });
  ok('every step stays in the blue family, so hue never carries the signal', blueLed);
}

console.log(failures === 0 ? '\nall treemap tests passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
