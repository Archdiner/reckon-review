/**
 * THE DATA PACK — every measurement on disk, as flat tidy files someone else can plot.
 *
 * ── WHY THIS IS A COMMAND AND NOT A ONE-OFF SCRIPT ────────────────────────────────────────
 *
 * The measurements currently live in four shapes: two study CSVs with different scoring protocols,
 * a nested record-map JSON per repository, a regression JSON whose fits are three levels deep, and a
 * gate JSON. Anyone wanting to plot across them has to know which protocol a column came from, that
 * `substantiveShare` and `substantiveBodyShare` are different samplers, and that a `null` in one
 * place means "not measured" while a zero in another means "measured as nothing". That knowledge is
 * exactly what gets lost when files are copied into a notebook.
 *
 * So the pack is generated, every column is documented in a written schema, and the two protocols
 * are carried as a COLUMN rather than as a footnote — nothing here can be pooled by accident.
 *
 * ── THE ONE RULE ──────────────────────────────────────────────────────────────────────────
 *
 * MISSING IS EMPTY, NEVER ZERO. A region the coverage stage declined to score and a region that
 * scored nothing are different facts, and a CSV that writes both as `0` destroys the difference
 * irrecoverably. Every numeric column here is blank when unmeasured.
 *
 * No individual is named in any file: the study rows carry a repository and a provenance arm, and
 * the region rows carry a path and counts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordMap } from './recordmap.js';
import { loadSweepMaps } from './recordsweep.js';

/** A cell value: `null` and `undefined` both become an empty field, never a zero. */
type Cell = string | number | boolean | null | undefined;

export function toCsv(header: string[], rows: Cell[][]): string {
  const esc = (v: Cell): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n') + '\n';
}

/**
 * RFC 4180 CSV reader: quoted fields, doubled quotes inside them, and newlines inside them.
 *
 * The first version refused any file containing a `"` and told the caller so. That was safe and
 * insufficient: `per-question-scores.csv` carries the scorer's RATIONALE for every one of 3,181
 * questions, which is prose with commas and quotes in it, and it is the most interesting file in the
 * study. Splitting it on commas would have shifted every column after the first rationale and
 * produced numbers that looked fine.
 *
 * ONE LIMITATION, and it is inherent rather than an oversight: a record consisting of a single empty
 * field serialises to an empty line, which is indistinguishable from a blank separator line. RFC 4180
 * does not resolve that and no reader can. Blank lines are dropped, which is the standard treatment
 * and costs nothing here because no file in the pack is single-column. A row whose fields are ALL
 * empty in a multi-column file is kept, which is the case that would actually lose data.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const push = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    push();
    // A trailing newline yields one empty final row, which is not a record.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i++;
      continue;
    }
    if (c === ',') {
      push();
      i++;
      continue;
    }
    if (c === '\n') {
      endRow();
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

function readCsv(path: string): { header: string[]; rows: Record<string, string>[] } {
  const all = parseCsv(readFileSync(path, 'utf8'));
  const header = all.shift() ?? [];
  return {
    header,
    rows: all.map((parts) => {
      const o: Record<string, string> = {};
      header.forEach((h, i) => {
        o[h] = parts[i] ?? '';
      });
      return o;
    }),
  };
}

const numOrNull = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

export interface DataPackOpts {
  studyResults: string;
  /** Directory of a record sweep (expects `repos/*.json`). May be absent. */
  sweepDir: string;
  /** Single-repository record maps to fold in as well, e.g. the full-depth grafana run. */
  extraRecordMaps: string[];
  gateJson: string;
  regressionJson: string;
  /** Optional per-area coverage measured AS OF the retrospective cutoff. Copied through verbatim. */
  areasAsOfT?: string;
  outDir: string;
}

export interface DataPackResult {
  files: { name: string; rows: number; what: string }[];
  missing: string[];
}

export function buildDataPack(opts: DataPackOpts): DataPackResult {
  mkdirSync(opts.outDir, { recursive: true });
  const files: DataPackResult['files'] = [];
  const missing: string[] = [];
  const write = (name: string, header: string[], rows: Cell[][], what: string): void => {
    writeFileSync(join(opts.outDir, name), toCsv(header, rows));
    files.push({ name, rows: rows.length, what });
  };

  // ── 1. PULL-REQUEST LEVEL, BOTH PROTOCOLS, PROTOCOL AS A COLUMN ─────────────────────────
  //
  // The two study runs scored the SAME 1,000 pull requests and disagree: paired scoring shows the
  // real record at 27.2% explicit, independent scoring at 32.0%. Neither is wrong; they are
  // different protocols, and stacking them with a `protocol` column is the only shape in which a
  // plot cannot silently mix them.
  const threeArm = join(opts.studyResults, 'three-arm-scores.csv');
  const paired = join(opts.studyResults, 'per-pr-scores.csv');
  const prRows: Cell[][] = [];
  const tierById = new Map<string, string>();

  if (existsSync(threeArm)) {
    for (const r of readCsv(threeArm).rows) {
      tierById.set(r.id!, r.tier ?? '');
      prRows.push([
        r.id,
        'independent',
        r.repo,
        r.provenance,
        r.evidence,
        r.tier,
        numOrNull(r.nQuestions),
        pct(r.realPct2),
        pct(r.paraphrasePct2),
        pct(r.syntheticPct2),
        numOrNull(r.real),
        numOrNull(r.paraphrase),
        numOrNull(r.synthetic),
        numOrNull(r.recordChars),
        numOrNull(r.syntheticChars),
        null,
        null,
      ]);
    }
  } else missing.push(threeArm);

  if (existsSync(paired)) {
    for (const r of readCsv(paired).rows) {
      prRows.push([
        r.id,
        'paired',
        r.repo,
        r.provenance,
        r.evidence,
        // Tier lives only in the three-arm file. Joined on id rather than recomputed, and left blank
        // if that file is absent — never guessed from emptyBody, which is a different definition.
        tierById.get(r.id!) ?? null,
        numOrNull(r.nQuestions),
        pct(r.realPctExplicit),
        null,
        pct(r.syntheticPctExplicit),
        numOrNull(r.realMean),
        null,
        numOrNull(r.syntheticMean),
        null,
        null,
        numOrNull(r.changedLines),
        r.language || null,
      ]);
    }
  } else missing.push(paired);

  write(
    'pull-requests.csv',
    [
      'id',
      'protocol',
      'repo',
      'provenance',
      'evidence',
      'tier',
      'questions',
      'coverage_real',
      'coverage_paraphrase',
      'coverage_synthetic',
      'rubric_mean_real',
      'rubric_mean_paraphrase',
      'rubric_mean_synthetic',
      'record_chars',
      'synthetic_chars',
      'changed_lines',
      'language',
    ],
    prRows,
    'one row per pull request per scoring protocol. coverage_* are shares in [0,1]; blank means the ' +
      'arm was not scored under that protocol.'
  );

  // ── 2. QUESTION LEVEL ────────────────────────────────────────────────────────────────────
  const perQ = join(opts.studyResults, 'per-question-scores.csv');
  if (existsSync(perQ)) {
    const { rows } = readCsv(perQ);
    write(
      'questions.csv',
      ['id', 'repo', 'provenance', 'tier', 'score_real', 'score_synthetic'],
      rows.map((r) => [
        r.id,
        r.repo,
        r.provenance,
        tierById.get(r.id!) ?? null,
        numOrNull(r.real_score),
        numOrNull(r.synthetic_score),
      ]),
      'one row per mechanism question. Scores are the 0/1/2 rubric: 2 = answered explicitly, 1 = ' +
        'partial, 0 = absent. The question text and rationales are in the study file and are left ' +
        'out here because they contain commas and quotes.'
    );
  } else missing.push(perQ);

  // ── 3. THE SUBJECT-LINE ABLATION ─────────────────────────────────────────────────────────
  const unit = join(opts.studyResults, 'unit-mismatch-scores.csv');
  if (existsSync(unit)) {
    const { rows } = readCsv(unit);
    write(
      'subject-line-ablation.csv',
      ['id', 'repo', 'provenance', 'tier', 'questions', 'coverage_full_record', 'coverage_subject_only', 'record_chars'],
      rows.map((r) => [
        r.id,
        r.repo,
        r.provenance,
        r.tier,
        numOrNull(r.nQuestions),
        pct(r.fullPct2),
        pct(r.subjectPct2),
        numOrNull(r.recordChars),
      ]),
      'a SEPARATE 250-pull-request draw, each record scored twice: whole record, then subject line ' +
        'alone. Not comparable to absolute numbers from the 1,000-PR corpus; the within-row difference is.'
    );
  } else missing.push(unit);

  // ── 4. REGION LEVEL, POOLED ACROSS EVERY RECORD MAP ON DISK ──────────────────────────────
  const maps: RecordMap[] = loadSweepMaps(opts.sweepDir);
  const seen = new Set(maps.map((m) => `${m.repo}@${m.headSha}`));
  for (const p of opts.extraRecordMaps) {
    if (!existsSync(p)) {
      missing.push(p);
      continue;
    }
    const m = JSON.parse(readFileSync(p, 'utf8')) as RecordMap;
    if (!seen.has(`${m.repo}@${m.headSha}`)) {
      maps.push(m);
      seen.add(`${m.repo}@${m.headSha}`);
    }
  }

  const regionRows: Cell[][] = [];
  const repoRows: Cell[][] = [];
  for (const m of maps) {
    repoRows.push([
      m.repo,
      m.headSha,
      new Date(m.asOf).toISOString().slice(0, 10),
      m.refused,
      m.squash.availability,
      m.squash.substantiveBodyShare,
      m.commitsAnalysed,
      m.windowMonths,
      m.overall ? m.overall.rate : null,
      m.overall ? m.overall.explicit : null,
      m.overall ? m.overall.total : null,
      m.cells.length,
      m.regionsDropped ?? null,
      m.cells.filter((c) => c.greyReason === null).length,
    ]);
    for (const c of m.cells) {
      regionRows.push([
        m.repo,
        c.path,
        c.weight,
        c.coverage,
        c.ciLo,
        c.ciHi,
        c.ciHalfWidth,
        c.scoredCommits,
        c.questions,
        c.coverage !== null && c.questions > 0 ? Math.round(c.coverage * c.questions) : null,
        c.active,
        c.percentile,
        c.greyReason ?? '',
        c.greyReason === null,
      ]);
    }
  }
  write(
    'repositories.csv',
    [
      'repo',
      'head_sha',
      'as_of',
      'refused',
      'gate_verdict',
      'body_density',
      'commits_in_window',
      'window_months',
      'coverage',
      'questions_explicit',
      'questions_total',
      'areas_scored',
      'areas_not_scored',
      'areas_usable',
    ],
    repoRows,
    'one row per repository record map. `coverage` is the question-weighted share explicit across ' +
      'its scored areas. `areas_not_scored` is areas that exist but fell outside the sampling cap.'
  );
  write(
    'areas.csv',
    [
      'repo',
      'area',
      'lines_changed',
      'coverage',
      'ci_lo',
      'ci_hi',
      'ci_half_width',
      'commits_scored',
      'questions',
      'questions_explicit',
      'active_recently',
      'corpus_percentile',
      'grey_reason',
      'usable',
    ],
    regionRows,
    'one row per directory area per repository. `usable` is false when the estimate is too thin to ' +
      'colour — below the scored-commit floor or a wider interval than the rule allows — and those ' +
      'rows should be plotted as uncertain rather than dropped or trusted.'
  );

  // ── 5. THE BODY-DENSITY GATE ─────────────────────────────────────────────────────────────
  if (existsSync(opts.gateJson)) {
    const g = JSON.parse(readFileSync(opts.gateJson, 'utf8')) as {
      results: { repo: string; verdict: string; substantiveShare: number; emptyBodyShare: number; sampled: number; prSuffixShare: number }[];
    };
    write(
      'gate.csv',
      ['repo', 'verdict', 'body_density', 'empty_body_share', 'pr_suffix_share', 'commits_sampled'],
      g.results.map((r) => [
        r.repo,
        r.verdict,
        r.substantiveShare,
        r.emptyBodyShare,
        r.prSuffixShare,
        r.sampled,
      ]),
      'can this repository be measured at all: the share of its last N commits carrying a body ' +
        'beyond the subject. pass >= 0.25, weak 0.10-0.25, fail < 0.10 (the tool refuses to draw). ' +
        'NOTE: `body_density` here comes from the gate sampler and is not identical to the ' +
        '`body_density` in repositories.csv, which comes from the record-map sampler.'
    );
  } else missing.push(opts.gateJson);

  // ── 6. THE REGRESSION FITS ───────────────────────────────────────────────────────────────
  if (existsSync(opts.regressionJson)) {
    const r = JSON.parse(readFileSync(opts.regressionJson, 'utf8')) as {
      fits: {
        outcome: string;
        outcomeWorse: string;
        predictor: string;
        predictorClaim: string;
        n: number;
        outcomeMean: number;
        predictorSd: number;
        correlation: number | null;
        underpowered: boolean;
        notEstimable?: string;
        unadjusted: { estimate: number | null; lo: number; hi: number } | null;
        adjusted: { estimate: number | null; lo: number; hi: number } | null;
      }[];
    };
    write(
      'regression-fits.csv',
      [
        'outcome',
        'outcome_worse_direction',
        'predictor',
        'predictor_claim',
        'n',
        'outcome_mean',
        'predictor_sd',
        'correlation',
        'slope_unadjusted',
        'slope_unadjusted_lo',
        'slope_unadjusted_hi',
        'slope_churn_adjusted',
        'slope_churn_adjusted_lo',
        'slope_churn_adjusted_hi',
        'underpowered',
        'not_estimable',
      ],
      r.fits.map((f) => [
        f.outcome,
        f.outcomeWorse,
        f.predictor,
        f.predictorClaim,
        f.n,
        f.outcomeMean,
        f.predictorSd,
        f.correlation,
        f.unadjusted?.estimate ?? null,
        f.unadjusted ? f.unadjusted.lo : null,
        f.unadjusted ? f.unadjusted.hi : null,
        f.adjusted?.estimate ?? null,
        f.adjusted ? f.adjusted.lo : null,
        f.adjusted ? f.adjusted.hi : null,
        f.underpowered,
        f.notEstimable ?? '',
      ]),
      'the retrospective regression: one row per outcome x predictor. Slopes are per one standard ' +
        'deviation of the predictor, in units of the outcome, with cluster-bootstrap intervals over ' +
        'regions. `slope_churn_adjusted` compares within churn decile. A blank slope with a ' +
        '`not_estimable` reason is a fit that does not exist on the sample, NOT a zero.'
    );
  } else missing.push(opts.regressionJson);

  // ── 7. PER-REGION ROWS FROM THE REGRESSION, WHEN THE RUN PERSISTED THEM ─────────────────
  //
  // The first coverage run predates row persistence, so its per-area numbers survive only in a file
  // recovered from the run's own stderr. That is carried through verbatim and labelled, rather than
  // quietly omitted: it is the only multi-repository region-level coverage measurement in existence,
  // and it was expensive.
  if (opts.areasAsOfT && existsSync(opts.areasAsOfT)) {
    const { rows } = readCsv(opts.areasAsOfT);
    write(
      'areas-as-of-cutoff.csv',
      ['repo', 'area', 'coverage', 'questions', 'commits_scored'],
      rows.map((r) => [r.repo, r.area, numOrNull(r.coverage), numOrNull(r.questions), numOrNull(r.commits_scored)]),
      'per-area coverage measured AS OF the retrospective cutoff (18 months before HEAD), scoring only ' +
        'pre-cutoff commits. This is the predictor the regression fits use. Sampled at 8 commits per ' +
        'area rather than 15, so individual areas are noisier than in `areas.csv`; the per-repository ' +
        'pooled figure is solid. Recovered from the run log — that run predates row persistence.'
    );
  } else if (opts.areasAsOfT) missing.push(opts.areasAsOfT);

  if (existsSync(opts.regressionJson)) {
    const j = JSON.parse(readFileSync(opts.regressionJson, 'utf8')) as { rows?: Record<string, unknown>[] };
    if (Array.isArray(j.rows) && j.rows.length > 0) {
      const keys = Object.keys(j.rows[0]!);
      write(
        'region-outcomes.csv',
        keys,
        j.rows.map((r) => keys.map((k) => r[k] as Cell)),
        'one row per region at the cutoff: every dimension measured before it, and every outcome ' +
          'measured after it. The row-level data behind `regression-fits.csv`, so the analysis can be ' +
          'redone with a different estimator.'
      );
    }
  }

  writeFileSync(join(opts.outDir, 'README.md'), schemaDoc(files, missing));
  return { files, missing };
}

/** Study CSVs store 0-100; everything in the pack is a share in [0,1]. */
function pct(s: string | undefined): number | null {
  const v = numOrNull(s);
  return v === null ? null : v / 100;
}

function schemaDoc(files: DataPackResult['files'], missing: string[]): string {
  const L: string[] = [];
  L.push('# Data pack');
  L.push('');
  L.push(
    'Flat CSVs of every measurement on disk, generated by `npm run riskmap -- datapack`. Regenerate ' +
      'rather than edit: these are derived files, and a hand-edit here would diverge silently from ' +
      'the results they come from.'
  );
  L.push('');
  L.push('## The three rules these files follow');
  L.push('');
  L.push(
    '1. **Missing is blank, never zero.** An unmeasured value and a value measured as nothing are ' +
      'different facts. Every numeric column is empty when unmeasured.'
  );
  L.push(
    '2. **Coverage is always a share in [0,1]**, never a percentage, in every file. The study CSVs ' +
      'store 0-100; the conversion happens here once.'
  );
  L.push(
    '3. **Scoring protocol is a column, not a footnote.** The same 1,000 pull requests were scored ' +
      'under two protocols that disagree — paired scoring puts the real record at 27.2% explicit, ' +
      'independent scoring at 32.0%. Filter on `protocol` before plotting anything. Do not pool them.'
  );
  L.push('');
  L.push('## Files');
  L.push('');
  for (const f of files) {
    L.push(`### \`${f.name}\` — ${f.rows.toLocaleString('en-US')} rows`);
    L.push('');
    L.push(f.what);
    L.push('');
  }
  if (missing.length > 0) {
    L.push('## Absent inputs');
    L.push('');
    L.push('These were not on disk when the pack was built, so the files they feed are missing or short:');
    L.push('');
    for (const m of missing) L.push(`- \`${m}\``);
    L.push('');
  }
  L.push('## What the measurement is');
  L.push('');
  L.push(
    'For each change, mechanism questions are generated **from the diff alone** by the production ' +
      'question generator. A second model then scores a written record against those questions and ' +
      'never sees the code. "Explicit" (rubric 2) means the record answers the question outright — not ' +
      'that a reader could infer it. Information separation is asserted in both directions and a ' +
      'tripped guard aborts the run rather than warning.'
  );
  L.push('');
  L.push('No individual is named in any file. Rows carry a repository, a provenance arm, and counts.');
  return `${L.join('\n')}\n`;
}
