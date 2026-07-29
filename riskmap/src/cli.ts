/**
 * The command surface.
 *
 *   riskmap map <clone>          build the page. git only unless --coverage is passed.
 *   riskmap validate <clone>     the retrospective test: does a flag predict anything?
 *   riskmap calibrate            rebuild the calibration distribution from the study results.
 *
 * `map` is deliberately usable with no keys, no config and no network. The build spec is
 * explicit that steps 1-4 and 8 already produce something worth sending and that validation
 * must not block the artifact reaching a human, so the default path is the one that works
 * on a laptop with a clone and nothing else.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { buildMap } from './build.js';
import { renderHtml } from './render.js';
import { runValidation, formatValidationReport } from './validate.js';
import { AnthropicBackend, OpenAiBackend } from './vendor/backends.js';
import type { LlmBackend } from '@reckon/core';
import { LeakageError } from './coverage.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const argv = process.argv.slice(2);
const cmd = argv[0];

function arg(name: string, dflt?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  return dflt;
}
function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}
function positional(i: number): string | undefined {
  const rest = argv.slice(1).filter((a, idx, all) => {
    if (a.startsWith('--')) return false;
    const prev = all[idx - 1];
    return !(prev && prev.startsWith('--'));
  });
  return rest[i];
}

/**
 * Backends. Generation takes the stronger model and scoring the cheaper one — writing
 * questions from a diff is the hard task, judging whether a text answers one is the easy one.
 * Same routing as the study, so a coverage number here is comparable to the corpus it is
 * calibrated against.
 */
function backends(): { gen: LlmBackend; score: LlmBackend; labels: string } {
  const oa = process.env.OPENAI_API_KEY;
  const an = process.env.ANTHROPIC_API_KEY;
  const genOverride = process.env.RISKMAP_GEN_MODEL;
  const scoreOverride = process.env.RISKMAP_SCORE_MODEL;

  if (an && oa) {
    return {
      gen: new AnthropicBackend(an, genOverride ?? 'claude-sonnet-5'),
      score: new OpenAiBackend(oa, scoreOverride ?? 'gpt-5.4-mini'),
      labels: `anthropic:${genOverride ?? 'claude-sonnet-5'} / openai:${scoreOverride ?? 'gpt-5.4-mini'}`,
    };
  }
  if (oa) {
    return {
      gen: new OpenAiBackend(oa, genOverride ?? 'gpt-5.4'),
      score: new OpenAiBackend(oa, scoreOverride ?? 'gpt-5.4-mini'),
      labels: `openai:${genOverride ?? 'gpt-5.4'} / openai:${scoreOverride ?? 'gpt-5.4-mini'}`,
    };
  }
  if (an) {
    return {
      gen: new AnthropicBackend(an, genOverride ?? 'claude-sonnet-5'),
      score: new AnthropicBackend(an, scoreOverride ?? 'claude-haiku-4-5-20251001'),
      labels: `anthropic:${genOverride ?? 'claude-sonnet-5'} / anthropic:${scoreOverride ?? 'claude-haiku-4-5-20251001'}`,
    };
  }
  throw new Error(
    'Record coverage needs OPENAI_API_KEY or ANTHROPIC_API_KEY. Drop --coverage to build the ' +
      'git-only map, which is the default and needs nothing.'
  );
}

async function cmdMap() {
  const repo = positional(0);
  if (!repo) throw new Error('usage: riskmap map <path-to-clone> [--coverage] [--out DIR]');
  const repoPath = resolve(repo);

  const outDir = resolve(arg('out', join(ROOT, 'out'))!);
  mkdirSync(outDir, { recursive: true });

  const wantCoverage = flag('coverage');
  let coverage = null as Parameters<typeof buildMap>[0]['coverage'];
  if (wantCoverage) {
    const b = backends();
    console.error(`record coverage enabled — ${b.labels}`);
    coverage = { backend: b.score, genBackend: b.gen, perRegion: Number(arg('per-region', '6')) };
  }

  const { map, calibration } = await buildMap({
    repo: repoPath,
    depth: arg('depth') ? Number(arg('depth')) : undefined,
    thresholds: {
      ...(arg('window') ? { windowMonths: Number(arg('window')) } : {}),
      ...(arg('inactivity') ? { inactivityMonths: Number(arg('inactivity')) } : {}),
      ...(arg('min-flags') ? { minFlags: Number(arg('min-flags')) } : {}),
    },
    coverage,
    onProgress: (m) => console.error(`  ${m}`),
  });

  const slug = map.report.repo.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const html = join(outDir, `${slug}-risk-map.html`);
  const json = join(outDir, `${slug}-risk-map.json`);
  writeFileSync(html, renderHtml(map, calibration));
  writeFileSync(json, `${JSON.stringify(map, null, 2)}\n`);

  console.error('');
  // `top` is capped at ten, so printing its length reported 30 flagged regions as "10".
  const nFlagged = map.regions.filter((r) => r.flagged).length;
  console.error(
    `${nFlagged} flagged region${nFlagged === 1 ? '' : 's'} of ${map.regions.length}` +
      (nFlagged > map.top.length ? ` (showing the top ${map.top.length})` : '')
  );
  for (const r of map.top) {
    console.error(
      `  ${r.path.padEnd(38)} orphaned ${(r.orphanedShare * 100).toFixed(0).padStart(3)}%  ` +
        `conc ${(r.concentration * 100).toFixed(0).padStart(3)}%  ` +
        `${r.commitsPerMonth.toFixed(1).padStart(5)}/mo  [${r.flags.join(',')}]`
    );
  }
  console.error('');
  console.error(`wrote ${html}`);
  console.error(`wrote ${json}`);
}

async function cmdValidate() {
  // Flag VALUES are not repositories. `--months-back 18` would otherwise contribute "18" as a
  // clone path, and the failure surfaces as `spawn git ENOENT` two minutes into a run.
  const rest = argv.slice(1);
  const repos = rest.filter((a, i) => {
    if (a.startsWith('--')) return false;
    const prev = rest[i - 1];
    return !(prev && prev.startsWith('--'));
  });
  if (repos.length === 0) throw new Error('usage: riskmap validate <clone> [<clone>...] [--months-back 18]');
  const monthsBack = Number(arg('months-back', '18'));
  const followMonths = Number(arg('follow-months', '12'));

  const result = await runValidation({
    repos: repos.map((r) => resolve(r)),
    monthsBack,
    followMonths,
    onProgress: (m) => console.error(`  ${m}`),
  });

  const outDir = resolve(arg('out', join(ROOT, 'out'))!);
  mkdirSync(outDir, { recursive: true });
  const md = join(outDir, 'validation.md');
  writeFileSync(md, formatValidationReport(result));
  writeFileSync(join(outDir, 'validation.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.error(`\nwrote ${md}`);
  console.error(formatValidationReport(result));
}

/**
 * Rebuild `calibration/study-coverage.json` from the study's published per-PR scores.
 *
 * Derived rather than copied so the provenance is checkable: the source commit is recorded in
 * the file, and this command regenerates it from a CSV anyone can read.
 */
function cmdCalibrate() {
  const csv = resolve(arg('from', join(ROOT, '..', 'study', 'results', 'per-pr-scores.csv'))!);
  if (!existsSync(csv)) {
    throw new Error(
      `No study results at ${csv}. In a standalone checkout the calibration file is committed ` +
        'and this command is not needed; pass --from to point at a per-pr-scores.csv.'
    );
  }
  let sourceCommit = 'unknown-commit';
  try {
    sourceCommit = execSync('git log -1 --format=%H -- study/results/per-pr-scores.csv', {
      cwd: join(ROOT, '..'),
      encoding: 'utf8',
    }).trim() || 'unknown-commit';
  } catch {
    // A standalone checkout has no study history; the committed calibration file already
    // carries its provenance, so this path only matters when someone regenerates.
  }
  const lines = readFileSync(csv, 'utf8').trim().split('\n');
  const header = (lines[0] ?? '').split(',');
  const col = header.indexOf('realPctExplicit');
  if (col < 0) throw new Error('per-pr-scores.csv has no realPctExplicit column');

  const vals = lines
    .slice(1)
    .map((l) => Number(l.split(',')[col]) / 100)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);

  const q = (p: number) => {
    const k = (vals.length - 1) * p;
    const f = Math.floor(k);
    const c = Math.min(f + 1, vals.length - 1);
    return vals[f]! + (vals[c]! - vals[f]!) * (k - f);
  };
  const round = (v: number) => Number(v.toFixed(6));

  const out = {
    corpus:
      '1,000 merged pull requests from grafana/grafana, apache/airflow, supabase/supabase, ' +
      'langchain-ai/langchain and prisma/prisma',
    n: vals.length,
    measure:
      'share of mechanism questions answered explicitly (rubric score 2) by the real written ' +
      'record, independent scoring',
    // Provenance must survive a rebuild. Recording resolve(csv) would replace the committed
    // "study/results/per-pr-scores.csv @ <commit>" string with a local absolute path and then
    // serialise that into every customer-facing JSON.
    source: `study/results/per-pr-scores.csv @ ${sourceCommit}, column realPctExplicit`,
    deciles: Array.from({ length: 9 }, (_, i) => round(q((i + 1) / 10))),
    min: round(vals[0] ?? 0),
    max: round(vals[vals.length - 1] ?? 0),
    mean: round(vals.reduce((a, b) => a + b, 0) / vals.length),
    median: round(q(0.5)),
    shareAtZero: round(vals.filter((v) => v === 0).length / vals.length),
    sorted: vals.map(round),
  };
  const dest = join(ROOT, 'calibration', 'study-coverage.json');
  writeFileSync(dest, `${JSON.stringify(out, null, 1)}\n`);
  console.error(`wrote ${dest} — n=${out.n}, ${(out.shareAtZero * 100).toFixed(1)}% at zero`);
}

const COMMANDS: Record<string, () => void | Promise<void>> = {
  map: cmdMap,
  validate: cmdValidate,
  calibrate: cmdCalibrate,
};

const run = cmd ? COMMANDS[cmd] : undefined;
if (!run) {
  console.error('commands: map <clone> | validate <clone>... | calibrate');
  process.exit(1);
}

try {
  await run();
} catch (e) {
  if (e instanceof LeakageError) {
    // Never a warning. A run that continued past a leak would produce numbers indistinguishable
    // from clean ones, which is worse than no numbers.
    console.error(`\nABORTED — information separation violated:\n${e.message}`);
    process.exit(2);
  }
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
