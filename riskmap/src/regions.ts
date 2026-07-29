/**
 * Step 3 — the unit of analysis.
 *
 * DIRECTORY, NOT FILE. Two reasons, and the second is the one that actually forces it.
 *
 *   Renames make file-level history unreliable. `git log --follow` handles a single path at a
 *   time and guesses at the rename chain; run it over ten thousand files and the guesses
 *   compound into a history that is confidently wrong. Directories survive renames of their
 *   contents, so a rename inside a region is invisible to the region.
 *
 *   Ten regions, not four hundred cells. The value of this artifact is triage. A file-level
 *   map of a real repository is a wall of colour, which is a screenshot, not a decision.
 *
 * ── WHY A SINGLE GLOBAL DEPTH DOES NOT WORK ───────────────────────────────────────────────
 *
 * The obvious implementation picks one depth for the whole repository. Run it on Grafana and
 * the choice is between 17 regions at depth 1 and 114 at depth 2 — nothing lands in the 20-60
 * band, and the closest option puts 7,527 commits into a single region called `pkg`. That
 * region is too big to act on, and averaging over it washes out exactly the ownership signal
 * the map exists to find. Depth 2 is no better: 114 rows is the wall of colour.
 *
 * That is not a tuning problem, it is a shape problem. Real repositories are lopsided — `pkg`
 * and `public` hold thousands of commits while `hack` and `packaging` hold dozens — and no
 * single depth is right for both ends of that distribution.
 *
 * So regions are cut at MIXED DEPTH. Start at the top level and repeatedly split the largest
 * region that has at least two substantial children, until the count lands in the target band.
 * Grafana comes out with `pkg/services` and `pkg/tsdb` as their own regions while `hack` stays
 * whole, which is what a person familiar with the codebase would have drawn by hand.
 *
 * A split KEEPS THE PARENT as a residual region. Longest-prefix matching sends edits under a
 * qualifying child to the child, and everything else in the parent stays in the parent, so no
 * edit is ever lost and small subdirectories are not promoted into rows of their own.
 */

import type { Edit } from './types.js';

export const TARGET_MIN = 20;
export const TARGET_MAX = 60;
/** Splitting stops once the count reaches this. Mid-band, not an optimum. */
export const TARGET_IDEAL = 32;
export const ROOT = '(root)';
/** Hard stop on nesting, so a pathological tree cannot run away. */
export const MAX_DEPTH = 6;
/**
 * No region should hold more than this share of the repository's commits while it is still
 * splittable. A row covering 40% of the codebase has triaged nothing, and it is precisely the
 * row where a reader needs detail most.
 */
export const MAX_REGION_SHARE = 0.15;
/** Absolute ceiling on regions, so splitting a dominant region cannot run away. */
export const HARD_MAX = 80;

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function depthOf(region: string): number {
  return region === ROOT ? 0 : region.split('/').length;
}

export function parentOf(region: string): string | null {
  if (region === ROOT) return null;
  const i = region.lastIndexOf('/');
  return i < 0 ? ROOT : region.slice(0, i);
}

/** The region a path belongs to at a fixed depth. Retained for the validation harness. */
export function regionOf(path: string, depth: number): string {
  const dir = dirOf(path);
  if (dir === '') return ROOT;
  const parts = dir.split('/');
  return parts.slice(0, Math.min(depth, parts.length)).join('/');
}

/** Longest-prefix match of a path against the region set. */
export function regionFor(path: string, regions: Set<string>): string {
  let d = dirOf(path);
  while (d !== '') {
    if (regions.has(d)) return d;
    const i = d.lastIndexOf('/');
    if (i < 0) break;
    d = d.slice(0, i);
  }
  return regions.has(d) && d !== '' ? d : ROOT;
}

/** Prefix of `path`'s directory one level below `region`, or null if it has no such child. */
function childUnder(path: string, region: string): string | null {
  const dir = dirOf(path);
  if (region === ROOT) {
    if (dir === '') return null;
    return dir.split('/')[0] ?? null;
  }
  if (dir === region) return null;
  if (!dir.startsWith(`${region}/`)) return null;
  const rest = dir.slice(region.length + 1);
  const first = rest.split('/')[0];
  return first ? `${region}/${first}` : null;
}

export interface Partition {
  regions: Set<string>;
  /** Region counts after each split, so the choice is inspectable rather than magic. */
  trace: { step: number; split: string | null; regions: number }[];
  /** True when splitting ran out before reaching the target band. */
  fallback: boolean;
  maxDepth: number;
}

export interface PartitionOpts {
  minCommits: number;
  targetMin?: number;
  targetIdeal?: number;
  /** Cut every region at this fixed depth instead of adapting. Escape hatch. */
  forcedDepth?: number;
}

/**
 * Partition the tree into regions at mixed depth.
 *
 * Largest-first is the right split order because it is the big regions that are useless to a
 * reader: a 7,000-commit region says "this repository has code in it". Splitting the largest
 * one repeatedly converges on a set where no single row dominates.
 */
export function partitionRegions(edits: Edit[], opts: PartitionOpts): Partition {
  const targetMin = opts.targetMin ?? TARGET_MIN;
  const targetIdeal = opts.targetIdeal ?? TARGET_IDEAL;

  if (opts.forcedDepth !== undefined) {
    const regions = new Set<string>();
    for (const e of edits) regions.add(regionOf(e.path, opts.forcedDepth));
    return {
      regions,
      trace: [{ step: 0, split: null, regions: regions.size }],
      fallback: false,
      maxDepth: opts.forcedDepth,
    };
  }

  // Seed with the top level.
  const regions = new Set<string>([ROOT]);
  for (const e of edits) {
    const top = childUnder(e.path, ROOT);
    if (top) regions.add(top);
  }

  const trace: { step: number; split: string | null; regions: number }[] = [
    { step: 0, split: null, regions: regions.size },
  ];

  const commitsIn = (region: string): Map<string | null, Set<string>> => {
    // Distinct commits per child of `region`, with null for edits that stay in the residual.
    const m = new Map<string | null, Set<string>>();
    for (const e of edits) {
      if (regionFor(e.path, regions) !== region) continue;
      const child = childUnder(e.path, region);
      let s = m.get(child);
      if (!s) {
        s = new Set();
        m.set(child, s);
      }
      s.add(e.sha);
    }
    return m;
  };

  const totalCommits = new Set(edits.map((e) => e.sha)).size;

  let step = 0;
  let fallback = false;
  for (;;) {
    // Size every current region, then try the largest first.
    const sizes = new Map<string, Set<string>>();
    for (const e of edits) {
      const r = regionFor(e.path, regions);
      let s = sizes.get(r);
      if (!s) {
        s = new Set();
        sizes.set(r, s);
      }
      s.add(e.sha);
    }

    // TWO STOPPING CONDITIONS, because counting regions alone is not enough.
    //
    // Count the regions that will SURVIVE the fold, not the raw set: grafana seeds with 33
    // top-level directories, twelve of which are below the commit floor and disappear, so a
    // naive count says "already in band" and the loop never runs — leaving `public` holding
    // 15,137 commits in one row.
    //
    // And keep splitting while any single region dominates, however many regions exist. A
    // partition of thirty rows where one holds 40% of the repository has not triaged anything;
    // that row is where a reader needs the detail most and is exactly where they get none.
    const live = [...sizes.entries()].filter(([, s]) => s.size >= opts.minCommits);
    const liveCount = live.length;
    const largestShare = live.length ? Math.max(...live.map(([, s]) => s.size)) / totalCommits : 0;
    if (liveCount >= targetIdeal && largestShare <= MAX_REGION_SHARE) break;

    const order = [...sizes.entries()]
      .sort((a, b) => b[1].size - a[1].size)
      .map(([r]) => r)
      .filter((r) => depthOf(r) < MAX_DEPTH);

    let didSplit = false;
    for (const region of order) {
      const children = commitsIn(region);
      const qualifying = [...children.entries()]
        .filter(([c, s]) => c !== null && s.size >= opts.minCommits)
        .sort((a, b) => b[1].size - a[1].size)
        .map(([c]) => c as string);
      // Splitting is only worth it if it produces at least two substantial children; one
      // child just renames the region and leaves the same lump behind.
      if (qualifying.length < 2) continue;

      // PARTIAL SPLITS. A big region can have forty qualifying children — `pkg` does on
      // grafana — and refusing to split it because the full fan-out would overshoot the cap
      // leaves the 16,000-commit lump intact and the map useless. Take the largest children
      // that fit and leave the rest in the residual parent: promoting the biggest subtrees is
      // most of the value, and the tail was never going to be read anyway.
      //
      // A DOMINANT REGION OVERRIDES THE COUNT TARGET. The 20-60 band governs the granularity
      // of the analysis, not the page — the page shows ten rows whatever the partition. So
      // when the two constraints conflict, dominance wins: `public/app` holding 39% of
      // grafana's commits is a worse failure than seventy rows in a JSON file nobody reads.
      // HARD_MAX still bounds it so a pathological tree cannot run away.
      const dominant = (sizes.get(region)?.size ?? 0) / totalCommits > MAX_REGION_SHARE;
      const ceiling = dominant ? HARD_MAX : TARGET_MAX;
      const room = ceiling - regions.size;
      if (room < 2) continue;
      const take = qualifying.slice(0, room);
      for (const c of take) regions.add(c);
      step++;
      trace.push({ step, split: region, regions: regions.size });
      didSplit = true;
      break;
    }
    if (!didSplit) {
      fallback = regions.size < targetMin;
      break;
    }
  }

  // Drop regions that ended up with nothing: a parent all of whose children qualified.
  const live = new Set<string>();
  for (const e of edits) live.add(regionFor(e.path, regions));
  for (const r of [...regions]) if (!live.has(r)) regions.delete(r);

  let maxDepth = 0;
  for (const r of regions) maxDepth = Math.max(maxDepth, depthOf(r));

  return { regions, trace, fallback, maxDepth };
}

/**
 * Fold regions that never reached the commit floor into their parent.
 *
 * A directory with four commits has no distribution to speak of — its concentration is 1.0 by
 * arithmetic rather than by risk — so shipping it would fill the top ten with noise.
 */
export function foldSmallRegions(edits: Edit[], partition: Partition, minCommits: number): Set<string> {
  const regions = new Set(partition.regions);
  for (let pass = 0; pass < MAX_DEPTH + 1; pass++) {
    const counts = new Map<string, Set<string>>();
    for (const e of edits) {
      const r = regionFor(e.path, regions);
      let s = counts.get(r);
      if (!s) {
        s = new Set();
        counts.set(r, s);
      }
      s.add(e.sha);
    }
    let moved = false;
    for (const [r, s] of counts) {
      if (s.size >= minCommits || r === ROOT) continue;
      regions.delete(r);
      moved = true;
    }
    if (!moved) break;
  }
  regions.add(ROOT);
  return regions;
}
