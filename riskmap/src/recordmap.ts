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
  concurrency?: number;
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
    ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
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


/**
 * The page. One file, no scripts, no external references, openable from an email attachment.
 *
 * When the gate refused there is no treemap — the page says why in plain language instead of
 * drawing something the reader cannot check. That is the whole point of the refusal: a heatmap
 * of an unmeasurable repository is not a caveated map, it is a false one.
 */
export function renderRecordMapPage(map: RecordMap, svg: string): string {
  const esc = (t: string) =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const coloured = map.cells.filter((c) => c.greyReason === null);
  const greyed = map.cells.length - coloured.length;

  const style = `
  :root { --bg:#fff; --fg:#16181d; --muted:#5c6270; --line:#e3e6ea; --card:#fafbfc; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161a; --fg:#e8eaed; --muted:#9aa1ad; --line:#2a2e36; --card:#191c22; }
  }
  * { box-sizing:border-box }
  body { margin:0; padding:2.5rem 1.25rem 4rem; background:var(--bg); color:var(--fg);
         font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif }
  main { max-width:64rem; margin:0 auto }
  h1 { font-size:1.5rem; margin:0 0 .35rem; letter-spacing:-.01em }
  .meta { color:var(--muted); font-size:.85rem; margin:0 0 1.5rem }
  .lede { font-size:1.05rem; max-width:44rem; margin:0 0 1.5rem }
  .big { font-size:1.6rem; font-weight:700 }
  .refusal { background:var(--card); border:1px solid var(--line); border-left:3px solid #8a1c1c;
             padding:1rem 1.1rem; border-radius:3px; margin:0 0 1.5rem }
  .chart { overflow-x:auto; margin:0 0 1.25rem }
  footer { margin-top:2.5rem; padding-top:1.25rem; border-top:1px solid var(--line);
           color:var(--muted); font-size:.82rem }
  footer h2 { font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; margin:1.4rem 0 .45rem }
  footer ul { margin:.4rem 0; padding-left:1.1rem } footer li { margin:.25rem 0 }
  table { border-collapse:collapse; font-size:.82rem; margin:.5rem 0 }
  th,td { text-align:right; padding:.25rem .6rem; border-top:1px solid var(--line) }
  th:first-child,td:first-child { text-align:left }
  code { background:var(--line); padding:.05rem .25rem; border-radius:2px; font-size:.9em }`;

  if (map.refused) {
    return `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Record map — ${esc(map.repo)} — not measurable</title><style>${style}</style>
<main>
  <h1>This repository's commit history cannot be measured this way</h1>
  <p class="meta"><strong>${esc(map.repo)}</strong> · <code>${esc(map.headSha.slice(0, 10))}</code> ·
     ${map.commitsAnalysed.toLocaleString('en-US')} commits examined · ${day(map.generatedAtUtc ? Date.parse(map.generatedAtUtc) : map.asOf)}</p>
  <div class="refusal">
    <p><strong>No map is drawn, deliberately.</strong> ${esc(map.squash.note)}</p>
    <p>A heatmap of this repository would be uniformly alarming, and that colour would be
       measuring the merge configuration rather than anything its authors did or did not write.
       An unmeasurable dimension can be a dash in a table; on a map, colour <em>is</em> the
       message, so the honest output is no map.</p>
  </div>
  <footer>
    <h2>What was tested</h2>
    <p>${(map.squash.substantiveBodyShare * 100).toFixed(1)}% of the last ${map.squash.sampled}
       commits carry a body beyond their subject line. The floor is 10%. The threshold comes from a
       study of 1,000 merged pull requests which rejected three repositories on the same test.</p>
    <p>This check runs before any model call, so nothing was spent producing a map that could not
       be trusted.</p>
  </footer>
</main>`;
  }

  const worst = [...coloured].sort((a, b) => (a.coverage ?? 1) - (b.coverage ?? 1)).slice(0, 5);
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Record map — ${esc(map.repo)}</title><style>${style}</style>
<main>
  <h1>How much of this codebase's change its commit history explains</h1>
  <p class="meta"><strong>${esc(map.repo)}</strong> · <code>${esc(map.headSha.slice(0, 10))}</code> ·
     ${map.windowMonths}-month window ending ${day(map.asOf)} ·
     ${map.commitsAnalysed.toLocaleString('en-US')} commits · ${map.cells.length} regions</p>
  ${
    map.overall
      ? `<p class="lede">Across the regions that could be measured, the commit records explain
         <span class="big">${pct(map.overall.rate)}</span> of what changed —
         ${map.overall.explicit.toLocaleString('en-US')} of
         ${map.overall.total.toLocaleString('en-US')} mechanism questions answered outright.</p>`
      : ''
  }
  <div class="chart">${svg}</div>
  ${
    worst.length
      ? `<h2 style="font-size:.95rem;margin:1.5rem 0 .4rem">Least explained, of the regions with a usable estimate</h2>
         <table><thead><tr><th>Region</th><th>Explained</th><th>95% interval</th><th>Questions</th></tr></thead><tbody>
         ${worst
           .map(
             (c) =>
               `<tr><td><code>${esc(c.path)}</code></td><td>${pct(c.coverage!)}</td><td>${pct(c.ciLo!)} – ${pct(c.ciHi!)}</td><td>${c.questions}</td></tr>`
           )
           .join('')}
         </tbody></table>`
      : ''
  }
  <footer>
    <h2>How to read this</h2>
    <ul>
      <li><strong>Size</strong> is lines changed in the window — how much change the record had to explain.</li>
      <li><strong>Colour</strong> is the share of mechanism questions about those changes that the
        commit messages answer outright. It is an absolute share, not a rank.</li>
      <li><strong>A border</strong> marks a region changed in the last ${map.recentMonths} months.</li>
      <li><strong>Hatched grey</strong> means the estimate is too thin to colour — fewer than
        ${MIN_SCORED_COMMITS} scorable commits, or a 95% interval wider than
        ±${(MAX_CI_HALF_WIDTH * 100).toFixed(0)} points. ${greyed} of ${map.cells.length} regions here.
        A map that coloured those would be inventing confidence it has not earned.</li>
    </ul>
    <h2>What this is not</h2>
    <p>This is a map of <strong>what the record explains</strong>. It is not a map of what anyone
       understands, and the difference is the point: a written record cannot be evidence that a
       person understood a change, which is the central finding of the study behind this
       measurement. It contains no information about individuals — no authorship, no ownership, no
       activity — and none was collected.</p>
    <h2>Method</h2>
    <p>For a seeded sample of up to ${DEFAULT_PER_REGION} commits per region, mechanism questions
       are generated <em>from the diff alone</em> by the same generator the product ships, then the
       commit message is scored against them by a second model that never sees the code. A tripped
       separation guard aborts the run rather than warning.</p>
    <p>Body density here is ${(map.squash.substantiveBodyShare * 100).toFixed(1)}% of the last
       ${map.squash.sampled} commits, above the 10% floor below which no map is drawn.</p>
    ${
      map.calibration
        ? `<h2>Calibration</h2>
           <p>For context rather than for colour: against ${map.calibration.n.toLocaleString('en-US')}
              merged pull requests from five large open-source projects,
              ${(map.calibration.shareAtZero * 100).toFixed(1)}% of which explain nothing at all.
              Percentiles against that corpus are in the JSON alongside this page.</p>
           <p><strong>One known bias.</strong> That corpus scores pull-request records — description
              plus commit messages — while this scores commit messages only, because a clone is the
              whole input and descriptions are not in one. Commit-only is a subset, so every cell
              here reads lower than the corpus comparison implies. The magnitude is being measured
              separately; until it is, treat the colours as comparable to each other and not to the
              corpus.</p>`
        : ''
    }
  </footer>
</main>`;
}
