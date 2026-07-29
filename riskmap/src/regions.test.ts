/**
 * Region tests.
 *
 * The rollup is where a monorepo either works or produces one giant `src`, and where a flat
 * repository either works or produces four hundred cells. Both failures look like a working
 * tool right up until someone reads the output.
 *
 * The lopsided case below is the one that forced mixed-depth regions: it is Grafana's shape,
 * where a single-depth cut offers a choice between 17 regions and 114 and neither is usable.
 */

import {
  partitionRegions,
  foldSmallRegions,
  regionFor,
  regionOf,
  parentOf,
  depthOf,
  ROOT,
  TARGET_MIN,
  TARGET_MAX,
} from './regions.js';
import type { Edit } from './types.js';

let failures = 0;
function ok(name: string, cond: boolean) {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

function edits(spec: [path: string, commits: number][]): Edit[] {
  const out: Edit[] = [];
  let n = 0;
  for (const [path, commits] of spec) {
    for (let i = 0; i < commits; i++) {
      out.push({ sha: `c${n++}`, who: 'w', at: 0, path, added: 1, deleted: 0 });
    }
  }
  return out;
}

const countRegions = (e: Edit[], set: Set<string>) => {
  const m = new Map<string, Set<string>>();
  for (const ed of e) {
    const r = regionFor(ed.path, set);
    let s = m.get(r);
    if (!s) {
      s = new Set();
      m.set(r, s);
    }
    s.add(ed.sha);
  }
  return m;
};

console.log('region tests');

ok('regionOf cuts at depth', regionOf('src/api/handlers/user.ts', 2) === 'src/api');
ok('regionOf on a root file returns (root)', regionOf('README.md', 2) === ROOT);
ok('parentOf climbs', parentOf('src/api/handlers') === 'src/api');
ok('parentOf at depth one reaches root', parentOf('src') === ROOT);
ok('parentOf of root is null', parentOf(ROOT) === null);
ok('depthOf counts segments', depthOf('a/b/c') === 3 && depthOf(ROOT) === 0);

{
  const set = new Set(['pkg', 'pkg/services']);
  ok('longest prefix wins', regionFor('pkg/services/auth/user.go', set) === 'pkg/services');
  ok('the residual parent catches the rest', regionFor('pkg/api/http.go', set) === 'pkg');
  ok('an unmatched path falls to root', regionFor('README.md', set) === ROOT);
}

{
  // A flat repository: everything under src/, thirty modules. Depth 1 alone gives one region.
  const spec: [string, number][] = [];
  for (let i = 0; i < 30; i++) spec.push([`src/mod${i}/file.ts`, 20]);
  const e = edits(spec);
  const p = partitionRegions(e, { minCommits: 15 });
  ok('a flat repo is split past its single top-level directory', p.regions.size >= TARGET_MIN);
  ok('the flat repo lands inside the band', p.regions.size <= TARGET_MAX);
  ok('splitting is recorded step by step', p.trace.length > 1);
}

{
  // THE MONOREPO CASE: one top-level `packages/`, many packages beneath.
  const spec: [string, number][] = [];
  for (let i = 0; i < 25; i++) spec.push([`packages/pkg${i}/src/index.ts`, 20]);
  const e = edits(spec);
  const p = partitionRegions(e, { minCommits: 15 });
  ok('THE MONOREPO CASE: regions go past the single top-level directory', p.regions.size >= TARGET_MIN);
  ok('the monorepo cut is deeper than one level', p.maxDepth >= 2);
}

{
  // THE LOPSIDED CASE — Grafana's shape. Two huge trees and a handful of tiny ones. A single
  // global depth gives either 5 regions or ~60; mixed depth must split only the big ones.
  const spec: [string, number][] = [];
  for (let i = 0; i < 20; i++) spec.push([`pkg/svc${i}/a.go`, 40]);
  for (let i = 0; i < 20; i++) spec.push([`public/app${i}/a.ts`, 40]);
  spec.push(['hack/x.sh', 30]);
  spec.push(['packaging/y.sh', 25]);
  spec.push(['scripts/z.sh', 22]);
  const e = edits(spec);
  const p = partitionRegions(e, { minCommits: 15 });
  const set = foldSmallRegions(e, p, 15);
  const counts = countRegions(e, set);

  ok('THE LOPSIDED CASE: region count lands in the target band', counts.size >= TARGET_MIN && counts.size <= TARGET_MAX);
  ok('the big trees were split', [...counts.keys()].some((r) => r.startsWith('pkg/')));
  ok('the small trees were left whole', counts.has('hack') && counts.has('packaging'));
  const biggest = Math.max(...[...counts.values()].map((s) => s.size));
  const total = new Set(e.map((x) => x.sha)).size;
  ok('no single region dominates after splitting', biggest / total < 0.25);
}

{
  const e = edits([['a/b/c/deep.ts', 20]]);
  const p = partitionRegions(e, { minCommits: 15, forcedDepth: 3 });
  ok('a forced depth is respected', p.maxDepth === 3 && !p.fallback);
  ok('a forced depth cuts every region there', p.regions.has('a/b/c'));
}

{
  // Nothing can be split — a two-directory repo. Must return something and say it fell short.
  const e = edits([['a/x.ts', 40], ['b/y.ts', 40]]);
  const p = partitionRegions(e, { minCommits: 15 });
  ok('an unreachable target falls back rather than failing', p.fallback);
  ok('the fallback still produces regions', p.regions.size >= 2);
}

{
  // A region with only ONE substantial child must not be split: that renames the region and
  // leaves the same lump behind.
  const e = edits([
    ['src/big/a.ts', 60],
    ['src/t1/b.ts', 2],
    ['src/t2/c.ts', 2],
    ['other/d.ts', 40],
  ]);
  const p = partitionRegions(e, { minCommits: 15 });
  const set = foldSmallRegions(e, p, 15);
  ok('the tiny siblings did not become regions', !set.has('src/t1') && !set.has('src/t2'));
  ok('their edits land in the residual parent', regionFor('src/t1/b.ts', set) === 'src');
}

{
  // Conservation: every edit must land somewhere, whatever the shape.
  const e = edits([['x/a.ts', 3], ['y/b.ts', 4], ['z/c.ts', 2], ['top.ts', 5]]);
  const p = partitionRegions(e, { minCommits: 15 });
  const set = foldSmallRegions(e, p, 15);
  const total = [...countRegions(e, set).values()].reduce((n, s) => n + s.size, 0);
  ok('no edit is lost when every region is below the floor', total === new Set(e.map((x) => x.sha)).size);
  ok('root always survives as a destination', set.has(ROOT));
}

console.log(failures === 0 ? '\nall region tests passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
