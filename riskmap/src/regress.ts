/**
 * Step 9b — regress the outcomes on the DIMENSIONS, instead of testing the flag.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────
 *
 * `validate.ts` tests a THRESHOLD RULE: a region flags when it clears at least two of four
 * tests, one of them an ownership test. On the four-repository corpus that rule fires on FOUR
 * regions. Every interval in that report is therefore built on a treatment arm of four, and the
 * rule itself has been rewritten twice — "at least three of four" flagged nothing, and a fixed
 * churn threshold did not survive a second repository. Validating it is measuring a moving
 * target with no power, and a null from it is indistinguishable from an underpowered null.
 *
 * The DIMENSIONS underneath the rule are stable, and there are 293 regions at the cutoff. The
 * same question — does what the map measures predict what happens next — asked of the continuous
 * quantities rather than the boolean gives two orders of magnitude more information from data
 * that is already on disk. Nothing here is new measurement: `collectRepo` is the validation
 * harness's own per-repository machinery, called unchanged.
 *
 * THE LOGICAL POINT THAT MAKES THIS WORTH RUNNING. If a dimension has no continuous association
 * with an outcome, then NO THRESHOLD ON THAT DIMENSION CAN PREDICT THE OUTCOME EITHER. A
 * threshold is a coarsening of the continuous predictor: it throws information away, it cannot
 * add any. So a continuous null is strictly stronger evidence than a flag-level null, and it is
 * evidence that survives the next rewrite of the flagging rule. That is the single most valuable
 * thing this file can establish, and it is why the per-predictor verdicts are written bluntly.
 *
 * ── THE THREE DESIGN DECISIONS ─────────────────────────────────────────────────────────────
 *
 * 1. EXTANT REGIONS ONLY, FOR EVERY OUTCOME. A region whose directory no longer holds a single
 *    file at T cannot be rewritten, cannot receive a commit, and cannot acquire a contributor.
 *    Its outcomes are arithmetic about absent code, not predictions about live code. In the
 *    four-repo run 69 of 293 regions are in that state — the map's 60-month window admits a
 *    region on the strength of commits that are years old, so a directory deleted in year two is
 *    still a row in year five. Including them would let "this directory does not exist" do all
 *    the predictive work and would be reported as the dimensions predicting dormancy.
 *    Extantness at T is a function of history strictly before T, so restricting on it is
 *    ordinary covariate adjustment and not the collider mistake `validate.ts` documents.
 *
 * 2. CHURN AT T IS THE CRITICAL CONFOUND, AND IT IS ADJUSTED BY BANDING. The flag requires a
 *    region to clear a churn threshold, while an unflagged live region only has to be non-zero,
 *    so every activity-correlated outcome inherits that difference. The same asymmetry runs
 *    through the continuous predictors: concentration is mechanically higher in a quiet region
 *    (fewer commits, so one contributor is a larger share of them), and orphaned share is
 *    mechanically higher where nothing recent has overwritten the old last-touches. Adjustment
 *    is by CHURN DECILE BAND, comparing within band and pooling across bands — the fixed-effects
 *    estimator. A threshold split at the median throws away nine tenths of the ordering, and a
 *    fitted linear term in churn assumes a functional form that churn, which is right-skewed
 *    over three orders of magnitude, does not have. Every within-band estimate is printed
 *    alongside the pooled one so a reader can see whether the sign is stable or whether the
 *    pooled number is one band shouting.
 *
 * 3. MISSING IS MISSING. `recordCoverage` is null unless the run scored it with a model, which
 *    this one does not, and it is reported as a reduced n rather than imputed. Substituting a
 *    mean would give it zero variance, a coefficient of exactly nothing, and a table row that
 *    reads identically to a tested null. The two are not the same claim.
 *
 * ── WHAT THIS STILL CANNOT DO ──────────────────────────────────────────────────────────────
 *
 * Regions are not randomly assigned their dimension values, so every number here is an
 * association. Banding on churn removes one confound and names it; it does not remove the ones
 * nobody has named. Regions within a repository share authors, a release cycle and a build
 * system, which the cluster bootstrap handles for variance and cannot handle for confounding.
 * And the outcomes are still git-derived, so a team that never writes "revert" still looks
 * healthy by construction on the two lexical ones.
 */

import { collectRepo, type RegionRecord } from './validate.js';
import { bootstrapStatistic, mean, olsSlope, pearson, sd, type Interval } from './stats.js';

/** Fewer than this many regions and the row is labelled underpowered rather than read. */
const UNDERPOWERED_BELOW = 20;

/** Churn bands. Ten is the spec's decile; it is a constant so the report can print it. */
const CHURN_BANDS = 10;

/** Which way the map claims a predictor points. `none` means the map makes no claim. */
export type Claim = 'higher-is-worse' | 'lower-is-worse' | 'none';

export interface PredictorSpec {
  key: string;
  label: string;
  claim: Claim;
  /** Null means not measured for this region. Never substituted. */
  value: (r: RegionRecord) => number | null;
  note?: string;
}

export interface OutcomeSpec {
  key: string;
  label: string;
  /** Stated before any estimate is printed, so the sign check cannot be written after the fact. */
  worse: 'higher' | 'lower';
  value: (r: RegionRecord) => number | null;
  note?: string;
}

/**
 * THE PREDICTORS. Every one of these is a function of history strictly before T.
 *
 * `extant` is in the list because the brief asks for it, and it carries `claim: 'none'`: the map
 * does not say an existing directory is worse than a deleted one, it says a deleted one cannot be
 * at risk. It is a gate, not a risk dimension, and printing a sign check against a claim that was
 * never made would be inventing one. It is also constant inside the analysis sample by
 * construction, so it is estimated on the unrestricted sample and labelled.
 */
export const PREDICTORS: PredictorSpec[] = [
  {
    key: 'orphanedShare',
    label: 'orphaned share (last-touch file share, inactive contributors)',
    claim: 'higher-is-worse',
    value: (r) => r.orphanedShare,
  },
  {
    key: 'concentration',
    label: 'concentration (share from the single largest contributor)',
    claim: 'higher-is-worse',
    value: (r) => r.concentration,
  },
  {
    key: 'recordCoverage',
    label: 'record coverage (share of mechanism questions the commits answer)',
    claim: 'lower-is-worse',
    value: (r) => r.recordCoverage,
    note: 'Needs a model to score. Null on any run without --coverage; never imputed.',
  },
  {
    key: 'commitsPerMonth',
    label: 'churn at T (commits per month)',
    claim: 'higher-is-worse',
    value: (r) => r.commitsPerMonthAtT,
    note:
      'Also the adjustment variable. Its churn-adjusted row is uninformative BY CONSTRUCTION — ' +
      'banding on churn deciles removes almost all of its own variation — and is printed only so ' +
      'the table is not silently missing a cell.',
  },
  {
    key: 'contributors',
    label: 'contributors at T (distinct identities in the window)',
    claim: 'lower-is-worse',
    value: (r) => r.contributorsAtT,
  },
  {
    key: 'extant',
    label: 'extant at T (the directory still held a non-excluded file)',
    claim: 'none',
    value: (r) => (r.extantAtT === null ? null : r.extantAtT ? 1 : 0),
    note:
      'A gate rather than a risk dimension, and constant inside the analysis sample. Estimated ' +
      'on the unrestricted sample and reported separately.',
  },
];

/** THE OUTCOMES, each with the direction of "worse" fixed before anything is estimated. */
export const OUTCOMES: OutcomeSpec[] = [
  {
    key: 'dormant',
    label: 'dormancy — zero commits in the follow-up window',
    worse: 'higher',
    value: (r) => (r.dormant ? 1 : 0),
  },
  {
    key: 'rewritten',
    label: 'wholesale rewrite — region classified rewritten',
    worse: 'higher',
    value: (r) => (r.rewritten === null ? null : r.rewritten ? 1 : 0),
  },
  {
    key: 'turnover',
    label: 'turnover — files at T deleted or moved out of the region',
    worse: 'higher',
    value: (r) => r.turnover,
  },
  {
    key: 'replacement',
    label: 'replacement — post-T deleted lines / lines at T',
    worse: 'higher',
    value: (r) => r.replacement,
  },
  {
    key: 'contributorsPostT',
    label: 'distinct contributors post-T',
    worse: 'lower',
    value: (r) => r.contributorsPostT,
  },
  {
    key: 'fixRate',
    label: 'fix / revert rate over post-T commits',
    worse: 'higher',
    value: (r) => r.fixRate,
    note: 'A rate over post-T commits, so undefined for a dormant region. Not zero — undefined.',
  },
  {
    key: 'reworkRate',
    label: 'rework rate — post-T commits re-touching a file touched within 30 days',
    worse: 'higher',
    value: (r) => r.reworkRate,
    note: 'Same denominator problem as the fix rate; dormant regions are dropped, not zeroed.',
  },
];

/** One region reduced to the three numbers a fit needs. The unit of resampling. */
interface Row {
  x: number;
  y: number;
  band: number;
}

export interface BandEstimate {
  band: number;
  n: number;
  churnLo: number;
  churnHi: number;
  /** Per-SD slope inside this band alone. Null when the predictor does not vary in it. */
  estimate: number | null;
}

export interface Fit {
  outcome: string;
  outcomeWorse: 'higher' | 'lower';
  predictor: string;
  predictorClaim: Claim;
  /** Regions contributing to this fit: both predictor and outcome present. */
  n: number;
  /** Of the analysis sample, how many were lost to a missing predictor and to a missing outcome. */
  droppedMissingPredictor: number;
  droppedMissingOutcome: number;
  outcomeMean: number;
  predictorSd: number;
  /** Pearson correlation, unadjusted. NaN when either series is constant. */
  correlation: number;
  /** Change in the outcome per 1 SD of the predictor, unadjusted. */
  unadjusted: Interval;
  /** The same, estimated within churn decile bands and pooled. */
  adjusted: Interval;
  bands: BandEstimate[];
  /** +1 or −1 when the map predicts a direction, 0 when it makes no claim. */
  predictedSign: number;
  underpowered: boolean;
  /** Set when the fit could not be run at all; every estimate is then NaN. */
  notEstimable: string | null;
}

export interface CorrelationMatrix {
  sample: string;
  n: number;
  keys: string[];
  /** Pairwise-complete Pearson. NaN where a series is constant or empty. */
  values: (number | null)[][];
  /** Pairwise n, since missingness differs by predictor. */
  counts: number[][];
}

export interface RegressionResult {
  repos: string[];
  monthsBack: number;
  followMonths: number;
  asOf: Record<string, string>;
  sample: {
    byRepo: { repo: string; asOf: string; regions: number; flagged: number; extant: number }[];
    regionsAtT: number;
    flaggedAtT: number;
    structuralUnknown: number;
    notExtantAtT: number;
    analysis: number;
    analysisFlagged: number;
  };
  churnBands: { band: number; n: number; lo: number; hi: number; repos: Record<string, number> }[];
  correlations: CorrelationMatrix[];
  fits: Fit[];
  /** `extant` estimated on the unrestricted sample, where it is not constant. */
  extantFits: Fit[];
  predictorCoverage: { predictor: string; present: number; missing: number }[];
  notes: string[];
  structuralGaps: string[];
}

export interface RegressionOpts {
  repos: string[];
  monthsBack: number;
  followMonths: number;
  onProgress?: (msg: string) => void;
}

// ── ESTIMATORS ────────────────────────────────────────────────────────────────────────────────

/**
 * Pooled within-band slope — algebraically identical to OLS of y on x with a full set of band
 * dummies, computed directly so there is no matrix inversion to get wrong.
 *
 * Each band contributes its own centred cross-product and sum of squares; the pooled slope is the
 * ratio of the sums. Bands with fewer than two rows contribute nothing, which is correct: a band
 * of one has no within-band variation to speak from. Returns null when no band has any variation
 * in the predictor, because the estimand does not exist on that sample.
 */
export function withinBandSlope(rows: Row[]): number | null {
  const byBand = new Map<number, Row[]>();
  for (const r of rows) {
    let g = byBand.get(r.band);
    if (!g) {
      g = [];
      byBand.set(r.band, g);
    }
    g.push(r);
  }
  let sxy = 0;
  let sxx = 0;
  for (const g of byBand.values()) {
    if (g.length < 2) continue;
    const mx = mean(g.map((r) => r.x));
    const my = mean(g.map((r) => r.y));
    for (const r of g) {
      sxy += (r.x - mx) * (r.y - my);
      sxx += (r.x - mx) ** 2;
    }
  }
  if (sxx === 0) return null;
  return sxy / sxx;
}

/**
 * The reported estimate: the change in the outcome per ONE STANDARD DEVIATION of the predictor.
 *
 * Raw slopes are not comparable across these predictors — orphaned share spans [0,1] and churn
 * spans three orders of magnitude, so a raw coefficient on churn is small for a reason that has
 * nothing to do with whether churn predicts anything. Scaling by the predictor's own SD puts
 * every row in the same unit: "one typical step along this dimension moves the outcome by this
 * much". Both the unadjusted and the adjusted estimate use the SAME scale factor — the SD over
 * the whole analysis sample, not the within-band residual SD — so the two columns are directly
 * comparable and the difference between them is adjustment, not rescaling.
 */
function unadjustedPerSd(rows: Row[]): number | null {
  const xs = rows.map((r) => r.x);
  const b = olsSlope(xs, rows.map((r) => r.y));
  if (b === null) return null;
  return b * sd(xs);
}

function adjustedPerSd(rows: Row[]): number | null {
  const b = withinBandSlope(rows);
  if (b === null) return null;
  return b * sd(rows.map((r) => r.x));
}

const NOT_ESTIMABLE: Interval = { estimate: Number.NaN, lo: Number.NaN, hi: Number.NaN, n: 0, discarded: 0 };

/**
 * Churn decile bands over a sample of regions.
 *
 * Cut by RANK, then repaired so that regions with an identical churn value never land in
 * different bands: a boundary that splits a tie would make two identical regions comparable to
 * each other only through the band structure, which is exactly the comparison the banding exists
 * to forbid. Ties matter here — a quiet region's commits-per-month is a small rational number and
 * repeats.
 */
export function churnBandsOf(values: number[], bands = CHURN_BANDS): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(0);
  if (n === 0) return out;
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const bandOf = new Map<number, number>();
  for (let rank = 0; rank < n; rank++) {
    const { v, i } = order[rank]!;
    const raw = Math.min(bands - 1, Math.floor((rank * bands) / n));
    // First rank at which this value appears owns the band for every tied region.
    const settled = bandOf.get(v);
    if (settled === undefined) bandOf.set(v, raw);
    out[i] = bandOf.get(v)!;
  }
  return out;
}

function fit(
  records: RegionRecord[],
  bandsFor: Map<RegionRecord, number>,
  outcome: OutcomeSpec,
  predictor: PredictorSpec
): Fit {
  const claimSign = predictor.claim === 'higher-is-worse' ? 1 : predictor.claim === 'lower-is-worse' ? -1 : 0;
  const outcomeSign = outcome.worse === 'higher' ? 1 : -1;
  const predictedSign = claimSign * outcomeSign;

  // The two missingness counts are computed INDEPENDENTLY over the whole sample rather than
  // sequentially, so "dropped for a missing outcome" means what it says instead of meaning
  // "dropped for a missing outcome, among those that had a predictor". A reader reconciling the
  // numbers against the sample table should not have to guess the order the filters ran in.
  const ok = (v: number | null): v is number => v !== null && Number.isFinite(v);
  const droppedMissingPredictor = records.filter((r) => !ok(predictor.value(r))).length;
  const droppedMissingOutcome = records.filter((r) => !ok(outcome.value(r))).length;
  const rows: Row[] = [];
  for (const r of records) {
    const x = predictor.value(r);
    const y = outcome.value(r);
    if (!ok(x) || !ok(y)) continue;
    rows.push({ x, y, band: bandsFor.get(r) ?? 0 });
  }

  const base: Omit<Fit, 'notEstimable' | 'unadjusted' | 'adjusted' | 'bands' | 'correlation'> = {
    outcome: outcome.key,
    outcomeWorse: outcome.worse,
    predictor: predictor.key,
    predictorClaim: predictor.claim,
    n: rows.length,
    droppedMissingPredictor,
    droppedMissingOutcome,
    outcomeMean: mean(rows.map((r) => r.y)),
    predictorSd: sd(rows.map((r) => r.x)),
    predictedSign,
    underpowered: rows.length < UNDERPOWERED_BELOW,
  };

  if (rows.length === 0) {
    return {
      ...base,
      correlation: Number.NaN,
      unadjusted: NOT_ESTIMABLE,
      adjusted: NOT_ESTIMABLE,
      bands: [],
      notEstimable: 'no region carries both the predictor and the outcome',
    };
  }
  if (base.predictorSd === 0) {
    return {
      ...base,
      correlation: Number.NaN,
      unadjusted: NOT_ESTIMABLE,
      adjusted: NOT_ESTIMABLE,
      bands: [],
      notEstimable: 'the predictor is constant on this sample, so there is no slope to estimate',
    };
  }

  // Band detail: the slope inside each band on its own, on the same per-SD scale as the pooled
  // estimate so the numbers can be read down the column.
  const scale = base.predictorSd;
  const byBand = new Map<number, Row[]>();
  for (const r of rows) {
    let g = byBand.get(r.band);
    if (!g) {
      g = [];
      byBand.set(r.band, g);
    }
    g.push(r);
  }
  const bands: BandEstimate[] = [...byBand.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([band, g]) => {
      const xs = g.map((r) => r.x);
      const b = g.length >= 2 ? olsSlope(xs, g.map((r) => r.y)) : null;
      // The band's churn range is filled in by the caller, which is the only place that holds
      // the band summary. Zero here is a placeholder, never a measurement.
      return { band, n: g.length, churnLo: 0, churnHi: 0, estimate: b === null ? null : b * scale };
    });

  return {
    ...base,
    correlation: pearson(rows.map((r) => r.x), rows.map((r) => r.y)),
    unadjusted: bootstrapStatistic(rows, unadjustedPerSd),
    adjusted: bootstrapStatistic(rows, adjustedPerSd),
    bands,
    notEstimable: null,
  };
}

// ── THE RUN ──────────────────────────────────────────────────────────────────────────────────

export async function runRegression(opts: RegressionOpts): Promise<RegressionResult> {
  const log = opts.onProgress ?? (() => {});
  const all: RegionRecord[] = [];
  const asOf: Record<string, string> = {};
  const notes: string[] = [];
  const structuralGaps: string[] = [];
  const byRepo: RegressionResult['sample']['byRepo'] = [];

  for (const repo of opts.repos) {
    const c = await collectRepo(repo, {
      monthsBack: opts.monthsBack,
      followMonths: opts.followMonths,
      // The committer-lag probe feeds the validation report's time-to-merge verdict and nothing
      // here, so it is not paid for.
      probeLag: false,
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    });
    structuralGaps.push(...c.structuralGaps);
    if (c.skipped !== null) {
      notes.push(c.skipped);
      continue;
    }
    asOf[c.name] = c.asOf;
    all.push(...c.records);
    byRepo.push({
      repo: c.name,
      asOf: c.asOf,
      regions: c.records.length,
      flagged: c.records.filter((r) => r.flagged).length,
      extant: c.records.filter((r) => r.extantAtT === true).length,
    });
    log(
      `${c.name}: ${c.records.length} regions at T, ` +
        `${c.records.filter((r) => r.extantAtT === true).length} still extant`
    );
  }

  // ── THE RESTRICTION LADDER ────────────────────────────────────────────────────────────────
  const structuralUnknown = all.filter((r) => r.extantAtT === null).length;
  const analysis = all.filter((r) => r.extantAtT === true);
  const notExtantAtT = all.filter((r) => r.extantAtT === false).length;

  // Churn bands are cut ONCE, on the analysis sample, and reused for every outcome. Cutting them
  // per fit would give each outcome a different adjustment and make the rows incomparable.
  const bandIndex = churnBandsOf(analysis.map((r) => r.commitsPerMonthAtT));
  const bandsFor = new Map<RegionRecord, number>();
  analysis.forEach((r, i) => bandsFor.set(r, bandIndex[i]!));

  const bandSummary: RegressionResult['churnBands'] = [];
  for (let b = 0; b < CHURN_BANDS; b++) {
    const g = analysis.filter((_, i) => bandIndex[i] === b);
    if (g.length === 0) continue;
    const churns = g.map((r) => r.commitsPerMonthAtT).sort((x, y) => x - y);
    const repos: Record<string, number> = {};
    for (const r of g) repos[r.repo] = (repos[r.repo] ?? 0) + 1;
    bandSummary.push({ band: b, n: g.length, lo: churns[0]!, hi: churns[churns.length - 1]!, repos });
  }

  const fits: Fit[] = [];
  for (const o of OUTCOMES) {
    for (const p of PREDICTORS) {
      if (p.key === 'extant') continue; // constant on the analysis sample; handled below.
      const f = fit(analysis, bandsFor, o, p);
      // Attach the band churn range now that the bands are known.
      for (const be of f.bands) {
        const s = bandSummary.find((x) => x.band === be.band);
        be.churnLo = s?.lo ?? 0;
        be.churnHi = s?.hi ?? 0;
      }
      fits.push(f);
    }
  }

  // `extant` on the UNRESTRICTED sample, where it varies. Regions whose extantness could not be
  // determined at all are excluded from this one rather than counted either way.
  const unrestricted = all.filter((r) => r.extantAtT !== null);
  const unrestrictedBandIndex = churnBandsOf(unrestricted.map((r) => r.commitsPerMonthAtT));
  const unrestrictedBands = new Map<RegionRecord, number>();
  unrestricted.forEach((r, i) => unrestrictedBands.set(r, unrestrictedBandIndex[i]!));
  const extantSpec = PREDICTORS.find((p) => p.key === 'extant')!;
  const extantFits = OUTCOMES.map((o) => fit(unrestricted, unrestrictedBands, o, extantSpec));

  // ── HOW ENTANGLED THE PREDICTORS ARE ──────────────────────────────────────────────────────
  const corrKeys = PREDICTORS.map((p) => p.key);
  const matrixOver = (sample: RegionRecord[], label: string): CorrelationMatrix => {
    const values: (number | null)[][] = [];
    const counts: number[][] = [];
    for (const a of PREDICTORS) {
      const row: (number | null)[] = [];
      const cnt: number[] = [];
      for (const b of PREDICTORS) {
        const xs: number[] = [];
        const ys: number[] = [];
        for (const r of sample) {
          const x = a.value(r);
          const y = b.value(r);
          if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
          xs.push(x);
          ys.push(y);
        }
        const c = pearson(xs, ys);
        row.push(Number.isFinite(c) ? c : null);
        cnt.push(xs.length);
      }
      values.push(row);
      counts.push(cnt);
    }
    return { sample: label, n: sample.length, keys: corrKeys, values, counts };
  };

  const correlations = [
    matrixOver(analysis, 'analysis sample — regions extant at T'),
    matrixOver(unrestricted, 'unrestricted — every region at T with a known extantness'),
  ];

  const predictorCoverage = PREDICTORS.map((p) => {
    const present = analysis.filter((r) => {
      const v = p.value(r);
      return v !== null && Number.isFinite(v);
    }).length;
    return { predictor: p.key, present, missing: analysis.length - present };
  });

  const noCoverage = predictorCoverage.find((c) => c.predictor === 'recordCoverage');
  if (noCoverage && noCoverage.present === 0) {
    notes.push(
      'RECORD COVERAGE WAS NOT SCORED ON THIS RUN, so it has no rows and no coefficient. It is ' +
        'reported as n=0 rather than imputed: a mean-filled predictor would have zero variance, ' +
        'a coefficient of exactly nothing, and a table row indistinguishable from a tested null. ' +
        'Scoring it needs a model key and a --coverage run of the map as of T, which the ' +
        'validation builder does not do.'
    );
  }
  if (structuralUnknown > 0) {
    notes.push(
      `${structuralUnknown} regions had no determinable extantness at T — the tree comparison ` +
        'failed for their repository — and are excluded from every fit rather than assumed extant.'
    );
  }

  return {
    repos: opts.repos,
    monthsBack: opts.monthsBack,
    followMonths: opts.followMonths,
    asOf,
    sample: {
      byRepo,
      regionsAtT: all.length,
      flaggedAtT: all.filter((r) => r.flagged).length,
      structuralUnknown,
      notExtantAtT,
      analysis: analysis.length,
      analysisFlagged: analysis.filter((r) => r.flagged).length,
    },
    churnBands: bandSummary,
    correlations,
    fits,
    extantFits,
    predictorCoverage,
    notes,
    structuralGaps,
  };
}

// ── THE REPORT ───────────────────────────────────────────────────────────────────────────────

const f3 = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(3);
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '—');

function ci(iv: Interval): string {
  if (!Number.isFinite(iv.lo) || !Number.isFinite(iv.hi)) return '—';
  return `[${iv.lo.toFixed(3)}, ${iv.hi.toFixed(3)}]`;
}

const excludesZero = (iv: Interval) =>
  Number.isFinite(iv.lo) && Number.isFinite(iv.hi) && (iv.lo > 0 || iv.hi < 0);

/**
 * THE SIGN CHECK, written once and applied everywhere.
 *
 * The direction of "worse" is fixed on the outcome spec before any estimate exists, and the
 * direction the map claims is fixed on the predictor spec. `predictedSign` is their product. This
 * function is the only place a result is described in words, and it CANNOT describe a
 * wrong-direction interval as support: the branch that says "as the map predicts" is reachable
 * only when the observed sign equals the predicted one.
 */
function verdict(f: Fit, iv: Interval): string {
  if (f.notEstimable) return `not estimable — ${f.notEstimable}`;
  if (!Number.isFinite(iv.estimate)) return 'not estimable';
  const observed = iv.estimate > 0 ? 1 : iv.estimate < 0 ? -1 : 0;
  const sig = excludesZero(iv);
  const power = f.underpowered ? `UNDERPOWERED (n=${f.n}) — ` : '';
  if (f.predictedSign === 0) {
    return `${power}${sig ? 'CI excludes zero' : 'CI crosses zero'}; the map makes no directional claim here`;
  }
  if (!sig) {
    const lean = observed === f.predictedSign ? 'the predicted direction' : 'the WRONG direction';
    return `${power}NO ASSOCIATION — CI crosses zero (point estimate leans ${lean})`;
  }
  if (observed === f.predictedSign) return `${power}AS PREDICTED — CI excludes zero in the claimed direction`;
  return `${power}WRONG DIRECTION — CI excludes zero, OPPOSITE to the map's claim`;
}

function outcomeSection(r: RegressionResult, o: OutcomeSpec, L: string[]): void {
  const fits = r.fits.filter((f) => f.outcome === o.key);
  if (fits.length === 0) return;
  L.push(`### ${o.label}`);
  L.push('');
  const worse = o.worse === 'higher' ? 'HIGHER is worse' : 'LOWER is worse';
  L.push(`**Direction of harm, fixed before estimation: ${worse}.**`);
  if (o.note) L.push(`_${o.note}_`);
  const anyN = fits.find((f) => f.n > 0);
  if (anyN) {
    L.push('');
    L.push(
      `Mean of the outcome on the estimation sample: **${f3(anyN.outcomeMean)}** ` +
        `(n=${anyN.n}${anyN.droppedMissingOutcome ? `, ${anyN.droppedMissingOutcome} regions dropped for a missing outcome` : ''}).`
    );
  }
  L.push('');
  L.push(
    'Estimates are the change in the outcome per **1 SD of the predictor** — for a 0/1 outcome ' +
      'that is a change in probability, from a linear probability model, which is fitted here ' +
      'because it needs no link function, no iterative solver and no dependency, and because at ' +
      'these rates the linear and logistic answers agree on sign and on whether the interval ' +
      'covers zero, which is all that is being read off. 95% cluster-bootstrap CI over regions.'
  );
  L.push('');
  L.push('| predictor | n | map claims | unadjusted | 95% CI | churn-adjusted | 95% CI | verdict (adjusted) |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const f of fits) {
    const spec = PREDICTORS.find((p) => p.key === f.predictor)!;
    const claims =
      f.predictedSign === 0 ? 'no claim' : f.predictedSign > 0 ? 'slope > 0' : 'slope < 0';
    if (f.notEstimable) {
      L.push(`| ${spec.key} | ${f.n} | ${claims} | — | — | — | — | not estimable — ${f.notEstimable} |`);
      continue;
    }
    L.push(
      `| ${spec.key} | ${f.n} | ${claims} | ${f3(f.unadjusted.estimate)} | ${ci(f.unadjusted)} | ` +
        `${f3(f.adjusted.estimate)} | ${ci(f.adjusted)} | ${verdict(f, f.adjusted)} |`
    );
  }
  L.push('');

  // Within-band detail. The pooled number is only worth reading if the bands agree.
  const usable = fits.filter((f) => !f.notEstimable && f.bands.length > 0);
  if (usable.length) {
    // The band SET can differ between fits — an outcome that is undefined for some regions can
    // empty a band entirely — so the columns are the union and every cell is a lookup. Indexing
    // one fit's bands by another's position would print numbers under the wrong decile, which is
    // the kind of error a reader cannot catch.
    const cols = [...new Set(usable.flatMap((f) => f.bands.map((b) => b.band)))].sort((a, b) => a - b);
    L.push('<details><summary>Within-band estimates (churn deciles) — is the sign stable?</summary>');
    L.push('');
    L.push('Cell: the per-SD estimate inside that band alone, with the band\'s n. — means the band held fewer than two regions or no variation in the predictor.');
    L.push('');
    L.push('| predictor | ' + cols.map((c) => `d${c + 1}`).join(' | ') + ' | bands with the predicted sign |');
    L.push('| --- |' + cols.map(() => ' --- |').join('') + ' --- |');
    for (const f of usable) {
      const byBand = new Map(f.bands.map((b) => [b.band, b]));
      const cells = cols.map((c) => {
        const b = byBand.get(c);
        if (!b) return '—';
        return b.estimate === null ? `— (n=${b.n})` : `${b.estimate.toFixed(3)} (n=${b.n})`;
      });
      const withSign = f.bands.filter((b) => b.estimate !== null && Math.sign(b.estimate) === f.predictedSign).length;
      const withEst = f.bands.filter((b) => b.estimate !== null).length;
      const agree = f.predictedSign === 0 ? 'n/a — no claim' : `${withSign} of ${withEst}`;
      L.push(`| ${f.predictor} | ${cells.join(' | ')} | ${agree} |`);
    }
    L.push('');
    L.push('</details>');
    L.push('');
  }
}

export function formatRegressionReport(r: RegressionResult): string {
  const L: string[] = [];
  const s = r.sample;

  L.push('# Regressing the outcomes on the dimensions');
  L.push('');
  L.push(
    'The retrospective test in `validation.md` compares regions the map FLAGGED against regions ' +
      `it did not. On this corpus that flag fires on **${s.flaggedAtT} of ${s.regionsAtT}** regions, ` +
      'so every interval in it rests on a treatment arm of ' +
      `${s.flaggedAtT}. The flagging rule has also been rewritten twice, which makes it a moving ` +
      'target rather than a fixed hypothesis.'
  );
  L.push('');
  L.push(
    'This document does not test the flag. It regresses the same outcomes on the **dimensions** as ' +
      'continuous predictors, over every region in the map at T. Same question, same data already ' +
      'on disk, two orders of magnitude more of it.'
  );
  L.push('');
  L.push(
    '**The logical point that makes it worth doing.** A threshold is a coarsening of a continuous ' +
      'predictor: it discards information and cannot add any. So if a dimension has no continuous ' +
      'association with an outcome, **no threshold on that dimension can predict that outcome ' +
      'either** — including thresholds nobody has written yet. A continuous null is therefore ' +
      'stronger than a flag-level null and survives the next rewrite of the rule.'
  );
  L.push('');
  L.push(
    `Built as of ${r.monthsBack} months before each repository's HEAD, using only commits before ` +
      `that date; outcomes measured over the following ${r.followMonths} months.`
  );
  L.push('');
  L.push(`Repositories: ${Object.entries(r.asOf).map(([k, v]) => `${k} (T=${v})`).join(', ')}`);
  L.push('');

  // ── SAMPLE ──────────────────────────────────────────────────────────────────────────────
  L.push('## 1. Sample sizes, and what was dropped at each step');
  L.push('');
  L.push('| repository | T | regions at T | flagged | still extant at T |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const b of s.byRepo) L.push(`| ${b.repo} | ${b.asOf} | ${b.regions} | ${b.flagged} | ${b.extant} |`);
  L.push(`| **all** | | **${s.regionsAtT}** | **${s.flaggedAtT}** | **${s.analysis}** |`);
  L.push('');
  L.push('| step | regions | dropped here |');
  L.push('| --- | --- | --- |');
  L.push(`| every region in the map at T | ${s.regionsAtT} | — |`);
  L.push(
    `| extantness at T determinable | ${s.regionsAtT - s.structuralUnknown} | ${s.structuralUnknown} |`
  );
  L.push(`| **extant at T — the analysis sample** | **${s.analysis}** | ${s.notExtantAtT} |`);
  L.push('');
  L.push(
    `**Why the extant restriction, stated before the results.** ${s.notExtantAtT} of the ` +
      `${s.regionsAtT} regions had no non-excluded file left in their directory at T. A deleted ` +
      'directory cannot be rewritten, cannot receive a commit and cannot acquire a contributor: ' +
      'every outcome on it is arithmetic about absent code. Leaving them in would let "this ' +
      'directory does not exist" do the predictive work and would be reported as the dimensions ' +
      'predicting dormancy. Extantness at T is a function of history strictly before T, measured ' +
      'at the same instant the dimensions are, so restricting on it is covariate adjustment and ' +
      'not the collider `validate.ts` documents.'
  );
  L.push('');
  L.push(
    `Of the analysis sample, ${s.analysisFlagged} region${s.analysisFlagged === 1 ? ' is' : 's are'} ` +
      'flagged by the current rule. The flag is not used below except in that count.'
  );
  L.push('');
  L.push('Per-predictor availability on the analysis sample — no value is ever imputed:');
  L.push('');
  L.push('| predictor | regions with a value | missing |');
  L.push('| --- | --- | --- |');
  for (const c of r.predictorCoverage) L.push(`| ${c.predictor} | ${c.present} | ${c.missing} |`);
  L.push('');
  for (const p of PREDICTORS) if (p.note) L.push(`- \`${p.key}\` — ${p.note}`);
  L.push('');
  L.push(
    `Any row below built from fewer than ${UNDERPOWERED_BELOW} regions is labelled ` +
      '**UNDERPOWERED** in place of being read.'
  );
  L.push('');

  // ── CHURN BANDS ─────────────────────────────────────────────────────────────────────────
  L.push('## 2. The confound, and how it is adjusted for');
  L.push('');
  L.push(
    '**Churn at T is the critical confound.** The flag requires a region to clear a churn ' +
      'threshold while an unflagged live region only has to be non-zero, so every ' +
      'activity-correlated outcome inherits that difference. The same asymmetry runs through the ' +
      'continuous predictors: concentration is mechanically higher in a quiet region, because one ' +
      'contributor is a larger share of fewer commits, and orphaned share is mechanically higher ' +
      'where nothing recent has overwritten the old last-touches.'
  );
  L.push('');
  L.push(
    'Adjustment is by **churn decile band**: the association is estimated inside each band and ' +
      'pooled across bands, which is the fixed-effects estimator. A median split would throw away ' +
      'nine tenths of the ordering, and a fitted linear term in churn would assume a functional ' +
      'form that a right-skewed quantity spanning three orders of magnitude does not have. Every ' +
      'within-band estimate is printed with its pooled estimate so a reader can see whether the ' +
      'sign is stable or whether one band is doing all the talking.'
  );
  L.push('');
  L.push('| band | n | churn at T (commits/month) | repositories |');
  L.push('| --- | --- | --- | --- |');
  for (const b of r.churnBands) {
    const repos = Object.entries(b.repos)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    L.push(`| d${b.band + 1} | ${b.n} | ${f2(b.lo)} – ${f2(b.hi)} | ${repos} |`);
  }
  L.push('');
  L.push(
    'Bands are cut on POOLED churn across repositories, so they partly absorb repository ' +
      'differences as well — a low band is disproportionately one repository. That is stated ' +
      'rather than hidden: it makes the adjustment stronger than a within-repository one and it ' +
      'means the adjusted estimates lean on comparisons between regions of similar absolute ' +
      'activity, wherever they live.'
  );
  L.push('');

  // ── CORRELATIONS ────────────────────────────────────────────────────────────────────────
  L.push('## 3. How entangled the predictors are');
  L.push('');
  for (const m of r.correlations) {
    L.push(`**${m.sample}** (n=${m.n}). Pairwise-complete Pearson; — means one series is constant or empty.`);
    L.push('');
    L.push('| | ' + m.keys.join(' | ') + ' |');
    L.push('| --- |' + m.keys.map(() => ' --- |').join(''));
    m.values.forEach((row, i) => {
      L.push(`| **${m.keys[i]}** | ` + row.map((v) => f3(v)).join(' | ') + ' |');
    });
    L.push('');
  }

  // ── RESULTS ─────────────────────────────────────────────────────────────────────────────
  L.push('## 4. Results, one section per outcome');
  L.push('');
  L.push(
    'Every section states which direction is worse **before** the numbers. A wrong-direction ' +
      'result is never described as confirming anything: the verdict text is generated from the ' +
      "product of the outcome's harm direction and the predictor's claimed direction, and the " +
      '"as predicted" branch is unreachable when the observed sign disagrees.'
  );
  L.push('');
  for (const o of OUTCOMES) outcomeSection(r, o, L);

  // ── EXTANT ──────────────────────────────────────────────────────────────────────────────
  L.push('## 5. `extant` at T, on the unrestricted sample');
  L.push('');
  L.push(
    'Extantness is constant inside the analysis sample by construction, so it cannot be estimated ' +
      'there. It is reported here over every region at T with a determinable extantness ' +
      `(n=${s.regionsAtT - s.structuralUnknown}), and it carries **no directional claim**: the map ` +
      'does not say an existing directory is worse than a deleted one, it says a deleted one ' +
      'cannot be at risk. It is a gate, not a risk dimension.'
  );
  L.push('');
  L.push('| outcome | n | unadjusted | 95% CI | churn-adjusted | 95% CI |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const f of r.extantFits) {
    const o = OUTCOMES.find((x) => x.key === f.outcome)!;
    if (f.notEstimable) {
      L.push(`| ${o.key} | ${f.n} | — | — | — | — |`);
      continue;
    }
    L.push(
      `| ${o.key} | ${f.n} | ${f3(f.unadjusted.estimate)} | ${ci(f.unadjusted)} | ` +
        `${f3(f.adjusted.estimate)} | ${ci(f.adjusted)} |`
    );
  }
  L.push('');

  // ── VERDICTS ────────────────────────────────────────────────────────────────────────────
  L.push('## 6. The blunt verdict, one line per dimension');
  L.push('');
  for (const p of PREDICTORS) {
    if (p.key === 'extant') continue;
    const fs = r.fits.filter((f) => f.predictor === p.key);
    const estimable = fs.filter((f) => !f.notEstimable);
    L.push(`### \`${p.key}\``);
    L.push('');
    if (estimable.length === 0) {
      L.push(
        `**Not tested.** No region carries a value for this predictor on this run ` +
          `(${r.predictorCoverage.find((c) => c.predictor === p.key)?.missing ?? 0} missing of ` +
          `${s.analysis}). Nothing about it — positive or negative — follows from this document.`
      );
      L.push('');
      continue;
    }
    const hits = estimable.filter((f) => excludesZero(f.adjusted) && Math.sign(f.adjusted.estimate) === f.predictedSign);
    const wrong = estimable.filter((f) => excludesZero(f.adjusted) && Math.sign(f.adjusted.estimate) !== f.predictedSign);
    const powered = estimable.filter((f) => !f.underpowered);
    const label = (f: Fit) => OUTCOMES.find((x) => x.key === f.outcome)!.key;
    if (hits.length === 0 && wrong.length === 0) {
      L.push(
        `**No continuous association with any outcome.** Churn-adjusted, all ${estimable.length} ` +
          `intervals cross zero (${powered.length} of them from ${UNDERPOWERED_BELOW}+ regions). ` +
          'Because a threshold only coarsens a continuous predictor, this means **no cut point on ' +
          `\`${p.key}\` can predict any of these outcomes either.** That is a stronger statement ` +
          'than the flag-level null and it does not depend on where the current rule puts its line.'
      );
    } else {
      if (hits.length) {
        L.push(
          `**Predicts, in the claimed direction:** ${hits.map((f) => `${label(f)} (${f3(f.adjusted.estimate)} per SD, ${ci(f.adjusted)}${f.underpowered ? ', UNDERPOWERED' : ''})`).join('; ')}.`
        );
      }
      if (wrong.length) {
        L.push(
          `**Predicts in the WRONG direction — evidence against the claim, not for it:** ` +
            `${wrong.map((f) => `${label(f)} (${f3(f.adjusted.estimate)} per SD, ${ci(f.adjusted)}${f.underpowered ? ', UNDERPOWERED' : ''})`).join('; ')}.`
        );
      }
      const nulls = estimable.filter(
        (f) => Number.isFinite(f.adjusted.estimate) && !excludesZero(f.adjusted)
      );
      const unavailable = estimable.filter((f) => !Number.isFinite(f.adjusted.estimate));
      if (nulls.length) L.push(`No association with: ${nulls.map(label).join(', ')}.`);
      if (unavailable.length) {
        L.push(
          `Churn-adjusted estimate unavailable for: ${unavailable.map(label).join(', ')} — the ` +
            'predictor does not vary within any band on that sample. Not a null.'
        );
      }
    }
    L.push('');
  }

  // ── NOTES AND LIMITS ────────────────────────────────────────────────────────────────────
  if (r.notes.length || r.structuralGaps.length) {
    L.push('## 7. Notes');
    L.push('');
    for (const n of r.notes) L.push(`- ${n}`);
    for (const g of r.structuralGaps) L.push(`- ${g}`);
    L.push('');
  }

  L.push('## 8. What this cannot establish');
  L.push('');
  L.push(
    '- Regions are not randomly assigned their dimension values, so every number here is an ' +
      'association. Banding on churn removes one confound and names it; it does nothing about the ' +
      'ones nobody has named.'
  );
  L.push(
    '- Regions inside a repository share authors, a release cycle and a build system. The cluster ' +
      'bootstrap over regions handles that for variance and cannot handle it for confounding.'
  );
  L.push(
    '- Fix rate and rework rate are derived from commit messages, which is the same channel the ' +
      'record dimension measures. A team that never writes "revert" looks healthy by construction.'
  );
  L.push(
    '- A per-SD estimate is a linear summary. A dimension that only bites in its top few per cent ' +
      'would show a small linear slope, and this document would call that a null. The within-band ' +
      'columns are the check on that: a real threshold effect concentrated in one part of the ' +
      'range would show up as one band disagreeing loudly with the rest.'
  );
  L.push('- Public repositories are not private codebases, and no individual is identifiable here.');
  L.push('');

  return `${L.join('\n')}\n`;
}
