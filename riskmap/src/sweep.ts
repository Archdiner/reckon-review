/**
 * `riskmap sweep` — run the map across many repositories, then pick targets from what surfaced.
 *
 * WHY THIS EXISTS. The outreach workflow was backwards: pick a prospect, clone, run the map,
 * and find out afterwards whether anything flagged. On the four repositories tested that way,
 * two came back with zero flagged regions. Zero is the correct answer for those repos — but
 * discovering it halfway through a sending session makes prospecting a coin flip. Inverting the
 * order costs the same clone volume and turns the hit rate into a number you know before you
 * write the first email.
 *
 * THE HIT RATE IS THE OUTPUT. Everything else in the summary supports it: the ranked prospect
 * table says which repos to open first, the distribution says whether flagging is rare-and-
 * concentrated or common-and-thin, and the error list says how big the denominator honestly is.
 * A repo that failed is reported as failed; it is never quietly folded into "no flags", because
 * that would understate the hit rate with an invented zero.
 *
 * NO INDIVIDUAL IS NAMED HERE EITHER, and as everywhere else in this tool that is structural
 * rather than a convention: this module only ever sees `Region` values, which by construction
 * (see identity.ts and types.ts) carry counts and opaque keys and never a name or an address.
 * There is no filtering step below that could be forgotten.
 *
 * FAULT TOLERANCE IS THE OTHER HALF. A sweep is a long unattended run over other people's
 * repositories: one will 404, one will have no history in the shallow window, one will take
 * longer than any sane timeout. Each repository is therefore built in a CHILD PROCESS with a
 * hard timeout — not merely a try/catch — because the failure that actually stops a sweep is a
 * `git log --numstat` that never returns, and an in-process `Promise.race` cannot kill it. The
 * child also gives each repo a fresh heap, which matters when the maps are hundreds of MB.
 *
 * Per-repo results are persisted as they complete, so a sweep that dies at repo 40 of 60
 * resumes at 41 rather than re-cloning everything.
 */

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { buildMap } from './build.js';
import type { Region, SquashVerdict } from './types.js';

const exec = promisify(execFile);

/** Free space below which no clone is attempted. A shallow clone of a large repo is ~1-3GB. */
export const MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024;

/** The clone window. Deliberately shorter than the 60-month measurement window: see below. */
export const CLONE_SINCE = '3 years ago';

const DEFAULT_CLONE_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_BUILD_TIMEOUT_MS = 20 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// The repo list
// ---------------------------------------------------------------------------------------------

export interface RepoSpec {
  /** The line as written, kept verbatim so the report can point back at the input file. */
  spec: string;
  /** Clone URL. */
  url: string;
  /** `owner/name` when the spec carried an owner, else null. Used to catch clone-dir collisions. */
  ownerName: string | null;
  /** Directory under --clones. Basename of the repo, matching the README's clone command. */
  dirName: string;
  /** Filesystem-safe key for the persisted per-repo result. */
  slug: string;
}

/** `owner/name` from any of the URL shapes git accepts, lowercased. Null when there is no owner. */
export function ownerNameFromUrl(url: string): string | null {
  const cleaned = url.replace(/\.git$/, '').replace(/\/+$/, '');
  // scp-style (`git@host:owner/name`) and path-style both end in `.../owner/name`.
  const m = cleaned.match(/[:/]([^/:]+)\/([^/]+)$/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`.toLowerCase();
}

export function parseRepoList(text: string): RepoSpec[] {
  const out: RepoSpec[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split('\n')) {
    // A `#` anywhere starts a comment. URLs do not contain `#`, and a fragment would not be
    // meaningful in a clone URL anyway.
    const line = rawLine.split('#')[0]!.trim();
    if (!line) continue;

    const shorthand = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(line);
    const url = shorthand ? `https://github.com/${line}` : line;
    const ownerName = shorthand ? line.toLowerCase() : ownerNameFromUrl(url);
    const dirName = (url.replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).pop() ?? '')
      .trim();
    if (!dirName) continue;
    const slug = (ownerName ?? dirName).replace(/[^A-Za-z0-9._-]+/g, '-').toLowerCase();
    if (seen.has(slug)) continue; // a list assembled from two sources will repeat entries
    seen.add(slug);
    out.push({ spec: line, url, ownerName, dirName, slug });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Per-repo result
// ---------------------------------------------------------------------------------------------

/** One flagged region, reduced to what the prospect table needs. Counts only — never a person. */
export interface SweepRegion {
  path: string;
  commits: number;
  contributors: number;
  inactiveContributors: number;
  orphanedShare: number;
  concentration: number;
  commitsPerMonth: number;
  linesPerMonth: number;
  agentDensity: number;
  extant: boolean;
  flags: string[];
}

export interface SweepOk {
  status: 'ok';
  spec: string;
  /** `owner/name` as the clone's own remote reports it. */
  repo: string;
  clonePath: string;
  cloned: boolean;
  regions: number;
  flaggedCount: number;
  /**
   * The highest-ranked flagged region, taken from `map.top` so the sweep and the page it links
   * to agree about which region is the strongest. Null when nothing flagged.
   */
  strongest: SweepRegion | null;
  flaggedRegions: SweepRegion[];
  squash: SquashVerdict;
  headSha: string;
  asOf: number;
  windowMonths: number;
  spanMonths: number;
  commitsSeen: number;
  commitsKept: number;
  churnThreshold: number;
  durationMs: number;
  completedAtUtc: string;
}

export interface SweepError {
  status: 'error';
  spec: string;
  repo: string;
  /** Which step failed. Clone failures and build failures mean different things to a reader. */
  phase: 'clone' | 'build';
  /** The exact error. Never summarised, never normalised into a category. */
  error: string;
  durationMs: number;
  completedAtUtc: string;
}

export type SweepResult = SweepOk | SweepError;

function reduceRegion(r: Region): SweepRegion {
  return {
    path: r.path,
    commits: r.commits,
    contributors: r.contributors,
    inactiveContributors: r.inactiveContributors,
    orphanedShare: r.orphanedShare,
    concentration: r.concentration,
    commitsPerMonth: r.commitsPerMonth,
    linesPerMonth: r.linesPerMonth,
    agentDensity: r.agentDensity,
    extant: r.extant,
    flags: [...r.flags],
  };
}

// ---------------------------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------------------------

export async function freeBytes(path: string): Promise<number> {
  // -P is POSIX output: one line per filesystem, so the "available" column is always field 4
  // even when the device name is long enough that plain `df` wraps it onto two lines.
  const { stdout } = await exec('df', ['-Pk', path]);
  const line = stdout.trim().split('\n')[1] ?? '';
  const avail = Number(line.split(/\s+/)[3]);
  if (!Number.isFinite(avail)) throw new Error(`could not read free space from: ${stdout.trim()}`);
  return avail * 1024;
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}G`;
}

/**
 * Refuse to start cloning when the disk cannot hold a clone.
 *
 * This aborts the whole sweep rather than the one repository, because free space is a global
 * condition: if there is no room for this clone there is no room for the next forty either, and
 * forty identical "no space left on device" errors in the report describe the machine rather
 * than the prospects. Everything already completed is on disk, so a resumed run picks up where
 * this one stopped once space is freed.
 */
export class DiskSpaceError extends Error {}

// ---------------------------------------------------------------------------------------------
// Cloning
// ---------------------------------------------------------------------------------------------

async function isGitRepo(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  try {
    const { stdout } = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function originOf(dir: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], { cwd: dir });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function runWithTimeout(
  cmd: string,
  args: string[],
  timeoutMs: number,
  onLine: (line: string) => void
): Promise<{ code: number | null; timedOut: boolean; stderr: string }> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL, not SIGTERM. The process being killed here is git fetching over a network it
      // may be blocked on; a polite signal is exactly the one it can ignore.
      child.kill('SIGKILL');
    }, timeoutMs);

    let buf = '';
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      // Keep the tail only. `git clone` progress is megabytes of carriage returns.
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
      buf += s;
      const lines = buf.split(/[\r\n]/);
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) onLine(l.trim());
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      res({ code: null, timedOut, stderr: `${stderr}\n${e.message}`.trim() });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ code, timedOut, stderr });
    });
  });
}

/** Last non-empty line of a stderr blob — usually git's actual `fatal:`. */
function lastLine(s: string): string {
  const lines = s.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

/**
 * NOT `--filter=blob:none`. A blobless clone has no file contents, and `git log --numstat`
 * needs them, so git refetches every blob one at a time over the network — a grafana run did
 * not finish in ten minutes and would never finish across a sweep. `--shallow-since` fetches
 * blobs, but only for the window, which is what makes the whole thing a per-repo two-minute job.
 *
 * The clone window (3 years) is shorter than the default measurement window (60 months). That
 * is a deliberate trade for sweep scale: a sweep is triage, and the repos it surfaces get
 * re-cloned deeper before anything is sent. It does mean sweep orphaned shares are measured over
 * less history than a full `map` run of the same repo would use, and the summary says so.
 */
async function ensureClone(
  spec: RepoSpec,
  clonesDir: string,
  timeoutMs: number,
  log: (m: string) => void
): Promise<{ path: string; cloned: boolean }> {
  const dir = join(clonesDir, spec.dirName);

  if (await isGitRepo(dir)) {
    const origin = await originOf(dir);
    const have = origin ? ownerNameFromUrl(origin) : null;
    // Two entries whose URLs end in the same basename would otherwise share one directory and
    // the second would be measured against the first's history — a wrong number reported
    // confidently, which is the one failure mode this tool cannot afford.
    if (spec.ownerName && have && have !== spec.ownerName) {
      throw new Error(
        `${dir} already holds ${have}, not ${spec.ownerName}. Two entries in the repo list share ` +
          `the directory name "${spec.dirName}". Clone one of them elsewhere or rename it.`
      );
    }
    log(`reusing existing clone at ${dir}`);
    return { path: dir, cloned: false };
  }
  if (existsSync(dir)) {
    throw new Error(`${dir} exists but is not a git repository; remove it or point --clones elsewhere`);
  }

  const free = await freeBytes(clonesDir);
  if (free < MIN_FREE_BYTES) {
    throw new DiskSpaceError(
      `only ${gb(free)} free on the filesystem holding ${clonesDir}, and a shallow clone of a ` +
        `large repository runs to 1-3G. Sweep aborted before cloning ${spec.spec}. Free space to ` +
        `at least ${gb(MIN_FREE_BYTES)} and re-run: completed repositories are already persisted ` +
        'and will be skipped.'
    );
  }

  log(`cloning ${spec.url} (${gb(free)} free, --shallow-since="${CLONE_SINCE}")`);
  const r = await runWithTimeout(
    'git',
    ['clone', `--shallow-since=${CLONE_SINCE}`, spec.url, dir],
    timeoutMs,
    () => {}
  );
  if (r.timedOut) throw new Error(`clone timed out after ${Math.round(timeoutMs / 1000)}s`);
  if (r.code !== 0) {
    throw new Error(`git clone exited ${r.code}: ${lastLine(r.stderr) || '(no stderr)'}`);
  }
  // A repository with no commits in the shallow window clones "successfully" with an empty
  // history. Building a map from it would report zero regions as though that were a finding.
  if (!(await isGitRepo(dir))) throw new Error('git clone reported success but produced no repository');
  return { path: dir, cloned: true };
}

// ---------------------------------------------------------------------------------------------
// The child-process build
// ---------------------------------------------------------------------------------------------

const WORKER_MARKER = 'SWEEP-WORKER-ERROR:';

/**
 * The child half. Runs one map and writes the reduced result, then exits so its heap goes with
 * it. Invoked by `cli.ts` as the hidden `sweep-build` command; not part of the user surface.
 */
export async function sweepWorker(repoPath: string, outPath: string, spec: string): Promise<void> {
  const started = Date.now();
  try {
    const { map } = await buildMap({
      repo: repoPath,
      // coverage: null is not a default worth overriding here. The sweep is triage across many
      // repositories, and a model call per region per repo would cost more than the whole
      // exercise is worth before a single prospect has been chosen.
      coverage: null,
      onProgress: (m) => process.stderr.write(`${m}\n`),
    });
    const flagged = map.regions.filter((r) => r.flagged);
    const strongest = map.top.find((r) => r.flagged) ?? flagged[0] ?? null;
    const result: SweepOk = {
      status: 'ok',
      spec,
      repo: map.report.repo,
      clonePath: repoPath,
      cloned: false, // the parent knows; it overwrites this before persisting
      regions: map.regions.length,
      flaggedCount: flagged.length,
      strongest: strongest ? reduceRegion(strongest) : null,
      flaggedRegions: flagged.map(reduceRegion),
      squash: map.squash,
      headSha: map.report.headSha,
      asOf: map.report.asOf,
      windowMonths: map.report.windowMonths,
      spanMonths: map.report.spanMonths,
      commitsSeen: map.report.commitsSeen,
      commitsKept: map.report.commitsKept,
      churnThreshold: map.thresholds.commitsPerMonth,
      durationMs: Date.now() - started,
      completedAtUtc: new Date().toISOString(),
    };
    writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  } catch (e) {
    // The marker makes the exact message recoverable from a stderr stream that also carries
    // every progress line the builder printed.
    process.stderr.write(`${WORKER_MARKER} ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

/** The parent half. Spawns the worker under whatever loader this process is running under. */
async function buildInChild(
  repoPath: string,
  outPath: string,
  spec: string,
  timeoutMs: number,
  log: (m: string) => void
): Promise<void> {
  // process.argv[1] is this CLI's entry script and process.execArgv carries the tsx loader
  // flags, so the child runs the same way the parent does whether that is tsx or plain node.
  const entry = process.argv[1];
  if (!entry) throw new Error('cannot locate the riskmap entry script to spawn a build worker');
  const r = await runWithTimeout(
    process.execPath,
    [...process.execArgv, entry, 'sweep-build', repoPath, outPath, spec],
    timeoutMs,
    (line) => log(line)
  );
  if (r.timedOut) throw new Error(`build timed out after ${Math.round(timeoutMs / 1000)}s`);
  if (r.code !== 0) {
    const marked = r.stderr
      .split(/[\r\n]+/)
      .filter((l) => l.includes(WORKER_MARKER))
      .pop();
    const msg = marked ? marked.slice(marked.indexOf(WORKER_MARKER) + WORKER_MARKER.length).trim() : '';
    throw new Error(msg || `build worker exited ${r.code}: ${lastLine(r.stderr) || '(no stderr)'}`);
  }
  if (!existsSync(outPath)) throw new Error('build worker exited 0 but wrote no result');
}

// ---------------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------------

export interface SweepOpts {
  reposFile: string;
  clonesDir: string;
  outDir: string;
  /** Re-run repositories that already have a persisted `ok` result. */
  force?: boolean;
  cloneTimeoutMs?: number;
  buildTimeoutMs?: number;
  onProgress?: (msg: string) => void;
}

export interface SweepSummary {
  generatedAtUtc: string;
  reposFile: string;
  clonesDir: string;
  outDir: string;
  cloneWindow: string;
  totals: { listed: number; completed: number; errored: number; withFlagged: number };
  hitRate: {
    numerator: number;
    denominator: number;
    fraction: string;
    percent: number | null;
    note: string;
  };
  distribution: { bucket: string; repos: number }[];
  recordUnavailable: { repo: string; substantiveBodyShare: number; sampled: number }[];
  recordLowConfidence: { repo: string; substantiveBodyShare: number; sampled: number }[];
  prospects: SweepOk[];
  errors: SweepError[];
}

/**
 * The ranking of the prospect table.
 *
 * Flagged count first because that is what "worth an email" means here, then the strongest
 * region's orphaned share, because a single region at 0.85 orphaned is a better conversation
 * than three regions that each barely cleared concentration. Note what is NOT done: nothing is
 * summed into a score. Same rule as the map itself — a composite invites an argument about
 * weights and hides the reason a repo surfaced.
 */
function rankProspects(a: SweepOk, b: SweepOk): number {
  return (
    b.flaggedCount - a.flaggedCount ||
    (b.strongest?.orphanedShare ?? -1) - (a.strongest?.orphanedShare ?? -1) ||
    (b.strongest?.concentration ?? -1) - (a.strongest?.concentration ?? -1) ||
    a.repo.localeCompare(b.repo)
  );
}

export function summarise(
  results: SweepResult[],
  meta: { reposFile: string; clonesDir: string; outDir: string; listed: number }
): SweepSummary {
  const ok = results.filter((r): r is SweepOk => r.status === 'ok');
  const errors = results.filter((r): r is SweepError => r.status === 'error');
  const withFlagged = ok.filter((r) => r.flaggedCount > 0);

  // THE DENOMINATOR IS COMPLETED REPOSITORIES, NOT LISTED ONES. A repo that failed to clone
  // did not produce "no flags"; it produced nothing. Folding failures into the denominator
  // would depress the hit rate with results that were never measured, and folding them into the
  // numerator would inflate it. They are excluded and counted separately, in the same sentence.
  const denominator = ok.length;
  const numerator = withFlagged.length;

  const buckets = [
    { bucket: '0', test: (n: number) => n === 0 },
    { bucket: '1', test: (n: number) => n === 1 },
    { bucket: '2-3', test: (n: number) => n >= 2 && n <= 3 },
    { bucket: '4+', test: (n: number) => n >= 4 },
  ];

  return {
    generatedAtUtc: new Date().toISOString(),
    reposFile: meta.reposFile,
    clonesDir: meta.clonesDir,
    outDir: meta.outDir,
    cloneWindow: CLONE_SINCE,
    totals: {
      listed: meta.listed,
      completed: ok.length,
      errored: errors.length,
      withFlagged: numerator,
    },
    hitRate: {
      numerator,
      denominator,
      fraction: `${numerator}/${denominator}`,
      percent: denominator > 0 ? (numerator / denominator) * 100 : null,
      note:
        denominator > 0
          ? `${numerator} of the ${denominator} repositories that completed produced at least one ` +
            `flagged region. ${errors.length} repositor${errors.length === 1 ? 'y' : 'ies'} errored ` +
            'and are excluded from the denominator rather than counted as zero.'
          : 'No repository completed, so no hit rate can be computed. The errors below are the whole result.',
    },
    distribution: buckets.map((b) => ({
      bucket: b.bucket,
      repos: ok.filter((r) => b.test(r.flaggedCount)).length,
    })),
    recordUnavailable: ok
      .filter((r) => r.squash.availability === 'unavailable')
      .map((r) => ({
        repo: r.repo,
        substantiveBodyShare: r.squash.substantiveBodyShare,
        sampled: r.squash.sampled,
      })),
    recordLowConfidence: ok
      .filter((r) => r.squash.availability === 'low-confidence')
      .map((r) => ({
        repo: r.repo,
        substantiveBodyShare: r.squash.substantiveBodyShare,
        sampled: r.squash.sampled,
      })),
    prospects: [...ok].sort(rankProspects),
    errors,
  };
}

export async function runSweep(opts: SweepOpts): Promise<SweepSummary> {
  const log = opts.onProgress ?? (() => {});
  const reposFile = resolve(opts.reposFile);
  const clonesDir = resolve(opts.clonesDir);
  const outDir = resolve(opts.outDir);
  const resultsDir = join(outDir, 'repos');

  if (!existsSync(reposFile)) throw new Error(`no repo list at ${reposFile}`);
  mkdirSync(clonesDir, { recursive: true });
  mkdirSync(resultsDir, { recursive: true });

  const specs = parseRepoList(readFileSync(reposFile, 'utf8'));
  if (specs.length === 0) throw new Error(`${reposFile} lists no repositories`);

  const cloneTimeout = opts.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
  const buildTimeout = opts.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;

  log(`${specs.length} repositories listed in ${reposFile}`);
  const free = await freeBytes(clonesDir);
  log(`${gb(free)} free on the filesystem holding ${clonesDir}`);

  const results: SweepResult[] = [];
  let aborted: DiskSpaceError | null = null;

  for (const [i, spec] of specs.entries()) {
    const at = `[${i + 1}/${specs.length}] ${spec.spec}`;
    const resultPath = join(resultsDir, `${spec.slug}.json`);

    // RESUME. Only `ok` results are skipped. An error is retried, because most sweep errors are
    // transient — a network blip, a timeout on a machine that was busy — and a permanent one
    // costs only the seconds it takes to fail again.
    if (!opts.force && existsSync(resultPath)) {
      try {
        const prior = JSON.parse(readFileSync(resultPath, 'utf8')) as SweepResult;
        if (prior.status === 'ok') {
          log(`${at} — already done (${prior.flaggedCount} flagged of ${prior.regions}), skipping`);
          results.push(prior);
          continue;
        }
      } catch {
        // A truncated result from a run that was killed mid-write. Redo it.
      }
    }

    const started = Date.now();
    let phase: 'clone' | 'build' = 'clone';
    try {
      log(`${at} — starting`);
      const { path: clonePath, cloned } = await ensureClone(spec, clonesDir, cloneTimeout, (m) =>
        log(`    ${m}`)
      );
      phase = 'build';
      await buildInChild(clonePath, resultPath, spec.spec, buildTimeout, (m) => log(`    ${m}`));

      const done = JSON.parse(readFileSync(resultPath, 'utf8')) as SweepOk;
      done.cloned = cloned;
      done.durationMs = Date.now() - started;
      writeFileSync(resultPath, `${JSON.stringify(done, null, 2)}\n`);
      results.push(done);
      log(
        `${at} — ${done.flaggedCount} flagged of ${done.regions} regions, record ` +
          `${done.squash.availability} (${((Date.now() - started) / 1000).toFixed(0)}s)`
      );
    } catch (e) {
      if (e instanceof DiskSpaceError) {
        // The one error that stops the sweep instead of being recorded against a repository.
        aborted = e;
        break;
      }
      const err: SweepError = {
        status: 'error',
        spec: spec.spec,
        repo: spec.ownerName ?? spec.dirName,
        phase,
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - started,
        completedAtUtc: new Date().toISOString(),
      };
      writeFileSync(resultPath, `${JSON.stringify(err, null, 2)}\n`);
      results.push(err);
      log(`${at} — FAILED in ${phase}: ${err.error}`);
    }
  }

  const summary = summarise(results, {
    reposFile,
    clonesDir,
    outDir,
    listed: specs.length,
  });
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(outDir, 'summary.md'), formatSweepReport(summary));

  // The summary is written BEFORE the abort is re-thrown, so a disk-space abort still leaves a
  // readable report of everything that did complete.
  if (aborted) throw aborted;
  return summary;
}

/** Load every persisted result under an out directory, newest wins. For re-rendering only. */
export function loadResults(outDir: string): SweepResult[] {
  const dir = join(outDir, 'repos');
  if (!existsSync(dir)) return [];
  const out: SweepResult[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as SweepResult);
    } catch {
      // A partial write from a killed run. Skipping it is right: the alternative is inventing
      // a result for a repository that never finished.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

function regionCell(r: SweepRegion | null): string {
  if (!r) return '—';
  return `\`${r.path}\``;
}

function dimsCell(r: SweepRegion | null): string {
  if (!r) return '—';
  return (
    `orphaned ${pct(r.orphanedShare)}, conc ${pct(r.concentration)}, ` +
    `${r.commitsPerMonth.toFixed(1)}/mo, ${r.contributors} contributor${r.contributors === 1 ? '' : 's'} ` +
    `(${r.inactiveContributors} inactive) [${r.flags.join(', ')}]`
  );
}

function squashCell(s: SquashVerdict): string {
  return `${s.availability} (${(s.substantiveBodyShare * 100).toFixed(0)}% bodies)`;
}

export function formatSweepReport(s: SweepSummary): string {
  const L: string[] = [];
  const hr = s.hitRate;

  L.push('# Sweep — which repositories are worth an email');
  L.push('');
  L.push(
    `${s.totals.listed} repositories listed, ${s.totals.completed} completed, ${s.totals.errored} errored. ` +
      `Generated ${s.generatedAtUtc}.`
  );
  L.push('');

  // ---- 2. the hit rate. First, because it is the number the command exists to produce. ----
  L.push('## Hit rate');
  L.push('');
  if (hr.percent === null) {
    L.push(`**No hit rate.** ${hr.note}`);
  } else {
    L.push(
      `**${hr.fraction} = ${hr.percent.toFixed(1)}%** of completed repositories produced at least ` +
        'one flagged region.'
    );
    L.push('');
    L.push(hr.note);
  }
  L.push('');
  L.push(
    'A flagged region is one that cleared at least two of the available tests, one of them an ' +
      'ownership test. Zero flagged regions is a real answer about a repository, not a failure ' +
      'of the run — which is the whole reason to know the rate before a sending session rather ' +
      'than during one.'
  );
  L.push('');

  // ---- 1. the prospect table ----
  L.push('## Prospects, ranked');
  L.push('');
  if (s.prospects.length === 0) {
    L.push('No repository completed, so there is nothing to rank.');
  } else {
    L.push('| # | repo | regions | flagged | strongest flagged region | its dimensions | record |');
    L.push('| ---: | --- | ---: | ---: | --- | --- | --- |');
    s.prospects.forEach((p, i) => {
      L.push(
        `| ${i + 1} | ${p.repo} | ${p.regions} | ${p.flaggedCount} | ${regionCell(p.strongest)} | ` +
          `${dimsCell(p.strongest)} | ${squashCell(p.squash)} |`
      );
    });
    L.push('');
    L.push(
      'Ranked by flagged count, then by the strongest region\'s orphaned share. Nothing is summed ' +
        'into a score: the columns are the reason a repository is where it is.'
    );
  }
  L.push('');

  // ---- the record-dimension caveat, called out rather than left in a column ----
  if (s.recordUnavailable.length > 0 || s.recordLowConfidence.length > 0) {
    L.push('### Where the record dimension could not be used');
    L.push('');
    L.push(
      'These repositories squash on merge, so the description the author wrote never entered git. ' +
        'Their flags come from ownership and churn alone, and a documentation claim must not be ' +
        'made about them — the instrument is measuring the merge button there, not any author.'
    );
    L.push('');
    for (const r of s.recordUnavailable) {
      L.push(
        `- **${r.repo}** — unavailable, ${(r.substantiveBodyShare * 100).toFixed(1)}% of ${r.sampled} ` +
          'sampled commits carry a body beyond the subject.'
      );
    }
    for (const r of s.recordLowConfidence) {
      L.push(
        `- ${r.repo} — weak evidence, ${(r.substantiveBodyShare * 100).toFixed(1)}% of ${r.sampled} ` +
          'sampled commits carry a body beyond the subject.'
      );
    }
    L.push('');
  }

  // ---- 3. distribution ----
  L.push('## Distribution of flagged counts');
  L.push('');
  L.push('| flagged regions | repositories |');
  L.push('| --- | ---: |');
  for (const d of s.distribution) L.push(`| ${d.bucket} | ${d.repos} |`);
  L.push('');
  L.push(
    `Over the ${s.totals.completed} repositories that completed. This is the shape behind the hit ` +
      'rate: a rate carried by a few repositories with many flagged regions is a different ' +
      'prospecting story from the same rate spread one region apiece.'
  );
  L.push('');

  // ---- 4. errors ----
  L.push('## Repositories that errored');
  L.push('');
  if (s.errors.length === 0) {
    L.push('None.');
  } else {
    L.push('| repo | phase | error |');
    L.push('| --- | --- | --- |');
    for (const e of s.errors) {
      L.push(`| ${e.repo} | ${e.phase} | ${e.error.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
    }
    L.push('');
    L.push(
      'Listed rather than dropped, and excluded from the hit-rate denominator. A repository that ' +
        'failed to clone did not report zero flagged regions; it reported nothing.'
    );
  }
  L.push('');

  // ---- method ----
  L.push('## Method');
  L.push('');
  L.push(`- Repo list: \`${s.reposFile}\`. Clones: \`${s.clonesDir}\`.`);
  L.push(
    `- Clones are shallow, \`--shallow-since="${s.cloneWindow}"\`, so a sweep measures over less ` +
      'history than a full `map` run of the same repository would. Sweep is triage; re-clone ' +
      'deeper before sending anything.'
  );
  L.push(
    '- Record coverage is off. It needs a model call per commit sampled, and the point of a sweep ' +
      'is to choose targets before spending anything on them.'
  );
  L.push(
    '- Each repository is built in its own process with a hard timeout, so one that hangs is ' +
      'recorded as a timeout and the sweep continues.'
  );
  L.push(
    '- No individual is named anywhere above, and that is structural: regions carry counts and ' +
      'opaque identity keys, and this report never sees anything else. See `identity.ts`.'
  );
  L.push('');
  return `${L.join('\n')}\n`;
}
