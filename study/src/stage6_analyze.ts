/**
 * Stage 6 — analysis, CSV, and the report.
 *
 * UNCERTAINTY IS COMPUTED BY CLUSTER BOOTSTRAP OVER PRs, NOT OVER QUESTIONS.
 *
 * Each PR yields 2-4 questions scored against the same two texts, so those scores are
 * strongly correlated within a PR. Treating ~1800 questions as ~1800 independent
 * observations would shrink every interval by roughly the square root of the cluster size
 * and manufacture significance out of nothing. Resampling whole PRs with replacement keeps
 * the unit of independence where it actually is.
 *
 * The real-vs-synthetic comparison is PAIRED — the same questions, the same PR, two texts —
 * so the bootstrap resamples PRs and recomputes the mean of the per-PR difference. A paired
 * design is what makes the control powerful: it removes PR-level difficulty entirely.
 *
 * ON READING A NULL RESULT. The headline outcome ("synthetic scores about the same as real")
 * is an absence of difference, and an absence of difference is not proof of equivalence — it
 * can equally mean the study lacked the power to see one. So the report prints the
 * confidence interval, not just the point estimate, and the interpretation depends on the
 * interval being TIGHT around zero rather than merely straddling it. A CI of [-0.4, +0.4]
 * straddles zero and says nothing. That distinction is stated in the output so it cannot be
 * quietly dropped on the way to a headline.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prDirs, readMeta, readJson, has } from './io.js';
import { matchCorpus } from './stage5_match.js';
import type { PrScores, ResultRow, PrMeta } from './types.js';

const BOOTSTRAP_ITERS = 5000;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Percentile bootstrap CI for the mean of `xs`, resampling elements (each = one PR). */
function bootstrapCI(xs: number[], iters = BOOTSTRAP_ITERS, seed = 12345): [number, number] {
  if (xs.length < 2) return [NaN, NaN];
  const rng = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    for (let j = 0; j < xs.length; j++) sum += xs[Math.floor(rng() * xs.length)];
    means.push(sum / xs.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(iters * 0.025)], means[Math.floor(iters * 0.975)]];
}

/** Two-sample bootstrap CI for meanA - meanB, resampling each arm independently. */
function bootstrapDiffCI(a: number[], b: number[], iters = BOOTSTRAP_ITERS, seed = 999): [number, number] {
  if (a.length < 2 || b.length < 2) return [NaN, NaN];
  const rng = mulberry32(seed);
  const diffs: number[] = [];
  for (let i = 0; i < iters; i++) {
    let sa = 0;
    for (let j = 0; j < a.length; j++) sa += a[Math.floor(rng() * a.length)];
    let sb = 0;
    for (let j = 0; j < b.length; j++) sb += b[Math.floor(rng() * b.length)];
    diffs.push(sa / a.length - sb / b.length);
  }
  diffs.sort((x, y) => x - y);
  return [diffs[Math.floor(iters * 0.025)], diffs[Math.floor(iters * 0.975)]];
}

export interface Analysis {
  mock: boolean;
  n: number;
  nQuestions: number;
  rows: ResultRow[];
  overall: {
    realMean: number;
    realPctExplicit: number;
    realPctAbsent: number;
    syntheticMean: number;
    syntheticPctExplicit: number;
  };
  gap: { mean: number; ci: [number, number]; pctExplicitGap: number; pctExplicitCi: [number, number] };
  byProvenance: { arm: string; n: number; realMean: number; realPctExplicit: number }[];
  matched: {
    pairs: number;
    unmatched: { agent: number; human: number };
    agentRealMean: number;
    humanRealMean: number;
    diff: number;
    ci: [number, number];
    strata: { key: string; agent: number; human: number; paired: number }[];
  } | null;
  matchedBotAuthorOnly: { pairs: number; agentRealMean: number; humanRealMean: number; diff: number; ci: [number, number] } | null;
  /** Same contrast with the repo constraint dropped. If it disagrees with the default, the
   *  looser key is picking up project culture rather than authorship. */
  matchedIgnoringRepo: { pairs: number; diff: number; ci: [number, number] } | null;
  bySize: { bucket: string; n: number; realMean: number; realPctExplicit: number; syntheticMean: number }[];
  byRepo: { repo: string; n: number; realMean: number; syntheticMean: number }[];
  emptyBodyShare: number;
}

function rowFor(meta: PrMeta, sc: PrScores): ResultRow {
  const real = sc.scores.map((s) => s.real);
  const syn = sc.scores.map((s) => s.synthetic);
  const pct = (xs: number[]) => (xs.filter((v) => v === 2).length / xs.length) * 100;
  return {
    id: meta.id,
    repo: meta.repo,
    prNumber: meta.prNumber,
    provenance: meta.provenance,
    evidence: meta.evidence,
    language: meta.language,
    changedLines: meta.changedLines,
    sizeBucket: meta.sizeBucket,
    emptyBody: meta.emptyBody,
    nQuestions: sc.scores.length,
    realMean: mean(real),
    syntheticMean: mean(syn),
    realPctExplicit: pct(real),
    syntheticPctExplicit: pct(syn),
    gap: mean(real) - mean(syn),
  };
}

export function analyze(root: string): Analysis {
  const dirs = prDirs(root).filter((d) => has(d, 'scores.json'));
  const rows: ResultRow[] = [];
  const byId = new Map<string, ResultRow>();
  let mock = false;
  let nQuestions = 0;
  let allReal: number[] = [];
  let allSyn: number[] = [];

  for (const d of dirs) {
    const meta = readMeta(d);
    const sc = readJson<PrScores>(d, 'scores.json');
    if (!sc || sc.scores.length === 0) continue;
    const blind = readJson<{ model: string }>(d, 'blind.json');
    if (blind?.model === 'mock') mock = true;
    const r = rowFor(meta, sc);
    rows.push(r);
    byId.set(r.id, r);
    nQuestions += sc.scores.length;
    allReal = allReal.concat(sc.scores.map((s) => s.real));
    allSyn = allSyn.concat(sc.scores.map((s) => s.synthetic));
  }

  const perPrGap = rows.map((r) => r.gap);
  const perPrPctGap = rows.map((r) => r.realPctExplicit - r.syntheticPctExplicit);

  const armStats = (arm: 'agent' | 'human') => {
    const rs = rows.filter((r) => r.provenance === arm);
    return { arm, n: rs.length, realMean: mean(rs.map((r) => r.realMean)), realPctExplicit: mean(rs.map((r) => r.realPctExplicit)) };
  };

  // --- matched agent/human contrast ------------------------------------------------
  let matched: Analysis['matched'] = null;
  const m = matchCorpus(root, 'match-v1');
  if (m.pairs.length >= 2) {
    const a = m.pairs.map((p) => byId.get(p.agent)!.realMean).filter((v) => Number.isFinite(v));
    const h = m.pairs.map((p) => byId.get(p.human)!.realMean).filter((v) => Number.isFinite(v));
    matched = {
      pairs: m.pairs.length,
      unmatched: m.unmatched,
      agentRealMean: mean(a),
      humanRealMean: mean(h),
      diff: mean(a) - mean(h),
      // Pairs are matched but the two arms are distinct PRs, so the paired difference is
      // the right statistic: resample pairs, not arms.
      ci: bootstrapCI(m.pairs.map((p) => byId.get(p.agent)!.realMean - byId.get(p.human)!.realMean)),
      strata: m.strata,
    };
  }

  let matchedLoose: Analysis['matchedIgnoringRepo'] = null;
  const ml = matchCorpus(root, 'match-v1', undefined, true, 'lang-size');
  if (ml.pairs.length >= 2) {
    const d = ml.pairs.map((p) => byId.get(p.agent)!.realMean - byId.get(p.human)!.realMean);
    matchedLoose = { pairs: ml.pairs.length, diff: mean(d), ci: bootstrapCI(d) };
  }

  let matchedBot: Analysis['matchedBotAuthorOnly'] = null;
  const mb = matchCorpus(root, 'match-v1', ['bot-author']);
  if (mb.pairs.length >= 2) {
    const a = mb.pairs.map((p) => byId.get(p.agent)!.realMean);
    const h = mb.pairs.map((p) => byId.get(p.human)!.realMean);
    matchedBot = {
      pairs: mb.pairs.length,
      agentRealMean: mean(a),
      humanRealMean: mean(h),
      diff: mean(a) - mean(h),
      ci: bootstrapCI(mb.pairs.map((p) => byId.get(p.agent)!.realMean - byId.get(p.human)!.realMean)),
    };
  }

  const groupBy = <K extends string>(keyFn: (r: ResultRow) => K) => {
    const map = new Map<K, ResultRow[]>();
    for (const r of rows) {
      const k = keyFn(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(r);
    }
    return map;
  };

  const sizeOrder = ['20-49', '50-149', '150-499', '500+'];
  const bySize = [...groupBy((r) => r.sizeBucket).entries()]
    .sort((a, b) => sizeOrder.indexOf(a[0]) - sizeOrder.indexOf(b[0]))
    .map(([bucket, rs]) => ({
      bucket,
      n: rs.length,
      realMean: mean(rs.map((r) => r.realMean)),
      realPctExplicit: mean(rs.map((r) => r.realPctExplicit)),
      syntheticMean: mean(rs.map((r) => r.syntheticMean)),
    }));

  const byRepo = [...groupBy((r) => r.repo).entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([repo, rs]) => ({
      repo,
      n: rs.length,
      realMean: mean(rs.map((r) => r.realMean)),
      syntheticMean: mean(rs.map((r) => r.syntheticMean)),
    }));

  return {
    mock,
    n: rows.length,
    nQuestions,
    rows,
    overall: {
      realMean: mean(allReal),
      realPctExplicit: (allReal.filter((v) => v === 2).length / Math.max(1, allReal.length)) * 100,
      realPctAbsent: (allReal.filter((v) => v === 0).length / Math.max(1, allReal.length)) * 100,
      syntheticMean: mean(allSyn),
      syntheticPctExplicit: (allSyn.filter((v) => v === 2).length / Math.max(1, allSyn.length)) * 100,
    },
    gap: {
      mean: mean(perPrGap),
      ci: bootstrapCI(perPrGap),
      pctExplicitGap: mean(perPrPctGap),
      pctExplicitCi: bootstrapCI(perPrPctGap),
    },
    byProvenance: [armStats('agent'), armStats('human')],
    matched,
    matchedBotAuthorOnly: matchedBot,
    matchedIgnoringRepo: matchedLoose,
    bySize,
    byRepo,
    emptyBodyShare: (rows.filter((r) => r.emptyBody).length / Math.max(1, rows.length)) * 100,
  };
}

const csvEscape = (v: unknown) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function writeCsvs(root: string, outDir: string, a: Analysis): void {
  const cols: (keyof ResultRow)[] = [
    'id', 'repo', 'prNumber', 'provenance', 'evidence', 'language', 'changedLines',
    'sizeBucket', 'emptyBody', 'nQuestions', 'realMean', 'syntheticMean',
    'realPctExplicit', 'syntheticPctExplicit', 'gap',
  ];
  const fmt = (r: ResultRow, c: keyof ResultRow) => {
    const v = r[c];
    return typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(4) : v;
  };
  const lines = [cols.join(',')];
  for (const r of a.rows) lines.push(cols.map((c) => csvEscape(fmt(r, c))).join(','));
  writeFileSync(join(outDir, 'per-pr-scores.csv'), `${lines.join('\n')}\n`);

  // Per-question detail, so a reader can re-check any individual judgement.
  const qLines = ['id,repo,provenance,concept,question,real_score,synthetic_score,real_rationale,synthetic_rationale'];
  for (const d of prDirs(root)) {
    if (!has(d, 'scores.json')) continue;
    const meta = readMeta(d);
    const sc = readJson<PrScores>(d, 'scores.json');
    if (!sc) continue;
    for (const s of sc.scores) {
      qLines.push(
        [meta.id, meta.repo, meta.provenance, s.concept, s.question, s.real, s.synthetic, s.realRationale, s.syntheticRationale]
          .map(csvEscape)
          .join(',')
      );
    }
  }
  writeFileSync(join(outDir, 'per-question-scores.csv'), `${qLines.join('\n')}\n`);
}

const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a');
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : 'n/a');

export function formatReport(a: Analysis): string {
  const L: string[] = [];
  L.push('# Record-survival study — results');
  L.push('');
  if (a.mock) {
    L.push('> **MOCK RUN — THESE ARE NOT FINDINGS.**');
    L.push('> Scores came from the deterministic offline backend, which does not judge anything.');
    L.push('> This output demonstrates that the pipeline and its leakage guards run end to end.');
    L.push('> Every number below is an artifact of a hash function.');
    L.push('');
  }
  L.push(`PRs scored: **${a.n}**   Questions scored: **${a.nQuestions}**   Empty PR body: **${f1(a.emptyBodyShare)}%**`);
  L.push('');

  L.push('## 1. Answerability of the real record');
  L.push('');
  L.push(`Mean score (0-2): **${f2(a.overall.realMean)}**`);
  L.push(`Questions answered explicitly (score 2): **${f1(a.overall.realPctExplicit)}%**`);
  L.push(`Questions with nothing at all in the record (score 0): **${f1(a.overall.realPctAbsent)}%**`);
  L.push('');

  L.push('## 2. Reproducibility gap — real minus synthetic');
  L.push('');
  L.push(`Real mean **${f2(a.overall.realMean)}** vs synthetic mean **${f2(a.overall.syntheticMean)}**`);
  L.push(`Per-PR mean gap: **${f2(a.gap.mean)}**  95% CI **[${f2(a.gap.ci[0])}, ${f2(a.gap.ci[1])}]** (cluster bootstrap over PRs)`);
  L.push(`Explicit-rate gap: **${f1(a.gap.pctExplicitGap)} pp**  95% CI **[${f1(a.gap.pctExplicitCi[0])}, ${f1(a.gap.pctExplicitCi[1])}]**`);
  L.push('');
  L.push('Interpretation guard: a CI that merely straddles zero is not evidence of equivalence.');
  L.push('The "record is reproducible from the diff" reading requires the interval to be TIGHT');
  L.push('around zero. A wide interval means the study was underpowered, not that the gap is absent.');
  L.push('');

  // "attested", not "authored": on the collected corpus 93% of the agent arm is a
  // Co-authored-by trailer, which evidences assistance rather than authorship.
  L.push('## 3. Agent-attested vs human-authored');
  L.push('');
  for (const p of a.byProvenance) {
    L.push(`- ${p.arm}: n=${p.n}, real mean ${f2(p.realMean)}, explicit ${f1(p.realPctExplicit)}%`);
  }
  L.push('');
  if (a.matched) {
    L.push(`Matched on repo x language x size bucket: **${a.matched.pairs} pairs**`);
    L.push(`(discarded as unmatched: ${a.matched.unmatched.agent} agent, ${a.matched.unmatched.human} human)`);
    L.push(`Agent ${f2(a.matched.agentRealMean)} vs human ${f2(a.matched.humanRealMean)}; ` +
      `difference **${f2(a.matched.diff)}** 95% CI **[${f2(a.matched.ci[0])}, ${f2(a.matched.ci[1])}]**`);
    L.push('');
    L.push('Top strata (repo|language|size: agent/human/paired):');
    for (const s of a.matched.strata.slice(0, 8)) L.push(`  - ${s.key}: ${s.agent}/${s.human}/${s.paired}`);
    L.push('');
    if (a.matchedIgnoringRepo) {
      L.push(`Sensitivity — same contrast without the repo constraint (${a.matchedIgnoringRepo.pairs} pairs): ` +
        `difference **${f2(a.matchedIgnoringRepo.diff)}** 95% CI **[${f2(a.matchedIgnoringRepo.ci[0])}, ${f2(a.matchedIgnoringRepo.ci[1])}]**`);
      L.push('If this disagrees with the within-repo figure, the looser match is measuring');
      L.push('project culture rather than who wrote the change. Report the within-repo one.');
      L.push('');
    }
  } else {
    L.push('_Not enough matched pairs to report._');
    L.push('');
  }
  if (a.matchedBotAuthorOnly) {
    L.push(`Robustness — agent arm restricted to true bot authorship (${a.matchedBotAuthorOnly.pairs} pairs): ` +
      `difference **${f2(a.matchedBotAuthorOnly.diff)}** 95% CI **[${f2(a.matchedBotAuthorOnly.ci[0])}, ${f2(a.matchedBotAuthorOnly.ci[1])}]**`);
    L.push('');
    L.push('If the contrast holds pooled but vanishes here, the pooled result is about');
    L.push('agent-ASSISTED PRs, not agent-authored ones, and must be described that way.');
    L.push('');
  } else {
    L.push('_Bot-author-only robustness check unavailable (too few strictly bot-authored PRs)._');
    L.push('');
  }

  L.push('## 4. Answerability against diff size');
  L.push('');
  L.push('| bucket | n | real mean | real explicit % | synthetic mean |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const s of a.bySize) L.push(`| ${s.bucket} | ${s.n} | ${f2(s.realMean)} | ${f1(s.realPctExplicit)} | ${f2(s.syntheticMean)} |`);
  L.push('');

  L.push('## 5. By repository');
  L.push('');
  L.push('| repo | n | real mean | synthetic mean |');
  L.push('| --- | --- | --- | --- |');
  for (const r of a.byRepo) L.push(`| ${r.repo} | ${r.n} | ${f2(r.realMean)} | ${f2(r.syntheticMean)} |`);
  L.push('');
  L.push('A result that only appears in one repository is that repository\'s culture, not a finding.');
  L.push('');
  L.push('## 6. Human validation');
  L.push('');
  L.push('Run `study handlabel-export` and `study handlabel-compare` to fill this in.');
  L.push('Without it the study is one prompt grading another prompt, which is the first');
  L.push('criticism it will receive and a fair one.');
  L.push('');
  return L.join('\n');
}
