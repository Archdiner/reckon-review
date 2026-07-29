#!/usr/bin/env tsx
/**
 * Study CLI. Each stage is a separate command that reads and writes disk, so a stage can be
 * re-run without redoing the ones before it, and every intermediate artifact can be
 * inspected by hand. That is the protocol's requirement and it is also what makes the run
 * cheap to debug: a bad prompt shows up in `questions.json` long before it shows up in a
 * conclusion.
 *
 * Recommended order:
 *   study clone                 fetch the repos (once, ~10 min)
 *   study collect --pilot       50 PRs end to end, to be READ BY HAND before scaling
 *   study questions
 *   study synthetic
 *   study score
 *   study analyze
 *   study handlabel-export      then fill worksheet.jsonl by hand
 *   study handlabel-compare
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { REPOS, REJECTED_REPOS } from './corpus.js';
import { collect } from './stage1_collect.js';
import { generateQuestions, countQuestions } from './stage2_questions.js';
import { generateSynthetic } from './stage3_synthetic.js';
import { generateParaphrase } from './stage3b_paraphrase.js';
import { scoreCorpus, type ScoreMode } from './stage4_score.js';
import { scoreThreeArms } from './stage4b_score3.js';
import { analyze, writeCsvs, formatReport } from './stage6_analyze.js';
import { exportWorksheet, compareLabels } from './handlabel.js';
import { describeCorpus } from './describe.js';
import { backendFor, selfJudgementWarning } from './backends.js';
import { LeakageError } from './guard.js';

const exec = promisify(execFile);

const ROOT = resolve(process.env.STUDY_ROOT || join(process.cwd(), 'data'));
const PRS = join(ROOT, 'prs');
const OUT = join(ROOT, 'out');
const CLONES = resolve(process.env.STUDY_CLONES || join(ROOT, 'clones'));
const CONCURRENCY = Number(process.env.STUDY_CONCURRENCY || 6);

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function cmdClone() {
  mkdirSync(CLONES, { recursive: true });
  const depth = arg('depth');
  for (const r of REPOS) {
    const dest = join(CLONES, r.dir);
    if (existsSync(dest)) {
      console.log(`  ${r.slug}: already present`);
      continue;
    }
    console.log(`  ${r.slug}: cloning…`);
    const args = ['clone', '--filter=blob:none', '--no-checkout'];
    if (depth) args.push(`--depth=${depth}`);
    args.push(`https://github.com/${r.slug}.git`, dest);
    await exec('git', args, { maxBuffer: 1024 * 1024 * 64 });
    console.log(`  ${r.slug}: done`);
  }
  console.log('\nAdmitted repos preserve the PR description in the merge commit.');
  console.log('Rejected, and why:');
  for (const r of REJECTED_REPOS) console.log(`  - ${r.slug}: ${r.reason}`);
}

async function cmdCollect() {
  const pilot = flag('pilot');
  const agentTarget = Number(arg('agents', pilot ? '25' : '500'));
  const humanTarget = Number(arg('humans', pilot ? '25' : '500'));
  const since = arg('since', '2024-07-01')!;

  console.log(`Collecting (agents=${agentTarget}, humans=${humanTarget}, since=${since})…`);
  const rep = await collect({ cloneRoot: CLONES, outDir: PRS, since, agentTarget, humanTarget, seed: 'collect-v1' });

  console.log(`\nKept: ${rep.kept.agent} agent, ${rep.kept.human} human (total ${rep.total})`);
  console.log('Dropped by the exclusion filter:');
  for (const [k, v] of Object.entries(rep.drops)) if (v) console.log(`  ${k}: ${v}`);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'collect-report.json'), `${JSON.stringify(rep, null, 2)}\n`);
}

async function cmdQuestions() {
  const { backend, label, mock } = backendFor('generation');
  console.log(`Generating questions with ${label} (Reckon decompose)…`);
  const rep = await generateQuestions(PRS, backend, label, CONCURRENCY, flag('force'));
  console.log(`  written ${rep.written}, skipped ${rep.skipped}, failed ${rep.failed.length}`);
  if (rep.failed.length) console.log(`  failures: ${rep.failed.slice(0, 10).join(', ')}`);
  console.log(`  total questions in corpus: ${countQuestions(PRS)}`);
  if (mock) console.log('  NOTE: mock backend — questions are placeholders, not findings.');
}

async function cmdSynthetic() {
  const { backend, label, mock } = backendFor('generation');
  console.log(`Writing synthetic descriptions with ${label}…`);
  const rep = await generateSynthetic(PRS, backend, label, CONCURRENCY, flag('force'));
  console.log(`  written ${rep.written}, skipped ${rep.skipped}, failed ${rep.failed.length}`);
  if (mock) console.log('  NOTE: mock backend — descriptions are placeholders, not findings.');
}

/**
 * Stage 3b — the form control. Rewrites the real record in the model's own voice, adding
 * nothing, so the three-arm comparison can separate "the record lacks the information" from
 * "the record is not phrased the way a model-generated question expects".
 */
async function cmdParaphrase() {
  const { backend, label, mock } = backendFor('generation');
  console.log(`Paraphrasing real records with ${label} (form control, adds no information)…`);
  const rep = await generateParaphrase(PRS, backend, label, CONCURRENCY, flag('force'));
  console.log(`  written ${rep.written}, skipped ${rep.skipped}, failed ${rep.failed.length}`);
  if (mock) console.log('  NOTE: mock backend — paraphrases are placeholders, not findings.');
}

/**
 * Stage 4b — score real, synthetic and paraphrase independently. Independent scoring is not
 * optional here: the three arms only compare if they are judged identically, and scoring each
 * alone also removes the contrast effect the pilot measured.
 */
async function cmdScore3() {
  const { backend, label, mock } = backendFor('scoring');
  console.log(`Scoring three arms independently with ${label} (real / synthetic / paraphrase)…`);
  const rep = await scoreThreeArms(PRS, backend, label, CONCURRENCY, flag('force'));
  console.log(`  written ${rep.written}, skipped ${rep.skipped}, PRs failed ${rep.failed.length}, questions failed ${rep.failedQuestions}`);
  if (mock) console.log('  NOTE: mock backend — scores are hash values, not judgements.');
}

async function cmdScore() {
  const { backend, label, mock } = backendFor('scoring');
  const mode = (arg('score-mode', 'paired') as ScoreMode) === 'independent' ? 'independent' : 'paired';
  console.log(`Scoring with ${label} (blinded, mode=${mode})…`);
  const rep = await scoreCorpus(PRS, backend, label, CONCURRENCY, mode, 'score-v1', flag('force'));
  console.log(`  written ${rep.written}, skipped ${rep.skipped}, PRs failed ${rep.failed.length}, questions failed ${rep.failedQuestions}`);
  if (mock) console.log('  NOTE: mock backend — scores are hash values, not judgements.');
}

function cmdAnalyze() {
  mkdirSync(OUT, { recursive: true });
  const a = analyze(PRS);
  if (a.n === 0) {
    console.log('No scored PRs found. Run collect / questions / synthetic / score first.');
    return;
  }
  writeCsvs(PRS, OUT, a);
  const report = formatReport(a);
  writeFileSync(join(OUT, 'report.md'), `${report}\n`);
  writeFileSync(join(OUT, 'analysis.json'), `${JSON.stringify({ ...a, rows: undefined }, null, 2)}\n`);
  console.log(report);
  console.log(`\nWrote ${join(OUT, 'per-pr-scores.csv')}, per-question-scores.csv, report.md`);
}

function cmdHandlabelExport() {
  const n = Number(arg('n', '50'));
  const dir = join(OUT, 'handlabel');
  const r = exportWorksheet(PRS, dir, n, 'handlabel-v1');
  console.log(`Exported ${r.prs} PRs / ${r.rows} question rows to ${dir}`);
  console.log('Fill score_A and score_B in worksheet.jsonl (worksheet.md is the readable copy).');
}

function cmdHandlabelCompare() {
  const path = arg('worksheet', join(OUT, 'handlabel', 'worksheet.jsonl'))!;
  const r = compareLabels(PRS, path);
  if (r.pairs === 0) {
    console.log('No filled labels found. Fill score_A / score_B in the worksheet first.');
    return;
  }
  const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : 'n/a');
  const lines = [
    '# Human validation',
    '',
    `Labelled judgements compared: **${r.pairs}**`,
    `Exact agreement: **${f1(r.exact)}%**`,
    `Within one point: **${f1(r.adjacent)}%**`,
    `Quadratic weighted kappa: **${r.kappa.toFixed(3)}**`,
    `Mean score — model ${r.modelMean.toFixed(2)}, human ${r.humanMean.toFixed(2)}`,
    '',
    'Lead with kappa. On a 3-point scale with one dominant class, raw agreement flatters',
    'any labeller who guesses the mode, and this rubric has a heavy 0 class.',
    '',
    `## Disagreements (${r.disagreements.length})`,
    '',
  ];
  for (const d of r.disagreements.slice(0, 60)) {
    lines.push(`- ${d.id} q${d.qIndex} [${d.candidate}] model=${d.model} human=${d.human} — ${d.question}`);
  }
  const text = lines.join('\n');
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'human-validation.md'), `${text}\n`);
  console.log(text);
}

/**
 * Copy the publishable artifacts out of the gitignored working directory into `results/`,
 * which is committed.
 *
 * The split is deliberate. `data/` holds ~1000 PR directories of raw diffs — derived,
 * rebuildable from `clone` + `collect`, and far too large to version. `results/` holds only
 * what a reader needs to re-check the claims: the scores, the report, and a manifest saying
 * which models and which commit produced them.
 *
 * Publishing REFUSES on a mock run. Mock scores are hash values, and a `results/` directory
 * containing them would be indistinguishable from real findings a month later — which is
 * exactly the confusion the rest of this pipeline exists to prevent.
 */
async function cmdPublish() {
  const RESULTS = join(process.cwd(), 'results');
  mkdirSync(RESULTS, { recursive: true });

  const analysisPath = join(OUT, 'analysis.json');
  let analysis: any = null;
  if (existsSync(analysisPath)) {
    analysis = JSON.parse(readFileSync(analysisPath, 'utf8'));
    if (analysis?.mock) {
      console.error('Refusing to publish: the scored run used the mock backend.');
      console.error('Mock scores are hash values. Publishing them would leave a results/');
      console.error('directory indistinguishable from real findings. Run with real credentials.');
      process.exit(2);
    }
  }

  let commit = 'unknown';
  try {
    commit = (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
  } catch {
    /* not a git checkout; leave unknown */
  }

  const artifacts = [
    'collect-report.json', 'corpus-summary.md', 'report.md', 'analysis.json',
    'per-pr-scores.csv', 'per-question-scores.csv', 'human-validation.md',
  ];
  const copied: string[] = [];
  for (const f of artifacts) {
    const src = join(OUT, f);
    if (!existsSync(src)) continue;
    copyFileSync(src, join(RESULTS, f));
    copied.push(f);
  }

  const manifest = {
    publishedAtUtc: new Date().toISOString(),
    commit,
    scored: analysis !== null,
    prsScored: analysis?.n ?? 0,
    questionsScored: analysis?.nQuestions ?? 0,
    generationModel: process.env.STUDY_GEN_MODEL || (analysis ? 'see blind.json' : null),
    scoringModel: process.env.STUDY_SCORE_MODEL || (analysis ? 'see blind.json' : null),
    artifacts: copied,
  };
  writeFileSync(join(RESULTS, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Published ${copied.length} artifact(s) to results/:`);
  for (const f of copied) console.log(`  ${f}`);
  console.log('  manifest.json');
  if (!analysis) console.log('\nNo analysis found — published corpus artifacts only.');
}

function cmdDescribe() {
  mkdirSync(OUT, { recursive: true });
  const text = describeCorpus(PRS);
  writeFileSync(join(OUT, 'corpus-summary.md'), `${text}\n`);
  console.log(text);
}

const COMMANDS: Record<string, () => void | Promise<void>> = {
  clone: cmdClone,
  collect: cmdCollect,
  describe: cmdDescribe,
  publish: cmdPublish,
  questions: cmdQuestions,
  synthetic: cmdSynthetic,
  paraphrase: cmdParaphrase,
  score: cmdScore,
  score3: cmdScore3,
  analyze: cmdAnalyze,
  'handlabel-export': cmdHandlabelExport,
  'handlabel-compare': cmdHandlabelCompare,
};

async function main() {
  const cmd = process.argv[2];
  if (!cmd || !COMMANDS[cmd]) {
    console.log('Usage: study <command> [options]\n');
    console.log('Commands:');
    console.log('  clone                     clone the admitted repos (--depth N to shallow-clone)');
    console.log('  collect                   build the corpus (--pilot, --agents N, --humans N, --since DATE)');
    console.log('  describe                  corpus composition and matching feasibility (no model calls)');
    console.log('  questions                 stage 2: mechanism questions from the diff alone (--force)');
    console.log('  synthetic                 stage 3: synthetic PR description from the diff alone (--force)');
    console.log('  paraphrase                stage 3b: real record restated in model voice, no new info (--force)');
    console.log('  score                     stage 4: blinded scoring (--score-mode paired|independent, --force)');
    console.log('  score3                    stage 4b: real/synthetic/paraphrase scored independently (--force)');
    console.log('  analyze                   stage 6: stats, CSVs and report');
    console.log('  handlabel-export          export the 50-PR validation worksheet (--n N)');
    console.log('  handlabel-compare         agreement between hand labels and the model');
    console.log('  publish                   copy publishable artifacts into results/ (refuses on mock runs)');
    console.log('\nEnvironment:');
    console.log('  ANTHROPIC_API_KEY / OPENAI_API_KEY   model credentials (generation / scoring)');
    console.log('  STUDY_MOCK=1                         run offline with the deterministic backend');
    console.log('  STUDY_ROOT, STUDY_CLONES, STUDY_CONCURRENCY');
    process.exit(1);
  }
  if (['questions', 'synthetic', 'paraphrase', 'score', 'score3'].includes(cmd)) {
    const warn = selfJudgementWarning();
    if (warn) console.warn(`\nWARNING: ${warn}\n`);
  }
  try {
    await COMMANDS[cmd]();
  } catch (e) {
    if (e instanceof LeakageError) {
      console.error(`\nLEAKAGE GUARD TRIPPED — run aborted.\n${e.message}\n`);
      console.error('This is a hard failure by design: a run that continued past a leak would');
      console.error('produce numbers indistinguishable from clean ones.');
      process.exit(2);
    }
    throw e;
  }
}

void main();
