/**
 * Hero geometry tests.
 *
 * Both hero views shipped broken once, and neither failure was visible in the code — only in the
 * rendered output. The dot field declared a 1200x2316 canvas because the pooled "51 other areas"
 * block inherited a 14-column layout and 2,000 marks, making it 143 rows tall. The swarm placed
 * discs at y=757 inside a 620-tall canvas because the collision relaxation had no clamp.
 *
 * A renderer that emits geometry outside its own viewBox is a class of bug that review will not
 * catch and a screenshot will, so it is asserted here instead.
 */

import { renderHero, renderSwarm, type HeroArea, type HeroMeta } from './hero.js';

let failures = 0;
function ok(name: string, cond: boolean) {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const meta: HeroMeta = { repo: 'owner/repo', windowMonths: 24, commits: 41120 };

/** A shape like the real corpus: a dozen small areas plus a long tail. */
function corpus(n: number): HeroArea[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `pkg/area${i}/nested/deeper`,
    total: 20 + ((i * 7) % 40),
    explicit: Math.round((20 + ((i * 7) % 40)) * ((i % 10) / 12)),
    thin: i % 17 === 0,
  }));
}

function bounds(svg: string) {
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)!;
  const W = Number(vb[1]);
  const H = Number(vb[2]);
  let maxX = 0;
  let maxY = 0;
  let minY = Infinity;
  for (const m of svg.matchAll(/<rect[^>]*\sx="([-\d.]+)"[^>]*\sy="([-\d.]+)"[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"/g)) {
    maxX = Math.max(maxX, Number(m[1]) + Number(m[3]));
    maxY = Math.max(maxY, Number(m[2]) + Number(m[4]));
    minY = Math.min(minY, Number(m[2]));
  }
  for (const m of svg.matchAll(/<circle[^>]*cx="([-\d.]+)"[^>]*cy="([-\d.]+)"[^>]*r="([\d.]+)"/g)) {
    maxX = Math.max(maxX, Number(m[1]) + Number(m[3]));
    maxY = Math.max(maxY, Number(m[2]) + Number(m[3]));
    minY = Math.min(minY, Number(m[2]) - Number(m[3]));
  }
  for (const m of svg.matchAll(/<text[^>]*\sy="([-\d.]+)"/g)) maxY = Math.max(maxY, Number(m[1]));
  return { W, H, maxX, maxY, minY };
}

console.log('hero geometry tests');

for (const n of [1, 5, 13, 63, 200]) {
  const areas = corpus(n);

  const dots = renderHero(areas, meta, { width: 1200, namedAreas: 12 });
  const d = bounds(dots);
  ok(`dots n=${n}: nothing drawn past the right edge`, d.maxX <= d.W + 1);
  ok(`dots n=${n}: nothing drawn past the bottom edge`, d.maxY <= d.H + 1);
  ok(`dots n=${n}: canvas stays a sane aspect, not a tower`, d.W / d.H > 0.7);

  const swarm = renderSwarm(areas, meta, { width: 1200 });
  const s = bounds(swarm);
  ok(`swarm n=${n}: no disc above the top edge`, s.minY >= -1);
  ok(`swarm n=${n}: no disc below the bottom edge`, s.maxY <= s.H + 1);
}

{
  // THE TOWER CASE, pinned directly: a long tail must not stretch the canvas without limit.
  const small = renderHero(corpus(13), meta, { width: 1200, namedAreas: 12 });
  const huge = renderHero(corpus(400), meta, { width: 1200, namedAreas: 12 });
  const hs = bounds(small).H;
  const hh = bounds(huge).H;
  console.log(`        (13 areas -> ${hs}px tall; 400 areas -> ${hh}px)`);
  ok('THE TOWER CASE: thirty times the areas does not mean thirty times the height', hh < hs * 3);
}

{
  // No person data can appear: the renderers are handed counts and never see an author.
  const svg = renderHero(corpus(20), meta) + renderSwarm(corpus(20), meta);
  ok('no email-shaped string in either hero', !/[\w.]+@[\w.]+/.test(svg));
  ok('neither hero claims anyone "understood" anything', !/\bunderstood\b/.test(svg.replace(/not what anyone understood/g, '')));
}

console.log(failures === 0 ? '\nall hero tests passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
