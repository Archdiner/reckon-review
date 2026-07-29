/**
 * THE RECORD SWEEP — the same measurement across many repositories.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────
 *
 * Every coverage number on disk came from ONE repository. A single-repository finding invites
 * exactly one reply — "that is grafana, not us" — and there is no answer to it from inside a
 * one-repository dataset. The body-density gate already runs across 24 repositories and shows that
 * most of them CAN be measured; this closes the gap by actually measuring them.
 *
 * It also changes what the data can support. With one repository, the spread across its areas is
 * the only variation there is, and it is impossible to say whether an area at 10% is unusual for
 * that project or unusual full stop. With twenty, between-repository and within-repository variance
 * are separable, and "this area is in the bottom decile ACROSS PROJECTS" becomes a sentence someone
 * can check.
 *
 * ── THE BUDGET DECISION, WHICH IS THE WHOLE DESIGN ────────────────────────────────────────
 *
 * Model calls are the binding constraint, and there are two ways to spend a fixed budget per
 * repository: thin estimates everywhere, or solid estimates on the largest areas. The first is
 * tempting because it produces a complete-looking page. It was measured, and it does not work: at 5
 * sampled commits per area, 82% of cells fail the interval rule and get greyed. A page of grey is
 * not a cheaper map.
 *
 * So the sweep caps AREAS and keeps DEPTH: the largest `maxRegions` areas by lines changed, at the
 * full per-area sample. Both numbers are recorded per repository, and the count of unscored areas
 * travels with the map, so nobody reads a top slice as a whole tree.
 *
 * ── DISK, WHICH IS THE OTHER CONSTRAINT ───────────────────────────────────────────────────
 *
 * A shallow clone of a large repository runs to 1-3 GB and there are twenty of them. Clones the
 * sweep creates are DELETED after scoring; clones that already existed are left alone, because they
 * belong to someone else's run. Peak disk is therefore one clone, not twenty.
 *
 * ── RESUMABILITY, WHICH IS NOT OPTIONAL AT THIS LENGTH ────────────────────────────────────
 *
 * This is a multi-hour job making tens of thousands of model calls. A repository whose JSON already
 * exists is skipped, so an interrupted run resumes where it stopped rather than paying twice. A
 * repository that fails is recorded as a failure and the sweep continues: losing nineteen scored
 * repositories to a transport error on the twentieth would be a pure waste with no analytical
 * justification.
 *
 * ONE EXCEPTION TO THAT, AND IT IS NOT NEGOTIABLE. A tripped information-separation guard aborts the
 * whole sweep. A leak means the measurement is invalid wherever it happens, and carrying on would
 * produce twenty numbers indistinguishable from clean ones. (The one trip seen in practice — a
 * tailwindcss commit quoting a diff of generated CSS in its own message — turned out to be a property
 * of the data rather than a defect here, and `coverage.ts` now sets those commits aside before a prompt
 * is ever built, so it no longer reaches this handler. Anything that does is real.)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LlmBackend } from '@reckon/core';
import { buildRecordMap, type RecordMap } from './recordmap.js';
import { LeakageError } from './coverage.js';
import { parseRepoList, freeBytes, CLONE_SINCE, MIN_FREE_BYTES, DiskSpaceError, type RepoSpec } from './sweep.js';

const exec = promisify(execFile);

export interface RecordSweepOpts {
  reposFile: string;
  clonesDir: string;
  outDir: string;
  backend: LlmBackend;
  genBackend: LlmBackend;
  perRegion: number;
  maxRegions: number;
  concurrency: number;
  /** Re-score repositories that already have a JSON on disk. Off by default; the point is resuming. */
  force?: boolean;
  cloneTimeoutMs?: number;
  onProgress?: (m: string) => void;
}

export interface RecordSweepRow {
  repo: string;
  spec: string;
  status: 'scored' | 'refused' | 'failed' | 'skipped-empty';
  /** Present when scored. */
  overallRate?: number;
  explicit?: number;
  questions?: number;
  regionsScored?: number;
  regionsDropped?: number;
  colouredCells?: number;
  substantiveBodyShare?: number;
  commitsAnalysed?: number;
  seconds?: number;
  reason?: string;
}

const slugOf = (repo: string): string => repo.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--git-dir'], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

/**
 * One repository, end to end.
 *
 * THE CLONE PATH IS REPORTED THROUGH A CALLBACK, NOT THE RETURN VALUE, and that is a bug fix rather
 * than a style choice. It used to come back in the resolved object, so when scoring threw — as it did
 * on tailwindcss — this function never returned, the caller's `created` variable stayed null, and its
 * cleanup skipped a clone that was sitting on disk. Harmless at 31 MB; not harmless with pytorch,
 * kubernetes and vscode still to come and a 5 GB floor guarding the next clone. The callback fires the
 * moment the directory exists, so the caller can delete it on any exit path.
 */
async function scoreOne(
  spec: RepoSpec,
  opts: RecordSweepOpts,
  log: (m: string) => void,
  onCloneCreated: (dir: string) => void
): Promise<{ row: RecordSweepRow; map: RecordMap | null }> {
  const started = Date.now();
  const dir = join(opts.clonesDir, spec.dirName);

  if (!(await isGitRepo(dir))) {
    if (existsSync(dir)) {
      return {
        row: { repo: spec.ownerName ?? spec.spec, spec: spec.spec, status: 'failed', reason: `${dir} exists and is not a git repository` },
        map: null,
      };
    }
    const free = await freeBytes(opts.clonesDir);
    if (free < MIN_FREE_BYTES) {
      throw new DiskSpaceError(
        `only ${(free / 1024 ** 3).toFixed(1)}G free and a shallow clone runs to 1-3G. Stopping before ` +
          `${spec.spec}; repositories already scored are on disk and will be skipped on the next run.`
      );
    }
    // REGISTERED BEFORE THE ATTEMPT, not after it. A clone killed by the timeout can leave a partial
    // directory behind, and the failure path returns without ever reaching an "after" callback. The
    // caller deletes with `force`, so registering a path that never materialises costs nothing.
    onCloneCreated(dir);
    log(`cloning ${spec.url}`);
    try {
      await exec('git', ['clone', `--shallow-since=${CLONE_SINCE}`, spec.url, dir], {
        timeout: opts.cloneTimeoutMs ?? 15 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (e) {
      const why = e instanceof Error ? e.message.split('\n')[0] : String(e);
      return {
        row: { repo: spec.ownerName ?? spec.spec, spec: spec.spec, status: 'failed', reason: `clone failed: ${why}` },
        map: null,
      };
    }
    if (!(await isGitRepo(dir))) {
      // A repository with no commits in the shallow window clones "successfully" and empty. Scoring
      // it would report zero areas as though that were a finding.
      return {
        row: { repo: spec.ownerName ?? spec.spec, spec: spec.spec, status: 'skipped-empty', reason: 'clone produced no history in the window' },
        map: null,
      };
    }
  } else {
    log(`reusing existing clone at ${dir}`);
  }

  const map = await buildRecordMap({
    repo: dir,
    backend: opts.backend,
    genBackend: opts.genBackend,
    perRegion: opts.perRegion,
    maxRegions: opts.maxRegions,
    concurrency: opts.concurrency,
    onProgress: (m) => log(`  ${m}`),
  });

  const seconds = (Date.now() - started) / 1000;
  if (map.refused) {
    return {
      row: {
        repo: map.repo,
        spec: spec.spec,
        status: 'refused',
        substantiveBodyShare: map.squash.substantiveBodyShare,
        commitsAnalysed: map.commitsAnalysed,
        seconds,
        reason: `body density ${(map.squash.substantiveBodyShare * 100).toFixed(1)}% is below the floor`,
      },
      map,
    };
  }

  return {
    row: {
      repo: map.repo,
      spec: spec.spec,
      status: 'scored',
      ...(map.overall
        ? { overallRate: map.overall.rate, explicit: map.overall.explicit, questions: map.overall.total }
        : {}),
      regionsScored: map.cells.length,
      regionsDropped: map.regionsDropped ?? 0,
      colouredCells: map.cells.filter((c) => c.greyReason === null).length,
      substantiveBodyShare: map.squash.substantiveBodyShare,
      commitsAnalysed: map.commitsAnalysed,
      seconds,
    },
    map,
  };
}

export async function runRecordSweep(opts: RecordSweepOpts): Promise<RecordSweepRow[]> {
  const log = opts.onProgress ?? (() => {});
  const specs = parseRepoList(readFileSync(opts.reposFile, 'utf8'));
  const mapsDir = join(opts.outDir, 'repos');
  mkdirSync(mapsDir, { recursive: true });

  const rows: RecordSweepRow[] = [];
  for (const [i, spec] of specs.entries()) {
    const name = spec.ownerName ?? spec.spec;
    const jsonPath = join(mapsDir, `${slugOf(spec.dirName)}.json`);
    if (!opts.force && existsSync(jsonPath)) {
      log(`[${i + 1}/${specs.length}] ${name}: already scored, skipping`);
      try {
        const prev = JSON.parse(readFileSync(jsonPath, 'utf8')) as RecordMap;
        rows.push({
          repo: prev.repo,
          spec: spec.spec,
          status: prev.refused ? 'refused' : 'scored',
          ...(prev.overall
            ? { overallRate: prev.overall.rate, explicit: prev.overall.explicit, questions: prev.overall.total }
            : {}),
          regionsScored: prev.cells.length,
          regionsDropped: prev.regionsDropped ?? 0,
          colouredCells: prev.cells.filter((c) => c.greyReason === null).length,
          substantiveBodyShare: prev.squash.substantiveBodyShare,
          commitsAnalysed: prev.commitsAnalysed,
        });
      } catch {
        log(`  (existing ${jsonPath} is unreadable; delete it to re-score)`);
      }
      continue;
    }

    log(`[${i + 1}/${specs.length}] ${name}`);
    let created: string | null = null;
    try {
      // The callback is the ONLY source for this. Re-reading it from the resolved value as well would
      // restore the two-sources-of-truth that caused the leak: the resolved value does not exist on the
      // path where scoring throws, which is precisely the path that leaked a clone.
      const r = await scoreOne(spec, opts, log, (dir) => {
        created = dir;
      });
      rows.push(r.row);
      if (r.map) writeFileSync(jsonPath, `${JSON.stringify(r.map, null, 2)}\n`);
      log(
        `  ${r.row.status}` +
          (r.row.overallRate !== undefined
            ? ` — ${(r.row.overallRate * 100).toFixed(1)}% over ${r.row.questions} questions, ` +
              `${r.row.colouredCells}/${r.row.regionsScored} cells usable`
            : ` — ${r.row.reason ?? ''}`)
      );
    } catch (e) {
      if (e instanceof DiskSpaceError) throw e;
      // A LEAK IS NEVER ONE REPOSITORY'S PROBLEM. If the diff reached the scorer or the message reached
      // the generator, the measurement is invalid wherever it happens, and continuing would produce
      // nineteen more numbers indistinguishable from clean ones. This loop logged it as a per-repository
      // failure once, on tailwindcss, and carried on — which was wrong even though that particular trip
      // turned out to be a property of the data (see `recordContainsRawDiff`) rather than a defect here.
      // That case no longer reaches this handler at all; anything that does is a real leak.
      if (e instanceof LeakageError) throw e;
      const why = e instanceof Error ? e.message.split('\n')[0] : String(e);
      log(`  FAILED — ${why}`);
      rows.push({ repo: name, spec: spec.spec, status: 'failed', reason: why });
    } finally {
      // Only clones this sweep created. An existing clone belongs to another run.
      if (created) {
        log(`  removing ${created}`);
        rmSync(created, { recursive: true, force: true });
      }
      // The rows file is rewritten after every repository, not at the end, so an interrupted run
      // still leaves a readable summary of what it got through.
      writeFileSync(join(opts.outDir, 'sweep-rows.json'), `${JSON.stringify(rows, null, 2)}\n`);
    }
  }
  return rows;
}

/** Load every per-repository map a sweep has written, for pooling. */
export function loadSweepMaps(outDir: string): RecordMap[] {
  const dir = join(outDir, 'repos');
  if (!existsSync(dir)) return [];
  const out: RecordMap[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as RecordMap);
    } catch {
      // A half-written file from a killed run is skipped rather than crashing the pool.
    }
  }
  return out;
}

/**
 * BETWEEN-REPOSITORY versus WITHIN-REPOSITORY variance, with the sampling noise taken out.
 *
 * ── THE QUESTION THIS ANSWERS ─────────────────────────────────────────────────────────────
 *
 * Is a per-area map worth building at all? If almost all the variation in coverage were BETWEEN
 * repositories, then one number per repository would carry the same information and the per-area map
 * would be decoration. If most of it is WITHIN a repository, a project-level number averages away the
 * thing a maintainer would act on. That is a measurable question and this is the measurement.
 *
 * ── WHY THE RAW SPLIT WOULD BE WRONG ──────────────────────────────────────────────────────
 *
 * Each area's coverage is an estimate from a few dozen sampled questions, so the observed spread
 * within a repository is real spread PLUS binomial sampling noise. Reporting the raw within-group
 * variance would credit that noise as genuine variation and understate how much of the signal sits
 * between repositories. So the expected sampling variance — mean of p(1-p)/n over the cells — is
 * subtracted from the within component, which is the standard correction, and both the raw and
 * corrected figures are printed so the size of the correction is visible rather than buried.
 *
 * Only USABLE cells count: a cell whose interval was too wide to colour has no business contributing
 * to a variance decomposition. Refused repositories contribute nothing, having no estimates at all.
 */
export interface VarianceSplit {
  repos: number;
  cells: number;
  betweenVar: number;
  withinVarRaw: number;
  /** Within-repository variance after subtracting the expected binomial sampling variance. */
  withinVarCorrected: number;
  meanSamplingVar: number;
  /** Share of true variance sitting between repositories, in [0,1]. */
  iccCorrected: number;
  iccRaw: number;
  /** Mean coverage over the cells, for the depth calculation. */
  meanCoverage: number;
  /** Mean questions per scored commit, observed. Converts a question budget into a commit budget. */
  questionsPerCommit: number;
  /** Median questions currently asked per area. */
  questionsPerArea: number;
  /**
   * HOW DEEP SAMPLING WOULD HAVE TO GO for area-to-area differences inside one repository to be
   * resolvable — questions per area, and the commits that implies.
   *
   * The criterion is that an area's sampling standard error should be at most HALF the true
   * within-repository standard deviation. Below that ratio the noise dominates the signal and a
   * heatmap is drawing sampling error; at that ratio the ordering of areas starts to mean something.
   * It is a convention, stated so it can be argued with, not a significance test.
   *
   * Null when the corrected within-repository variance is zero — there is then no signal to resolve
   * and no depth would help.
   */
  questionsNeededPerArea: number | null;
  commitsNeededPerArea: number | null;
}

export function varianceSplit(maps: RecordMap[]): VarianceSplit | null {
  const groups: { values: number[]; samplingVars: number[] }[] = [];
  for (const m of maps) {
    if (m.refused) continue;
    const values: number[] = [];
    const samplingVars: number[] = [];
    for (const c of m.cells) {
      if (c.greyReason !== null || c.coverage === null || c.questions <= 1) continue;
      values.push(c.coverage);
      samplingVars.push((c.coverage * (1 - c.coverage)) / c.questions);
    }
    if (values.length >= 2) groups.push({ values, samplingVars });
  }
  if (groups.length < 2) return null;

  const all = groups.flatMap((g) => g.values);
  const grand = all.reduce((a, b) => a + b, 0) / all.length;
  const groupMeans = groups.map((g) => g.values.reduce((a, b) => a + b, 0) / g.values.length);

  // Between: variance of the group means, weighted by group size, as a share of the total.
  let between = 0;
  for (const [i, g] of groups.entries()) between += g.values.length * (groupMeans[i]! - grand) ** 2;
  between /= all.length;

  let within = 0;
  for (const [i, g] of groups.entries()) {
    for (const v of g.values) within += (v - groupMeans[i]!) ** 2;
  }
  within /= all.length;

  const meanSamplingVar =
    groups.flatMap((g) => g.samplingVars).reduce((a, b) => a + b, 0) / all.length;
  const withinCorrected = Math.max(0, within - meanSamplingVar);

  // Observed questions per commit and per area, so a question budget can be quoted as a commit budget.
  let qTotal = 0;
  let cTotal = 0;
  const perArea: number[] = [];
  for (const m of maps) {
    if (m.refused) continue;
    for (const c of m.cells) {
      if (c.greyReason !== null || c.coverage === null) continue;
      qTotal += c.questions;
      cTotal += c.scoredCommits;
      perArea.push(c.questions);
    }
  }
  perArea.sort((a, b) => a - b);
  const questionsPerCommit = cTotal > 0 ? qTotal / cTotal : 0;
  const questionsPerArea = perArea.length > 0 ? perArea[Math.floor(perArea.length / 2)]! : 0;

  // Depth needed for the sampling SE of an area to fall to half the true within-repository SD.
  const withinSd = Math.sqrt(withinCorrected);
  const targetSe = withinSd / 2;
  const questionsNeeded =
    targetSe > 0 ? Math.ceil((grand * (1 - grand)) / (targetSe * targetSe)) : null;

  return {
    repos: groups.length,
    cells: all.length,
    betweenVar: between,
    withinVarRaw: within,
    withinVarCorrected: withinCorrected,
    meanSamplingVar,
    iccCorrected: between + withinCorrected > 0 ? between / (between + withinCorrected) : 0,
    iccRaw: between + within > 0 ? between / (between + within) : 0,
    meanCoverage: grand,
    questionsPerCommit,
    questionsPerArea,
    questionsNeededPerArea: questionsNeeded,
    commitsNeededPerArea:
      questionsNeeded !== null && questionsPerCommit > 0
        ? Math.ceil(questionsNeeded / questionsPerCommit)
        : null,
  };
}

export function formatRecordSweepReport(rows: RecordSweepRow[], maps: RecordMap[] = []): string {
  const L: string[] = [];
  const scored = rows.filter((r) => r.status === 'scored');
  const refused = rows.filter((r) => r.status === 'refused');
  const failed = rows.filter((r) => r.status === 'failed' || r.status === 'skipped-empty');

  L.push('# Record coverage across repositories');
  L.push('');
  L.push(
    `${scored.length} scored, ${refused.length} refused by the body-density gate, ${failed.length} not measured.`
  );
  L.push('');

  if (scored.length > 0) {
    const pooledExplicit = scored.reduce((a, r) => a + (r.explicit ?? 0), 0);
    const pooledQuestions = scored.reduce((a, r) => a + (r.questions ?? 0), 0);
    L.push(
      `Pooled: **${((100 * pooledExplicit) / Math.max(1, pooledQuestions)).toFixed(1)}% of ` +
        `${pooledQuestions.toLocaleString('en-US')} mechanism questions** are answered explicitly by the ` +
        'commits that made the change.'
    );
    L.push('');
    L.push('| repository | coverage | questions | areas scored | usable cells | areas not scored | body density |');
    L.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const r of [...scored].sort((a, b) => (b.overallRate ?? 0) - (a.overallRate ?? 0))) {
      L.push(
        `| \`${r.repo}\` | **${((r.overallRate ?? 0) * 100).toFixed(1)}%** | ${r.questions ?? 0} | ` +
          `${r.regionsScored ?? 0} | ${r.colouredCells ?? 0} | ${r.regionsDropped ?? 0} | ` +
          `${((r.substantiveBodyShare ?? 0) * 100).toFixed(0)}% |`
      );
    }
    L.push('');
    const rates = scored.map((r) => r.overallRate ?? 0).sort((a, b) => a - b);
    L.push(
      `Between-repository spread: ${(rates[0]! * 100).toFixed(1)}% to ${(rates[rates.length - 1]! * 100).toFixed(1)}%. ` +
        'That range is the reason a single-repository number could not be generalised, and the reason ' +
        'this sweep exists.'
    );
    L.push('');
  }

  const split = varianceSplit(maps);
  if (split) {
    L.push('## Is a per-area map worth building, or would one number per repository do?');
    L.push('');
    L.push(
      `Over ${split.cells} usable area estimates in ${split.repos} repositories, ` +
        `**${(split.iccCorrected * 100).toFixed(0)}% of the true variance sits BETWEEN repositories** and ` +
        `${(100 - split.iccCorrected * 100).toFixed(0)}% WITHIN them.`
    );
    L.push('');
    L.push('| component | variance | as SD |');
    L.push('| --- | --- | --- |');
    L.push(`| between repositories | ${split.betweenVar.toFixed(5)} | ${Math.sqrt(split.betweenVar).toFixed(3)} |`);
    L.push(
      `| within repositories, raw | ${split.withinVarRaw.toFixed(5)} | ${Math.sqrt(split.withinVarRaw).toFixed(3)} |`
    );
    L.push(
      `| — of which sampling noise | ${split.meanSamplingVar.toFixed(5)} | ${Math.sqrt(split.meanSamplingVar).toFixed(3)} |`
    );
    L.push(
      `| within repositories, corrected | ${split.withinVarCorrected.toFixed(5)} | ${Math.sqrt(split.withinVarCorrected).toFixed(3)} |`
    );
    L.push('');
    L.push(
      'Each area estimate carries binomial sampling error, so the raw within-repository spread is real ' +
        'spread plus noise. The expected sampling variance is subtracted, which is the standard ' +
        'correction; the uncorrected share would read ' +
        `${(split.iccRaw * 100).toFixed(0)}% between rather than ${(split.iccCorrected * 100).toFixed(0)}%, ` +
        'and both are printed so the size of the correction is visible.'
    );
    L.push('');
    L.push(
      'Read it as the answer to a design question rather than a finding about software: the larger the ' +
        'within-repository share, the more a project-level number averages away what a maintainer would ' +
        'act on, and the more a per-area map earns its keep. Only usable cells count — an estimate too ' +
        'thin to colour has no business in a variance decomposition.'
    );
    L.push('');
    if (split.questionsNeededPerArea !== null && split.commitsNeededPerArea !== null) {
      L.push('### What depth would make area-to-area differences readable');
      L.push('');
      L.push(
        `True within-repository spread is ${(Math.sqrt(split.withinVarCorrected) * 100).toFixed(1)} points ` +
          `of standard deviation. For an area's own sampling error to fall to half of that — the point at ` +
          `which the ordering of areas starts to carry signal rather than noise — an area needs about ` +
          `**${split.questionsNeededPerArea} questions**, which at the observed ` +
          `${split.questionsPerCommit.toFixed(1)} questions per commit is about ` +
          `**${split.commitsNeededPerArea} commits per area**.`
      );
      L.push('');
      L.push(
        `This sweep sampled a median of ${split.questionsPerArea} questions per area, so the depth ratio is ` +
          `roughly ${(split.questionsNeededPerArea / Math.max(1, split.questionsPerArea)).toFixed(1)}x. ` +
          'The half-an-SD criterion is a stated convention rather than a test, and it is the number to ' +
          'argue with if you disagree with the conclusion.'
      );
      L.push('');
      L.push(
        'The consequence is a budget statement, not a defect: at the current depth the REPOSITORY is the ' +
          'unit this measurement resolves, and a per-area page is drawing a mixture of signal and sampling ' +
          'error. Spending the same budget on fewer, larger units is the change that would make an ' +
          'area-level ordering trustworthy — not a better decomposition of the same spend.'
      );
      L.push('');
    }
  }

  if (refused.length > 0) {
    L.push('## Refused, and that is the correct output');
    L.push('');
    L.push(
      'These repositories squash to a title often enough that a coverage number would be measuring ' +
        'the merge button rather than any author. The tool draws nothing.'
    );
    L.push('');
    L.push('| repository | body density |');
    L.push('| --- | --- |');
    for (const r of refused) L.push(`| \`${r.repo}\` | ${((r.substantiveBodyShare ?? 0) * 100).toFixed(1)}% |`);
    L.push('');
  }

  if (failed.length > 0) {
    L.push('## Not measured');
    L.push('');
    for (const r of failed) L.push(`- \`${r.repo}\` — ${r.reason ?? r.status}`);
    L.push('');
  }

  L.push('## What this is');
  L.push('');
  L.push(
    'Questions are generated from the diff alone by the production generator; a second model scores ' +
      'the commit record against them and never sees the code. A tripped separation guard aborts the ' +
      'run. "Explicit" means the record answers the question outright, not that a reader could infer it.'
  );
  L.push('');
  L.push(
    'Each repository contributes its largest areas at full sampling depth rather than every area ' +
      'thinly: at 5 sampled commits per area, 82% of cells fail the interval rule and are greyed, so a ' +
      'thin-everywhere sweep would have produced a page of grey. The count of unscored areas is in the ' +
      'table above and in each per-repository JSON.'
  );
  return `${L.join('\n')}\n`;
}
