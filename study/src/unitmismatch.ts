/**
 * Unit-mismatch probe: what a PR record loses when only part of it survives into git.
 *
 * WHY THIS EXISTS. Reckon's risk map scores COMMIT MESSAGES, because its whole input is a git
 * clone and pull-request descriptions are not in one. It reports the resulting coverage as a
 * position against this study's distribution, and ships a directional hedge: "a commit-only
 * record is a subset of a PR record, so the percentile is biased low" — with no magnitude.
 *
 * WHAT THIS MODULE DOES *NOT* DO, and why. The obvious way to put a number on that hedge is to
 * split each `record.md` into "PR description" and "commit messages" and score both. That split
 * IS NOT AVAILABLE IN THIS CORPUS, and inventing one would fabricate the answer:
 *
 *   `record.md` is `# <squash subject>` + the squash commit BODY, read out of git by stage 1
 *   (`git log %s %b`). One field. Whether that body is the author's PR description or GitHub's
 *   concatenation of the branch's commit messages depends on the repository's squash setting
 *   and on how many commits the branch had, and NOTHING IN THE ARTIFACT RECORDS WHICH. The
 *   branch's individual commit messages are not in the corpus at all — squash discarded them
 *   before stage 1 ever ran.
 *
 *   The tempting marker — a top-level `* ` bullet list, which is what GitHub's commit-detail
 *   concatenation looks like — is provably ambiguous here: 35 of the 250 records carry `* `
 *   bullets that are ordinary markdown inside a PR description (CodeRabbit release-note
 *   summaries, "## Summary" lists). A parser keying on it would misclassify those as commit
 *   messages and quietly invent a difference.
 *
 * SO WHAT IS SCORED IS A BOUND, NOT THE CONTRAST. Two arms, same questions, independent
 * scoring:
 *
 *   full     — `record.md`, exactly the study's real-record arm.
 *   subject  — the subject line alone, body removed. The floor: what survives when a merge
 *              keeps only the title.
 *
 * Under the hedge's OWN premise (the tool's text is a subset of the study's record), the
 * commit-only coverage of any PR lies between these two arms, so `full − subject` is an UPPER
 * BOUND on the bias the hedge describes and 0 is the lower bound. The bound is attained only
 * where the surviving commit messages carry nothing beyond their subjects — which is precisely
 * the case the map's own squash detector already refuses to report on.
 *
 * INFORMATION SEPARATION is inherited unchanged. Questions come from `questions.json`, which
 * stage 2 built from the diff alone; this module holds a `record-only` reader and asserts
 * `assertNoRawDiff` on every assembled prompt. A tripped guard aborts.
 */

import type { LlmBackend } from '@reckon/core';
import { PrReader, assertNoRawDiff } from './guard.js';
import { prDirs, readMeta, readJson, writeJson, readText, writeText, has, mapLimit } from './io.js';
import { SCORER_SYSTEM_SINGLE } from './stage4_score.js';
import { classifyRecord } from './triviality.js';
import type { QuestionsFile } from './stage2_questions.js';

export const SUBJECT_FILE = 'variant_subject.md';
export const SCORES_FILE = 'scores_variants.json';

export type VariantArm = 'full' | 'subject';

export interface VariantQuestionScore {
  concept: string;
  question: string;
  full: number;
  subject: number;
  fullRationale: string;
  subjectRationale: string;
}

export interface VariantScores {
  id: string;
  mode: 'independent';
  model: string;
  scores: VariantQuestionScore[];
}

/* ── variant construction ──────────────────────────────────────────────────────────────── */

/**
 * The subject-only variant.
 *
 * `record.md` is `# <subject>` followed by a blank line and the body, so the first line IS the
 * subject and taking it alone is a lossless split — the only split in this file that is one.
 * Records whose body is already empty produce an identical variant, which is reported rather
 * than hidden: those PRs contribute an exact zero to the paired difference by construction.
 */
export function buildVariants(root: string): { written: number; identical: number } {
  let written = 0;
  let identical = 0;
  for (const dir of prDirs(root)) {
    const record = new PrReader(dir, 'record-only').readRecord();
    const first = record.split('\n', 1)[0];
    const variant = `${first}\n`;
    if (record.trim() === variant.trim()) identical++;
    writeText(dir, SUBJECT_FILE, variant);
    written++;
  }
  return { written, identical };
}

/* ── scoring ───────────────────────────────────────────────────────────────────────────── */

function extractJson(raw: string): any {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function clampScore(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r >= 0 && r <= 2 ? r : null;
}

/** One judgement: one question, one text, alone in its own call. Same prompt as stage 4b. */
async function scoreOne(
  backend: LlmBackend,
  question: string,
  text: string
): Promise<{ score: number; rationale: string } | null> {
  const user = [
    `QUESTION:\n${question}`,
    '',
    `TEXT:\n"""\n${text || '(empty)'}\n"""`,
    '',
    'Return ONLY the JSON object now, starting with {',
  ].join('\n');
  assertNoRawDiff(user, 'unitmismatch/single-scorer-input');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parsed = extractJson(await backend.complete(SCORER_SYSTEM_SINGLE, user));
      const s = clampScore(parsed?.score);
      if (s !== null) return { score: s, rationale: String(parsed?.rationale ?? '').slice(0, 400) };
    } catch {
      /* retry once */
    }
  }
  return null;
}

export interface VariantScoreReport {
  attempted: number;
  written: number;
  skipped: number;
  failedQuestions: number;
  failed: string[];
}

export async function scoreVariants(
  root: string,
  backend: LlmBackend,
  modelLabel: string,
  concurrency: number,
  force = false,
  onProgress?: (done: number, total: number) => void
): Promise<VariantScoreReport> {
  const eligible = prDirs(root).filter((d) => has(d, 'questions.json') && has(d, SUBJECT_FILE));
  const dirs = eligible.filter((d) => force || !has(d, SCORES_FILE));
  const failed: string[] = [];
  let written = 0;
  let failedQuestions = 0;
  let done = 0;

  await mapLimit(dirs, concurrency, async (dir) => {
    const meta = readMeta(dir);
    const qf = readJson<QuestionsFile>(dir, 'questions.json');
    if (!qf) return;

    const reader = new PrReader(dir, 'record-only');
    const texts: Record<VariantArm, string> = {
      full: reader.readRecord().trim(),
      subject: readText(dir, SUBJECT_FILE).trim(),
    };

    const scores: VariantQuestionScore[] = [];
    for (const q of qf.questions) {
      const [full, subject] = await Promise.all([
        scoreOne(backend, q.question, texts.full),
        scoreOne(backend, q.question, texts.subject),
      ]);
      if (!full || !subject) {
        failedQuestions++;
        continue;
      }
      scores.push({
        concept: q.concept,
        question: q.question,
        full: full.score,
        subject: subject.score,
        fullRationale: full.rationale,
        subjectRationale: subject.rationale,
      });
    }

    done++;
    onProgress?.(done, dirs.length);

    if (scores.length === 0) {
      failed.push(meta.id);
      return;
    }
    const out: VariantScores = { id: meta.id, mode: 'independent', model: modelLabel, scores };
    writeJson(dir, SCORES_FILE, out);
    written++;
  });

  return { attempted: dirs.length, written, skipped: eligible.length - dirs.length, failedQuestions, failed };
}

/* ── analysis ──────────────────────────────────────────────────────────────────────────── */

export interface VariantRow {
  id: string;
  repo: string;
  provenance: string;
  tier: string;
  nQuestions: number;
  fullPct2: number;
  subjectPct2: number;
  diff: number;
  recordChars: number;
}

export function loadVariantRows(root: string): VariantRow[] {
  const rows: VariantRow[] = [];
  for (const dir of prDirs(root)) {
    const s = readJson<VariantScores>(dir, SCORES_FILE);
    if (!s || s.scores.length === 0) continue;
    const meta = readMeta(dir);
    const record = new PrReader(dir, 'record-only').readRecord();
    const n = s.scores.length;
    const fullPct2 = (100 * s.scores.filter((q) => q.full === 2).length) / n;
    const subjectPct2 = (100 * s.scores.filter((q) => q.subject === 2).length) / n;
    rows.push({
      id: meta.id,
      repo: meta.repo,
      provenance: meta.provenance,
      tier: classifyRecord(record).tier,
      nQuestions: n,
      fullPct2,
      subjectPct2,
      diff: fullPct2 - subjectPct2,
      recordChars: record.trim().length,
    });
  }
  return rows;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cluster bootstrap over PRs, not over questions — the study's rule, for the study's reason:
 * each PR contributes 2-4 questions scored against the same two texts, so treating questions
 * as independent would shrink the interval by roughly √(cluster size) and manufacture
 * precision. Resampling PRs and recomputing the mean per-PR difference keeps the cluster.
 */
export function clusterBootstrapCi(values: number[], iterations = 5000, seed = 'unit-mismatch-v1'): [number, number] {
  if (values.length === 0) return [NaN, NaN];
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const rng = mulberry32(Math.abs(h));
  const means: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(rng() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(0.025 * means.length)];
  const hi = means[Math.min(means.length - 1, Math.floor(0.975 * means.length))];
  return [lo, hi];
}

export interface PairedSummary {
  n: number;
  nQuestions: number;
  fullMean: number;
  subjectMean: number;
  meanDiff: number;
  medianDiff: number;
  ci: [number, number];
  shareDiffering: number;
  shareFullHigher: number;
  shareSubjectHigher: number;
}

export function summarise(rows: VariantRow[]): PairedSummary {
  const diffs = rows.map((r) => r.diff);
  return {
    n: rows.length,
    nQuestions: rows.reduce((a, r) => a + r.nQuestions, 0),
    fullMean: mean(rows.map((r) => r.fullPct2)),
    subjectMean: mean(rows.map((r) => r.subjectPct2)),
    meanDiff: mean(diffs),
    medianDiff: median(diffs),
    ci: clusterBootstrapCi(diffs),
    shareDiffering: (100 * diffs.filter((d) => d !== 0).length) / (diffs.length || 1),
    shareFullHigher: (100 * diffs.filter((d) => d > 0).length) / (diffs.length || 1),
    shareSubjectHigher: (100 * diffs.filter((d) => d < 0).length) / (diffs.length || 1),
  };
}

export function variantCsv(rows: VariantRow[]): string {
  const cols = ['id', 'repo', 'provenance', 'tier', 'nQuestions', 'fullPct2', 'subjectPct2', 'diff', 'recordChars'];
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.repo,
        r.provenance,
        r.tier,
        r.nQuestions,
        r.fullPct2.toFixed(4),
        r.subjectPct2.toFixed(4),
        r.diff.toFixed(4),
        r.recordChars,
      ].join(',')
    );
  }
  return `${lines.join('\n')}\n`;
}
