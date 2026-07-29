/**
 * The record map: a treemap of the tree, sized by how much changed, coloured by how much of that
 * change the commit record explains.
 *
 * ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ─────────────────────────────────────────
 *
 * It is a map of WHAT THE RECORD EXPLAINS. It is not a map of what anyone understands, and the
 * distinction is not pedantry — the study this calibrates against argues precisely that a written
 * record cannot be evidence that a human understood a change. A legend reading "understood" would
 * contradict the project's own central claim inside the same artifact, and someone would find it.
 *
 * ── WHY IT EXISTS SEPARATELY FROM THE RISK MAP ────────────────────────────────────────────
 *
 * The risk map carries five dimensions, of which exactly one has been shown to discriminate.
 * Everything else in it rests on inferences this session could not validate: a departure proxy
 * whose signal fired 0.25 times per repository, a drive-by problem that took ~70% of the "inactive"
 * population with it, an extancy problem that turned out to be most of the only clean result, and
 * a collider in the analysis. This artifact keeps the dimension that works and drops all of it.
 *
 * WHICH MEANS IT CONTAINS NO PERSON DATA AT ALL. No contributor counts, no ownership, no
 * inactivity. `identity.ts` is not imported and there is nothing here to anonymise, so the naming
 * problem the rest of the tool works to avoid does not arise. That is a property of the design
 * rather than a control on top of it, and it must be preserved: the person-coloured version of
 * this same treemap is the org heat map, and it reintroduces every hazard this one is free of.
 *
 * ── THE THREE THINGS THAT DECIDE WHETHER IT IS HONEST ─────────────────────────────────────
 *
 * 1. THE GATE IS A REFUSAL, NOT A CAVEAT. On a table, an unmeasurable dimension is a dash. Here
 *    colour IS the message, so a repository that squashes to titles renders as uniformly alarming
 *    — a lie, in the one medium where the reader cannot see the missing data. Below the body
 *    density floor this module refuses to draw a treemap at all.
 *
 * 2. THIN ESTIMATES ARE GREYED, NOT COLOURED. Every cell is an estimate from a handful of sampled
 *    commits. A Wilson interval travels with each one, and a cell whose interval is too wide is
 *    hatched grey rather than given a confident block of colour it has not earned.
 *
 * 3. COLOUR IS THE ABSOLUTE SHARE, NEVER THE PERCENTILE. "Your commit history explains 18% of
 *    what changed here" is legible and hard to argue with. "34th percentile" invites "against
 *    which corpus, and why those five repositories". The percentile belongs in the footer, where
 *    a reader who wants the comparison can find it and nobody has to defend it to read the map.
 */

import type { LlmBackend } from '@reckon/core';
import { readLog, readHead, readRepoName, readTreePaths } from './gitlog.js';
import { filterCommits } from './filters.js';
import { partitionRegions, foldSmallRegions, regionFor } from './regions.js';
import { monthsBefore, DEFAULT_THRESHOLDS } from './dimensions.js';
import { detectSquashConvention } from './squash.js';
import { computeCoverage, type RegionCoverage } from './coverage.js';
import { loadCalibration, midrankPercentile, type Calibration } from './calibration.js';
import type { Commit, SquashVerdict } from './types.js';

/** Commits below this and a cell is greyed however tight its arithmetic looks. */
export const MIN_SCORED_COMMITS = 4;
/** Interval half-width above this and the estimate cannot be distinguished from its neighbours. */
export const MAX_CI_HALF_WIDTH = 0.15;

/**
 * FIFTEEN COMMITS PER REGION, AND THE NUMBER IS MEASURED RATHER THAN CHOSEN.
 *
 * The sampling budget and the greying rule are the same decision looked at from two ends, and
 * getting it wrong in either direction ships a useless map: too few commits and almost every cell
 * is greyed, which says nothing; too loose an interval limit and cells get confident colour they
 * have not earned, which says something false.
 *
 * Measured against a live 51-region grafana run, which produced a median of 16 questions from 5
 * commits — so roughly 3.2 questions per commit — the share of cells that earn colour is:
 *
 *   commits/region   limit 0.15   limit 0.20   limit 0.25
 *        5              18%          55%         100%
 *       10              55%         100%         100%
 *       15             100%         100%         100%
 *
 * At 5 commits, 82% of the map would be grey. Relaxing the limit to 0.25 colours everything, but
 * a ±0.25 interval on a [0,1] quantity is not a measurement and colouring it would be the exact
 * dishonesty the greying rule exists to prevent. So the limit stays strict and the sample rises:
 * 15 commits per region, about three times the model cost, which is the right thing to spend it
 * on given coverage is the one dimension shown to discriminate.
 */
export const DEFAULT_PER_REGION = 15;

export interface RecordCell {
  path: string;
  /** Lines changed in the window — the amount of change the record was supposed to explain. */
  weight: number;
  coverage: number | null;
  ciLo: number | null;
  ciHi: number | null;
  ciHalfWidth: number | null;
  scoredCommits: number;
  questions: number;
  /** Changed in the recent sub-window. Carried by the border, never by fill or size. */
  active: boolean;
  /** Percentile against the study corpus. Footer only — never drives colour. */
  percentile: number | null;
  /** Why this cell is grey, when it is. */
  greyReason: 'not-scored' | 'too-few-commits' | 'interval-too-wide' | null;
}

export interface RecordMap {
  repo: string;
  headSha: string;
  asOf: number;
  windowMonths: number;
  recentMonths: number;
  commitsAnalysed: number;
  squash: SquashVerdict;
  /** True when the gate refused. `cells` is then empty and the page explains instead of drawing. */
  refused: boolean;
  cells: RecordCell[];
  /** Weighted overall coverage across scored regions, for the headline sentence. */
  overall: { explicit: number; total: number; rate: number } | null;
  calibration: { corpus: string; n: number; shareAtZero: number } | null;
  generatedAtUtc: string;
}

/**
 * Wilson score interval — not the normal approximation.
 *
 * At the sample sizes here (10-40 questions per region) the normal interval is badly wrong near 0
 * and 1, and near 0 is exactly where the interesting regions are: it produces bounds below zero
 * and understates uncertainty for a region that scored 0 of 16. Wilson stays inside [0,1] and
 * widens properly at the ends, which is the whole reason the interval is being computed.
 */
export function wilson(explicit: number, total: number, z = 1.96): { lo: number; hi: number } {
  if (total <= 0) return { lo: 0, hi: 1 };
  const p = explicit / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return { lo: Math.max(0, centre - spread), hi: Math.min(1, centre + spread) };
}

function greyReasonFor(d: RegionCoverage | undefined, halfWidth: number | null): RecordCell['greyReason'] {
  if (!d) return 'not-scored';
  if (d.commits < MIN_SCORED_COMMITS) return 'too-few-commits';
  if (halfWidth !== null && halfWidth > MAX_CI_HALF_WIDTH) return 'interval-too-wide';
  return null;
}

export interface BuildRecordMapOpts {
  repo: string;
  /** Trailing window the map describes. */
  windowMonths?: number;
  /** Sub-window defining "active". Carried by the border. */
  recentMonths?: number;
  perRegion?: number;
  backend: LlmBackend;
  genBackend: LlmBackend;
  onProgress?: (m: string) => void;
}

export async function buildRecordMap(opts: BuildRecordMapOpts): Promise<RecordMap> {
  const log = opts.onProgress ?? (() => {});
  const windowMonths = opts.windowMonths ?? DEFAULT_THRESHOLDS.windowMonths;
  const recentMonths = opts.recentMonths ?? 3;

  const head = await readHead(opts.repo);
  const repo = await readRepoName(opts.repo);
  const asOf = head.at;
  const windowStart = monthsBefore(asOf, windowMonths);

  log(`reading ${repo}`);
  const raw = await readLog({ repo: opts.repo, after: windowStart });
  const { kept } = filterCommits(
    raw.map((c) => ({ ...c, bot: false })),
    { maxFilesPerCommit: DEFAULT_THRESHOLDS.maxFilesPerCommit, windowStart, windowEnd: asOf }
  );

  // THE GATE, BEFORE ANY MODEL CALL. Spending money to colour a repository whose records cannot
  // be measured would be the expensive way to ship a lie.
  const squash = detectSquashConvention(kept);
  log(`body density ${(squash.substantiveBodyShare * 100).toFixed(1)}% — ${squash.availability}`);
  const base: RecordMap = {
    repo,
    headSha: head.sha,
    asOf,
    windowMonths,
    recentMonths,
    commitsAnalysed: kept.length,
    squash,
    refused: false,
    cells: [],
    overall: null,
    calibration: null,
    generatedAtUtc: new Date().toISOString(),
  };
  if (squash.availability === 'unavailable') {
    log('REFUSING to render: colour would be measuring the merge button');
    return { ...base, refused: true };
  }

  const edits = kept.flatMap((c) =>
    c.files.map((f) => ({
      sha: c.sha,
      who: '',
      at: c.at,
      path: f.path,
      added: f.added,
      deleted: f.deleted,
    }))
  );
  const partition = partitionRegions(edits, { minCommits: DEFAULT_THRESHOLDS.regionMinCommits });
  const regionSet = foldSmallRegions(edits, partition, DEFAULT_THRESHOLDS.regionMinCommits);

  // Only regions that still exist get a cell. A deleted directory has no code left for a record
  // to explain, so colouring it would be a statement about absent files.
  const treePaths = await readTreePaths(opts.repo, 'HEAD').catch(() => new Set<string>());
  const extant = new Set<string>();
  for (const p of treePaths) extant.add(regionFor(p, regionSet));

  const recentStart = monthsBefore(asOf, recentMonths);
  const byRegion = new Map<string, { lines: number; commits: Map<string, Commit>; active: boolean }>();
  const commitsBySha = new Map(kept.map((c) => [c.sha, c]));
  for (const e of edits) {
    const r = regionFor(e.path, regionSet);
    if (!extant.has(r)) continue;
    let a = byRegion.get(r);
    if (!a) {
      a = { lines: 0, commits: new Map(), active: false };
      byRegion.set(r, a);
    }
    a.lines += e.added + e.deleted;
    const c = commitsBySha.get(e.sha);
    if (c) a.commits.set(e.sha, c);
    if (e.at >= recentStart) a.active = true;
  }
  log(`${byRegion.size} extant regions`);

  const commitsFor = new Map<string, Commit[]>();
  for (const [r, a] of byRegion) commitsFor.set(r, [...a.commits.values()]);

  log(`scoring coverage, up to ${opts.perRegion ?? DEFAULT_PER_REGION} commits per region`);
  const result = await computeCoverage(commitsFor, {
    repo: opts.repo,
    backend: opts.backend,
    genBackend: opts.genBackend,
    perRegion: opts.perRegion ?? DEFAULT_PER_REGION,
    maxFilesPerCommit: DEFAULT_THRESHOLDS.maxFilesPerCommit,
    onProgress: log,
  });

  const cal: Calibration | null = loadCalibration();
  const cells: RecordCell[] = [];
  let explicitTotal = 0;
  let questionTotal = 0;

  for (const [path, a] of byRegion) {
    const d = result.detail.get(path);
    let coverage: number | null = null;
    let ciLo: number | null = null;
    let ciHi: number | null = null;
    let half: number | null = null;
    if (d && d.total > 0) {
      coverage = d.rate;
      const w = wilson(d.explicit, d.total);
      ciLo = w.lo;
      ciHi = w.hi;
      half = (w.hi - w.lo) / 2;
      explicitTotal += d.explicit;
      questionTotal += d.total;
    }
    const grey = greyReasonFor(d, half);
    cells.push({
      path,
      weight: Math.max(1, a.lines),
      coverage,
      ciLo,
      ciHi,
      ciHalfWidth: half,
      scoredCommits: d?.commits ?? 0,
      questions: d?.total ?? 0,
      active: a.active,
      percentile: coverage !== null && cal ? midrankPercentile(cal.sorted, coverage) : null,
      greyReason: grey,
    });
  }
  cells.sort((x, y) => y.weight - x.weight);

  const coloured = cells.filter((c) => c.greyReason === null).length;
  log(`${coloured} of ${cells.length} cells carry a usable estimate; ${cells.length - coloured} greyed`);

  return {
    ...base,
    cells,
    overall:
      questionTotal > 0
        ? { explicit: explicitTotal, total: questionTotal, rate: explicitTotal / questionTotal }
        : null,
    calibration: cal ? { corpus: cal.corpus, n: cal.n, shareAtZero: cal.shareAtZero } : null,
  };
}
