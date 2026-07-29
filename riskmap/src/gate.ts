/**
 * The body-density gate — and it is a gate, not a caveat.
 *
 * ── WHY THIS IS DIFFERENT ON A HEATMAP ────────────────────────────────────────────────────
 *
 * On a ten-row table an unmeasurable dimension renders as a dash and the reader moves on. On a
 * treemap COLOUR IS THE MESSAGE, so a repository that squashes every pull request to its title
 * renders as uniformly alarming — and that is not a caveat, it is a lie, shipped in the one
 * medium where the reader cannot see the missing data.
 *
 * The study already rejected four repositories on exactly this test: home-assistant and n8n
 * squash to the title alone, django and kubernetes never let the description enter git. Across
 * the five it admitted, body density ran from 41% (grafana) to 95% (prisma). So the pass rate is
 * neither ~0 nor ~1, which is precisely why it has to be measured rather than assumed.
 *
 * ── WHY IT IS ALMOST FREE ─────────────────────────────────────────────────────────────────
 *
 * The test needs COMMIT MESSAGES ONLY. No `--numstat`, therefore no blob content, therefore a
 * `--filter=blob:none --depth=N` clone works — seconds and a few megabytes per repository, and
 * not one model call. This is the cheapest number in the project and it sizes the whole channel,
 * so it runs before anything is built on top of it.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { classifyRecord } from './vendor/triviality.js';
import { isBot } from './identity.js';
import { LOW_CONFIDENCE_BELOW, UNAVAILABLE_BELOW, SAMPLE_SIZE } from './squash.js';

const exec = promisify(execFile);
const UNIT = '\x1f';
const REC = '\x1e';

/** Commits to fetch. Only the most recent matter: merge conventions change. */
const DEPTH = 400;

export type GateVerdict = 'pass' | 'weak' | 'fail' | 'error';

export interface GateResult {
  repo: string;
  verdict: GateVerdict;
  /** Share of sampled commits whose message says anything beyond its subject. */
  substantiveShare: number;
  /** Share whose body is empty in git before any stripping — the squash signature. */
  emptyBodyShare: number;
  sampled: number;
  /** Share of sampled commits carrying a `(#1234)` suffix, the squash-merge tell. */
  prSuffixShare: number;
  seconds: number;
  error?: string;
}

function normaliseUrl(line: string): { url: string; name: string } | null {
  const t = line.replace(/#.*$/, '').trim();
  if (!t) return null;
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(t)) {
    const m = t.match(/[:/]([^/:]+\/[^/]+?)(\.git)?$/);
    return { url: t, name: m?.[1] ?? t };
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(t)) return { url: `https://github.com/${t}`, name: t };
  return null;
}

/**
 * Measure one repository.
 *
 * Bots are excluded before the share is computed. A release bot commits constantly with a
 * one-line subject and nothing else, so leaving them in would fail a repository for its CI
 * configuration rather than for its merge convention.
 */
export async function gateRepo(
  url: string,
  name: string,
  cacheDir: string,
  timeoutMs = 120_000
): Promise<GateResult> {
  const started = Date.now();
  const dir = join(cacheDir, name.replace(/[^\w.-]+/g, '_'));
  const base: GateResult = {
    repo: name,
    verdict: 'error',
    substantiveShare: 0,
    emptyBodyShare: 0,
    sampled: 0,
    prSuffixShare: 0,
    seconds: 0,
  };

  try {
    if (!existsSync(join(dir, '.git')) && !existsSync(join(dir, 'HEAD'))) {
      mkdirSync(cacheDir, { recursive: true });
      // Messages only: blobless AND shallow. No file contents are ever needed here.
      await exec(
        'git',
        ['clone', '--filter=blob:none', '--no-checkout', `--depth=${DEPTH}`, '--quiet', url, dir],
        { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }
      );
    }
    const { stdout } = await exec(
      'git',
      ['log', '--no-merges', `--format=${REC}%an${UNIT}%ae${UNIT}%s${UNIT}%b`, `-n${SAMPLE_SIZE * 2}`],
      { cwd: dir, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 }
    );

    let n = 0;
    let substantive = 0;
    let rawEmpty = 0;
    let prSuffix = 0;
    for (const chunk of stdout.split(REC)) {
      if (!chunk.trim()) continue;
      const parts = chunk.split(UNIT);
      if (parts.length < 4) continue;
      const [an = '', ae = '', subject = ''] = parts;
      const body = parts.slice(3).join(UNIT).trim();
      if (isBot(an, ae)) continue;
      if (n >= SAMPLE_SIZE) break;
      n++;
      if (!body) rawEmpty++;
      if (/\(#\d+\)\s*$/.test(subject)) prSuffix++;
      if (classifyRecord(`${subject}\n${body}`).tier === 'substantive') substantive++;
    }

    if (n === 0) {
      return { ...base, error: 'no non-bot commits in the sample', seconds: (Date.now() - started) / 1000 };
    }
    const share = substantive / n;
    return {
      repo: name,
      verdict: share < UNAVAILABLE_BELOW ? 'fail' : share < LOW_CONFIDENCE_BELOW ? 'weak' : 'pass',
      substantiveShare: share,
      emptyBodyShare: rawEmpty / n,
      sampled: n,
      prSuffixShare: prSuffix / n,
      seconds: (Date.now() - started) / 1000,
    };
  } catch (e) {
    return {
      ...base,
      error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      seconds: (Date.now() - started) / 1000,
    };
  }
}

export interface GateSummary {
  results: GateResult[];
  passRate: { pass: number; weak: number; fail: number; errored: number; denominator: number };
}

export async function runGate(opts: {
  urls: string[];
  cacheDir: string;
  keepClones: boolean;
  onProgress?: (m: string) => void;
}): Promise<GateSummary> {
  const log = opts.onProgress ?? (() => {});
  const results: GateResult[] = [];
  for (const [i, raw] of opts.urls.entries()) {
    const u = normaliseUrl(raw);
    if (!u) continue;
    const r = await gateRepo(u.url, u.name, opts.cacheDir);
    results.push(r);
    log(
      `[${i + 1}/${opts.urls.length}] ${u.name.padEnd(34)} ${r.verdict.padEnd(5)} ` +
        `${(r.substantiveShare * 100).toFixed(0).padStart(3)}% substantive  ` +
        `${(r.emptyBodyShare * 100).toFixed(0).padStart(3)}% empty  ${r.seconds.toFixed(1)}s` +
        (r.error ? `  — ${r.error}` : '')
    );
  }
  if (!opts.keepClones) rmSync(opts.cacheDir, { recursive: true, force: true });

  const done = results.filter((r) => r.verdict !== 'error');
  return {
    results,
    passRate: {
      pass: done.filter((r) => r.verdict === 'pass').length,
      weak: done.filter((r) => r.verdict === 'weak').length,
      fail: done.filter((r) => r.verdict === 'fail').length,
      errored: results.length - done.length,
      denominator: done.length,
    },
  };
}

export function formatGateReport(s: GateSummary): string {
  const L: string[] = [];
  const p = s.passRate;
  const pctOf = (n: number) => (p.denominator ? `${((100 * n) / p.denominator).toFixed(0)}%` : '—');

  L.push('# The body-density gate');
  L.push('');
  L.push('Can a coverage heatmap be honest about this repository at all? The test is whether');
  L.push('commit messages carry anything beyond their subject line. Where they do not, the');
  L.push('description the author wrote stayed on the pull request and never entered git, so a');
  L.push('coverage map would be measuring the merge button and rendering it as colour.');
  L.push('');
  L.push('Measured from commit messages only — no file contents, no model calls.');
  L.push('');
  L.push(`## Pass rate: **${p.pass}/${p.denominator}** = **${pctOf(p.pass)}** of repositories can carry this artifact`);
  L.push('');
  L.push(`| verdict | repos | share | meaning |`);
  L.push(`| --- | --- | --- | --- |`);
  L.push(`| pass | ${p.pass} | ${pctOf(p.pass)} | ≥25% substantive bodies — the map is measuring authors |`);
  L.push(`| weak | ${p.weak} | ${pctOf(p.weak)} | 10-25% — renderable but the merge convention is doing some of the work |`);
  L.push(`| fail | ${p.fail} | ${pctOf(p.fail)} | <10% — **refuse to render**; the map would be a lie |`);
  L.push(`| errored | ${p.errored} | — | excluded from the denominator entirely |`);
  L.push('');
  L.push('## Per repository');
  L.push('');
  L.push('| repo | verdict | substantive bodies | empty bodies | `(#123)` subjects | n | seconds |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of [...s.results].sort((a, b) => b.substantiveShare - a.substantiveShare)) {
    if (r.verdict === 'error') {
      L.push(`| ${r.repo} | error | — | — | — | — | ${r.seconds.toFixed(1)} |`);
      continue;
    }
    L.push(
      `| ${r.repo} | ${r.verdict} | ${(r.substantiveShare * 100).toFixed(0)}% | ` +
        `${(r.emptyBodyShare * 100).toFixed(0)}% | ${(r.prSuffixShare * 100).toFixed(0)}% | ${r.sampled} | ${r.seconds.toFixed(1)} |`
    );
  }
  L.push('');
  const errs = s.results.filter((r) => r.verdict === 'error');
  if (errs.length) {
    L.push('## Errors, listed rather than dropped');
    L.push('');
    for (const r of errs) L.push(`- \`${r.repo}\` — ${r.error}`);
    L.push('');
  }
  L.push('## How to read the columns');
  L.push('');
  L.push('**Empty bodies** is the squash signature: a high share means most commits are a subject');
  L.push('and nothing else. **`(#123)` subjects** is the corroborating tell — GitHub appends the PR');
  L.push('number when it squashes. A repository high on both is squash-on-merge, and its');
  L.push('description text is not in the clone at any depth.');
  L.push('');
  L.push('Thresholds are the study\'s, not invented here: it admitted repositories at ≥25% and');
  L.push('rejected withastro/astro at 17%, home-assistant and n8n at 0%.');
  L.push('');
  return L.join('\n');
}
