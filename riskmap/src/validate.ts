/**
 * Step 9 — retrospective validation. This is what makes it an artifact rather than a poster.
 *
 * THE DESIGN. Build the map as of a date T at least twelve months in the past, using ONLY
 * commits before T. Then look at what happened in each region AFTER T and ask whether the
 * regions the map flagged went on to behave worse than the ones it did not.
 *
 * The outcomes are all git-only, because the input has to stay a clone:
 *
 *   FIX RATE       — share of post-T commits in the region whose message marks it as a revert,
 *                    hotfix or regression fix. The most direct available proxy for "this change
 *                    was wrong".
 *   REWORK RATE    — share of post-T commits that touch a file another commit in the same
 *                    region touched within the previous 30 days. Churn that comes straight back
 *                    is the signature of a change that did not land cleanly.
 *   FIX LATENCY    — median days from a file's first post-T commit to a subsequent fix commit
 *                    touching it. Reported for shape; it is the noisiest of the three.
 *
 * WHAT A NULL RESULT MEANS, stated before running it. If flagged regions do not show worse
 * outcomes, the map does not predict anything measurable in git and that is worth knowing
 * BEFORE it is attached to ten cold emails. This module is not here to confirm the map. The
 * honest outcome of the exercise is a number either way, and the report prints the null as
 * plainly as it would print a hit.
 *
 * THE LIMITS, which do not go away if the result is positive:
 *
 *   - Flagging is not random assignment. Flagged regions differ from unflagged ones in ways
 *     the map measures (churn, above all) and in ways it does not. A churn-heavy region has
 *     more post-T commits and therefore more opportunities to contain a fix, which biases the
 *     fix rate upward for reasons that have nothing to do with risk. The report stratifies by
 *     churn for exactly this reason, and that helps rather than solves.
 *   - Commit-message-derived outcomes measure what teams write down, which is the same channel
 *     the record dimension measures. A team that never writes "revert" in a commit message
 *     looks healthy here by construction.
 *   - Regions are not independent across a repository, which the cluster bootstrap handles for
 *     variance and cannot handle for confounding.
 */

import { buildMap } from './build.js';
import { readLog, readRepoName } from './gitlog.js';
import { isBot } from './identity.js';
import { isExcludedPath } from './filters.js';
import { regionOf } from './regions.js';
import { bootstrapDifference, mean, quantiles, type Interval } from './stats.js';
import type { Commit } from './types.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MONTH = 30.44 * MS_PER_DAY;

/**
 * Commit messages that mark a correction.
 *
 * Deliberately narrow. Broadening it to any message containing "fix" would sweep in every
 * ordinary bug fix in the repository, which is normal engineering rather than evidence that a
 * region is in trouble, and would push both arms toward the same rate.
 */
const FIX_MESSAGE =
  /^(revert\b|revert:|fixup!|hotfix\b)|^(fix|chore|bug)?\s*(\([^)]*\))?\s*:?\s*(revert|hotfix|regression|re-?fix|follow[- ]?up fix|emergency)\b|\b(reverts? commit|regression (introduced|caused) by|broke[n]? by|re-?land|roll ?back)\b/i;

export function isFixCommit(subject: string, body: string): boolean {
  return FIX_MESSAGE.test(subject) || FIX_MESSAGE.test(body.split('\n')[0] ?? '');
}

export interface RegionOutcome {
  repo: string;
  region: string;
  flagged: boolean;
  /** Dimensions as of T, kept so the report can stratify. */
  orphanedShare: number;
  concentration: number;
  commitsPerMonthAtT: number;
  postCommits: number;
  fixRate: number;
  reworkRate: number;
  medianFixLatencyDays: number | null;
}

export interface ValidationResult {
  repos: string[];
  monthsBack: number;
  followMonths: number;
  asOf: Record<string, string>;
  regions: RegionOutcome[];
  comparisons: {
    metric: string;
    flaggedMean: number;
    unflaggedMean: number;
    difference: Interval;
    flaggedQuantiles: ReturnType<typeof quantiles>;
    unflaggedQuantiles: ReturnType<typeof quantiles>;
  }[];
  /** The same comparison inside churn strata, because churn is the obvious confound. */
  churnStratified: {
    stratum: string;
    nFlagged: number;
    nUnflagged: number;
    metric: string;
    difference: Interval;
  }[];
  notes: string[];
  /** Regions with NO post-T activity, by arm. Reported, never silently excluded. */
  silent: { flagged: number; unflagged: number };
}

export interface ValidationOpts {
  repos: string[];
  monthsBack: number;
  followMonths: number;
  onProgress?: (msg: string) => void;
}

function outcomesFor(
  post: Commit[],
  depth: number,
  regionPaths: Set<string>
): Map<string, { commits: Commit[]; fixes: number; rework: number }> {
  const byRegion = new Map<string, { commits: Commit[]; fixes: number; rework: number }>();
  // Last time each file was touched post-T, for the rework window.
  const lastTouch = new Map<string, number>();

  for (const c of [...post].sort((a, b) => a.at - b.at)) {
    const regions = new Set<string>();
    let rework = false;
    for (const f of c.files) {
      if (isExcludedPath(f.path)) continue;
      let r = regionOf(f.path, depth);
      // Fold to a known region if this exact depth-cut is not one the map produced.
      while (!regionPaths.has(r) && r.includes('/')) r = r.slice(0, r.lastIndexOf('/'));
      if (!regionPaths.has(r)) continue;
      regions.add(r);
      const prev = lastTouch.get(f.path);
      if (prev !== undefined && c.at - prev <= 30 * MS_PER_DAY) rework = true;
      lastTouch.set(f.path, c.at);
    }
    const fix = isFixCommit(c.subject, c.body);
    for (const r of regions) {
      let e = byRegion.get(r);
      if (!e) {
        e = { commits: [], fixes: 0, rework: 0 };
        byRegion.set(r, e);
      }
      e.commits.push(c);
      if (fix) e.fixes++;
      if (rework) e.rework++;
    }
  }
  return byRegion;
}

function fixLatencies(post: Commit[], depth: number, region: string, regionPaths: Set<string>): number[] {
  const firstTouch = new Map<string, number>();
  const out: number[] = [];
  for (const c of [...post].sort((a, b) => a.at - b.at)) {
    const fix = isFixCommit(c.subject, c.body);
    for (const f of c.files) {
      if (isExcludedPath(f.path)) continue;
      let r = regionOf(f.path, depth);
      while (!regionPaths.has(r) && r.includes('/')) r = r.slice(0, r.lastIndexOf('/'));
      if (r !== region) continue;
      const first = firstTouch.get(f.path);
      if (first === undefined) {
        firstTouch.set(f.path, c.at);
      } else if (fix) {
        out.push((c.at - first) / MS_PER_DAY);
      }
    }
  }
  return out;
}

export async function runValidation(opts: ValidationOpts): Promise<ValidationResult> {
  const log = opts.onProgress ?? (() => {});
  const regions: RegionOutcome[] = [];
  const asOfByRepo: Record<string, string> = {};
  const notes: string[] = [];
  let silentFlagged = 0;
  let silentUnflagged = 0;

  for (const repo of opts.repos) {
    const name = await readRepoName(repo);
    log(`${name}: building the map as of ${opts.monthsBack} months ago`);

    const all = await readLog({ repo });
    if (all.length === 0) {
      notes.push(`${name}: no commits read, skipped.`);
      continue;
    }
    const headAt = Math.max(...all.map((c) => c.at));
    const T = headAt - opts.monthsBack * MS_PER_MONTH;
    const followEnd = Math.min(headAt, T + opts.followMonths * MS_PER_MONTH);
    asOfByRepo[name] = new Date(T).toISOString().slice(0, 10);

    // The map is built through the SAME builder the product path uses, with asOf set to T.
    // A validation that ran through a different builder would be validating a different tool.
    const { map } = await buildMap({ repo, asOf: T, coverage: null, onProgress: () => {} });
    if (map.regions.length === 0) {
      notes.push(`${name}: no regions as of T, skipped.`);
      continue;
    }

    const post = all.filter(
      (c) => c.at >= T && c.at <= followEnd && !isBot(c.authorName, c.authorEmail)
    );
    log(`${name}: ${map.regions.length} regions at T, ${map.regions.filter((r) => r.flagged).length} flagged, ${post.length} commits after`);

    const regionPaths = new Set(map.regions.map((r) => r.path));
    const flaggedPaths = new Set(map.regions.filter((r) => r.flagged).map((r) => r.path));
    const outcomes = outcomesFor(post, map.report.regionDepth, regionPaths);

    // THE SELECTION PROBLEM AT THE HEART OF THIS TEST, found by running it.
    //
    // The first version required 5 post-T commits before a region counted, on the reasonable
    // ground that a rate computed from two commits is noise. On grafana that floor excluded
    // ALL FOUR flagged regions and left 54 unflagged ones, so the comparison had an empty arm
    // and reported a difference of exactly zero with a zero-width interval — a null that was
    // an artifact of the filter rather than a finding about the map.
    //
    // It is not a tuning accident. Flagged regions are, by construction, the ones nobody is
    // working on any more: an orphaned region gets very few commits in the following year, so
    // ANY activity floor preferentially deletes the treatment arm. The floor is therefore 1,
    // and the count of flagged regions with NO post-T activity at all is reported separately —
    // "nobody touched it" is a real outcome for this question, not missing data, and hiding it
    // inside an exclusion would have made the harness look like it was working.
    for (const r of map.regions) {
      const o = outcomes.get(r.path);
      const n = o?.commits.length ?? 0;
      if (n === 0) {
        if (flaggedPaths.has(r.path)) silentFlagged++;
        else silentUnflagged++;
        continue;
      }
      const lat = fixLatencies(post, map.report.regionDepth, r.path, regionPaths);
      lat.sort((a, b) => a - b);
      regions.push({
        repo: name,
        region: r.path,
        flagged: flaggedPaths.has(r.path),
        orphanedShare: r.orphanedShare,
        concentration: r.concentration,
        commitsPerMonthAtT: r.commitsPerMonth,
        postCommits: n,
        fixRate: (o?.fixes ?? 0) / n,
        reworkRate: (o?.rework ?? 0) / n,
        medianFixLatencyDays: lat.length ? lat[Math.floor(lat.length / 2)]! : null,
      });
    }
  }

  const flagged = regions.filter((r) => r.flagged);
  const unflagged = regions.filter((r) => !r.flagged);
  const silent = { flagged: silentFlagged, unflagged: silentUnflagged };

  const metrics: { key: 'fixRate' | 'reworkRate'; label: string }[] = [
    { key: 'fixRate', label: 'fix / revert rate' },
    { key: 'reworkRate', label: 'rework rate (file re-touched within 30 days)' },
  ];

  const comparisons = metrics.map((m) => {
    const a = flagged.map((r) => r[m.key]);
    const b = unflagged.map((r) => r[m.key]);
    return {
      metric: m.label,
      flaggedMean: mean(a),
      unflaggedMean: mean(b),
      difference: bootstrapDifference(a, b),
      flaggedQuantiles: quantiles(a),
      unflaggedQuantiles: quantiles(b),
    };
  });

  // Churn is the obvious confound: the map flags on churn, and a busier region has more
  // opportunities to contain a fix commit. Splitting at the median churn at T does not remove
  // the confound, but it shows whether the difference survives inside a stratum.
  const churnSorted = [...regions].sort((a, b) => a.commitsPerMonthAtT - b.commitsPerMonthAtT);
  const medianChurn = churnSorted.length
    ? churnSorted[Math.floor(churnSorted.length / 2)]!.commitsPerMonthAtT
    : 0;
  const churnStratified: ValidationResult['churnStratified'] = [];
  for (const [label, pick] of [
    ['below median churn at T', (r: RegionOutcome) => r.commitsPerMonthAtT <= medianChurn],
    ['above median churn at T', (r: RegionOutcome) => r.commitsPerMonthAtT > medianChurn],
  ] as const) {
    const f = flagged.filter(pick);
    const u = unflagged.filter(pick);
    for (const m of metrics) {
      churnStratified.push({
        stratum: label,
        nFlagged: f.length,
        nUnflagged: u.length,
        metric: m.label,
        difference: bootstrapDifference(f.map((r) => r[m.key]), u.map((r) => r[m.key])),
      });
    }
  }

  if (flagged.length === 0 && silentFlagged > 0) {
    notes.push(
      `THE COMPARISON IS EMPTY, AND THAT IS THE RESULT. All ${silentFlagged} flagged regions ` +
        'received no commits at all in the follow-up window, so there is no post-T behaviour to ' +
        'compare. Read the difference tables below as "not computed", never as "no effect" — both ' +
        'arms of a difference must be non-empty for it to mean anything.'
    );
    notes.push(
      'This is close to mechanical rather than predictive, and must not be sold as a hit: the map ' +
        'flags a region for having contributors who stopped committing, and such a region then ' +
        'receiving no commits is nearly the same statement made twice. It is weak evidence that ' +
        'the ownership signal identifies genuinely dormant code, and it is NOT evidence that ' +
        'flagged regions produce worse outcomes when someone does touch them — which is the claim ' +
        'the outreach would want and this run does not support.'
    );
    notes.push(
      'To test the real claim, the harness needs repositories where flagged regions are still ' +
        'being modified — a shorter follow-up window will not help, and adding repositories only ' +
        'helps if their flagged regions are live.'
    );
  } else if (flagged.length < 10) {
    notes.push(
      `Only ${flagged.length} flagged regions had any post-T activity. That is too few to lean on: ` +
        'report the direction, not the interval, and add repositories before citing this.'
    );
  }

  return {
    repos: opts.repos,
    monthsBack: opts.monthsBack,
    followMonths: opts.followMonths,
    asOf: asOfByRepo,
    regions,
    comparisons,
    churnStratified,
    notes,
    silent,
  };
}

const p3 = (v: number) => v.toFixed(3);

export function formatValidationReport(r: ValidationResult): string {
  const L: string[] = [];
  const flagged = r.regions.filter((x) => x.flagged).length;
  const unflagged = r.regions.length - flagged;

  L.push('# Retrospective validation — does a flag predict anything?');
  L.push('');
  L.push(
    `The map was rebuilt as of ${r.monthsBack} months before each repository's HEAD, using only ` +
      `commits before that date, and outcomes were measured over the following ${r.followMonths} months.`
  );
  L.push('');
  L.push(`Repositories: ${Object.entries(r.asOf).map(([k, v]) => `${k} (T=${v})`).join(', ') || 'none'}`);
  L.push(`Regions with any post-T activity: **${r.regions.length}** — ${flagged} flagged, ${unflagged} not.`);
  L.push('');
  L.push(
    `Regions with NO post-T commits at all: **${r.silent.flagged} flagged**, ${r.silent.unflagged} not flagged. ` +
      'These are reported rather than excluded. An activity floor preferentially deletes the ' +
      'flagged arm, because a region nobody is working on any more is exactly what the map flags ' +
      '— an earlier version of this harness used a 5-commit floor and removed every flagged ' +
      'region on grafana, then reported a difference of zero with a zero-width interval.'
  );
  L.push('');

  L.push('## Distributions, not means');
  L.push('');
  L.push('Means are shown last and on purpose. Outcome rates across regions are skewed, so a');
  L.push('difference of means can describe no actual region.');
  L.push('');
  for (const c of r.comparisons) {
    L.push(`### ${c.metric}`);
    L.push('');
    L.push('| arm | p10 | p25 | median | p75 | p90 | mean |');
    L.push('| --- | --- | --- | --- | --- | --- | --- |');
    const f = c.flaggedQuantiles;
    const u = c.unflaggedQuantiles;
    L.push(`| flagged | ${p3(f.p10)} | ${p3(f.p25)} | ${p3(f.p50)} | ${p3(f.p75)} | ${p3(f.p90)} | ${p3(c.flaggedMean)} |`);
    L.push(`| not flagged | ${p3(u.p10)} | ${p3(u.p25)} | ${p3(u.p50)} | ${p3(u.p75)} | ${p3(u.p90)} | ${p3(c.unflaggedMean)} |`);
    L.push('');
    L.push(
      `Difference (flagged − not): **${p3(c.difference.estimate)}** ` +
        `95% CI [${p3(c.difference.lo)}, ${p3(c.difference.hi)}], cluster bootstrap over regions.`
    );
    L.push('');
    const empty = c.flaggedQuantiles.p50 === 0 && c.difference.n === 0;
    const crosses = c.difference.lo <= 0 && c.difference.hi >= 0;
    L.push(
      empty
        ? '> **Not computed.** One arm is empty, so this difference is a placeholder and not a ' +
          'measurement. See the notes.'
        : crosses
        ? '> The interval crosses zero. On this evidence the flag does not predict this outcome. ' +
          'Note that a CI straddling zero is not evidence of equivalence — it may mean the ' +
          'comparison is underpowered, which the region count above will show.'
        : '> The interval excludes zero in the predicted direction.'
    );
    L.push('');
  }

  L.push('## Stratified by churn at T');
  L.push('');
  L.push('Churn is the obvious confound: the map flags partly on churn, and a busier region has');
  L.push('more opportunities to contain a fix commit. Splitting at the median does not remove the');
  L.push('confound; it shows whether the difference survives inside a stratum.');
  L.push('');
  L.push('| stratum | metric | flagged n | unflagged n | difference | 95% CI |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const s of r.churnStratified) {
    L.push(
      `| ${s.stratum} | ${s.metric} | ${s.nFlagged} | ${s.nUnflagged} | ${p3(s.difference.estimate)} | ` +
        `[${p3(s.difference.lo)}, ${p3(s.difference.hi)}] |`
    );
  }
  L.push('');

  L.push('## What this cannot establish');
  L.push('');
  L.push('- Flagging is not random assignment. Flagged regions differ from unflagged ones in ways');
  L.push('  the map measures and in ways it does not, so this is an association and not an effect.');
  L.push('- Outcomes are derived from commit messages, which is the same channel the record');
  L.push('  dimension measures. A team that never writes "revert" looks healthy here by construction.');
  L.push('- Public repositories are not private codebases, and their review culture is stronger.');
  L.push('');
  if (r.notes.length) {
    L.push('## Notes');
    L.push('');
    for (const n of r.notes) L.push(`- ${n}`);
    L.push('');
  }
  return L.join('\n');
}
