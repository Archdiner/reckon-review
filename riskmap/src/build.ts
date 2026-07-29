/**
 * The pipeline, steps 1 through 7, in one place.
 *
 * Kept separate from cli.ts because the retrospective validation in validate.ts needs to build
 * a map "as of" a past date using exactly the same code path. A validation that ran through a
 * different builder would be validating a different tool.
 */

import type { LlmBackend } from '@reckon/core';
import { readLog, readHead, readRepoName, readAuthorRoster, readTreePaths } from './gitlog.js';
import { resolveIdentities, isBot, footprints, isSubstantial } from './identity.js';
import { filterCommits } from './filters.js';
import { partitionRegions, foldSmallRegions, regionFor } from './regions.js';
import {
  DEFAULT_THRESHOLDS,
  computeRegion,
  applyFlags,
  resolveChurnThreshold,
  rankRegions,
  inactiveIdentities,
  monthsBefore,
  isLowMeaningRegion,
} from './dimensions.js';
import { detectSquashConvention, recordUsableForFlags } from './squash.js';
import { computeCoverage, applyCoverage } from './coverage.js';
import { loadCalibration, midrankPercentile, type Calibration } from './calibration.js';
import type { Commit, Edit, Region, RiskMap, Thresholds } from './types.js';

export interface BuildOpts {
  repo: string;
  thresholds?: Partial<Thresholds>;
  /** Force a region depth instead of choosing one. */
  depth?: number;
  /**
   * Treat this epoch ms as "now". Defaults to HEAD's author date — never wall clock, so the
   * same clone yields the same map, and so validate.ts can rebuild the past honestly.
   */
  asOf?: number;
  /** Score record coverage. Costs model calls; the map is worth sending without it. */
  coverage?: { backend: LlmBackend; genBackend: LlmBackend; perRegion: number } | null;
  onProgress?: (msg: string) => void;
}

export async function buildMap(opts: BuildOpts): Promise<{ map: RiskMap; calibration: Calibration | null }> {
  const t: Thresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
  const log = opts.onProgress ?? (() => {});

  const head = await readHead(opts.repo);
  const repoName = await readRepoName(opts.repo);
  const asOf = opts.asOf ?? head.at;
  const windowStart = monthsBefore(asOf, t.windowMonths);
  const inactivityCutoff = monthsBefore(asOf, t.inactivityMonths);

  log(`reading history of ${repoName}`);
  // Read only back to the window start. `--numstat` over a full history is the slowest thing
  // this tool does, and nothing needs commits older than the window: a contributor's activity
  // is judged against a 12-month cutoff that sits INSIDE a 24-month window, so anyone whose
  // last commit predates the window is inactive whether or not their older commits were read,
  // and they have no edits in the window to attribute either way.
  const raw = await readLog({
    repo: opts.repo,
    after: windowStart,
    before: opts.asOf ? asOf : undefined,
  });

  // Bot classification happens before anything else counts, because a bot in the identity
  // clustering would merge real people into a release account through a shared display name.
  const marked = raw.map((c) => ({ ...c, bot: isBot(c.authorName, c.authorEmail) }));

  // Full-history author dates, for the inactivity judgement only. No --numstat, so it is cheap.
  const fullHistory = (await readAuthorRoster(opts.repo, opts.asOf ? asOf : undefined, true)).map(
    (r) => ({ authorName: r.name, authorEmail: r.email, at: r.at, bot: isBot(r.name, r.email) })
  );

  // IDENTITY CLUSTERING READS THE FULL HISTORY, NOT THE WINDOW. An earlier version fed it the
  // windowed commits and argued in a comment that this was safe because the inactivity cutoff
  // sits inside the window. That argument only covered `lastSeen`; it missed clustering, which
  // unions transitively on display name, so a commit older than the window can be the only
  // bridge between two in-window aliases of one person. Splitting one contributor in two
  // invents a bus factor — the expensive direction of error — and it was measured moving
  // orphanedShare by 0.50 and flipping a region's flag with the in-window edits held identical.
  // The roster call omits --numstat, so it is cheap.
  const roster = (await readAuthorRoster(opts.repo, opts.asOf ? asOf : undefined))
    .map((r) => ({ authorName: r.name, authorEmail: r.email }))
    .filter((r) => !isBot(r.authorName, r.authorEmail));
  const ids = resolveIdentities(roster);
  const whoOf = (c: Commit) => ids.keyFor(c.authorName, c.authorEmail);

  const { kept, dropped, pathsExcluded } = filterCommits(marked, {
    maxFilesPerCommit: t.maxFilesPerCommit,
    windowStart,
    windowEnd: asOf,
  });
  log(`${raw.length} commits read, ${kept.length} in window after filtering`);

  // Activity is repo-wide and UNWINDOWED on purpose: the question is whether a person is still
  // around, and any commit at all is evidence of that.
  // INACTIVITY IS JUDGED AGAINST THE FULL HISTORY, not the measurement window. With a 24-month
  // window, deriving activity from windowed commits would make anyone whose last commit predates
  // the window invisible rather than inactive, and a short window would flatter every repo.
  const activity = fullHistory
    .filter((c) => !c.bot && c.at <= asOf)
    .map((c) => ({ who: ids.keyFor(c.authorName, c.authorEmail), at: c.at }));
  const inactive = inactiveIdentities(activity, inactivityCutoff);

  // DEPARTED = inactive AND substantial. Inactive alone is dominated by drive-by contributors:
  // on this corpus ~70% of inactive identities committed exactly once, median span zero days.
  const prints = footprints(
    fullHistory.filter((c) => !c.bot).map((c) => ({ name: c.authorName, email: c.authorEmail, at: c.at })),
    ids.keyFor
  );
  const departed = new Set([...inactive].filter((k) => isSubstantial(prints.get(k))));
  log(
    `${inactive.size} inactive identities, ${departed.size} of them substantial ` +
      `(${inactive.size ? Math.round((100 * (inactive.size - departed.size)) / inactive.size) : 0}% filtered as drive-bys)`
  );

  const edits: Edit[] = [];
  for (const c of kept) {
    const who = whoOf(c);
    for (const f of c.files) {
      edits.push({ sha: c.sha, who, at: c.at, path: f.path, added: f.added, deleted: f.deleted });
    }
  }

  const partition = partitionRegions(edits, {
    minCommits: t.regionMinCommits,
    forcedDepth: opts.depth,
  });
  const regionSet = foldSmallRegions(edits, partition, t.regionMinCommits);
  log(
    `${regionSet.size} regions, cut at mixed depth up to ${partition.maxDepth}` +
      `${partition.fallback ? ' (splitting ran out before the target band)' : ''}`
  );

  const editsByRegion = new Map<string, Edit[]>();
  for (const e of edits) {
    const r = regionFor(e.path, regionSet);
    const list = editsByRegion.get(r);
    if (list) list.push(e);
    else editsByRegion.set(r, [e]);
  }

  // Most recent contributor per file, which is what the headline orphan measure keys on.
  const lastToucher = new Map<string, string>();
  for (const e of [...edits].sort((a, b) => a.at - b.at)) lastToucher.set(e.path, e.who);

  // Which regions still exist. Read from the tree at the analysis point, so the retrospective
  // harness asks the same question as of T rather than as of today.
  const treePaths = await readTreePaths(opts.repo, opts.asOf ? `HEAD@{${new Date(asOf).toISOString()}}` : 'HEAD')
    .catch(() => readTreePaths(opts.repo, 'HEAD'));
  const extantRegions = new Set<string>();
  for (const p of treePaths) extantRegions.add(regionFor(p, regionSet));

  const commitsBySha = new Map(kept.map((c) => [c.sha, c]));
  const commitsByRegion = new Map<string, Commit[]>();
  for (const [region, list] of editsByRegion) {
    const shas = new Set(list.map((e) => e.sha));
    commitsByRegion.set(
      region,
      [...shas].map((s) => commitsBySha.get(s)!).filter(Boolean)
    );
  }

  const squash = detectSquashConvention(kept);
  log(`record dimension: ${squash.availability} (${(squash.substantiveBodyShare * 100).toFixed(1)}% substantive bodies)`);

  // Churn divides by the span actually observed, not the configured window: a repo with 18
  // months of history had every rate divided by 60 and printed a third of the truth.
  let earliest = asOf;
  for (const c of kept) if (c.at < earliest) earliest = c.at;
  const spanMonths = Math.max(1, (asOf - earliest) / (30.44 * 24 * 60 * 60 * 1000));
  log(`observed span ${spanMonths.toFixed(1)} months (window allows ${t.windowMonths})`);

  let regions: Region[] = [];
  for (const [region, list] of editsByRegion) {
    regions.push(
      computeRegion(
        { region, edits: list, commits: commitsByRegion.get(region) ?? [], whoOf: new Map(), lastToucher, extant: extantRegions.has(region), departed },
        inactive,
        spanMonths,
        t
      )
    );
  }

  const calibration = loadCalibration();

  if (opts.coverage && squash.availability !== 'unavailable') {
    log(`scoring record coverage, up to ${opts.coverage.perRegion} commits per region`);
    const result = await computeCoverage(commitsByRegion, {
      repo: opts.repo,
      backend: opts.coverage.backend,
      genBackend: opts.coverage.genBackend,
      perRegion: opts.coverage.perRegion,
      maxFilesPerCommit: t.maxFilesPerCommit,
      onProgress: log,
    });
    if (calibration) {
      regions = applyCoverage(regions, result, (v) => midrankPercentile(calibration.sorted, v));
    } else {
      // Do NOT stamp p50. An earlier version did, which rendered a corpus position that was
      // never measured and silently made `undocumented` unfireable. Coverage is shown without
      // a percentile instead.
      regions = applyCoverage(regions, result, () => Number.NaN);
    }
    log(`${result.questionsAsked} questions scored`);
  } else if (opts.coverage) {
    log('record coverage skipped: the squash verdict says commit messages do not carry the record here');
  }

  const usable = recordUsableForFlags(squash);
  const churnThreshold = resolveChurnThreshold(regions, t);
  regions = regions.map((r) => applyFlags(r, t, usable, churnThreshold));
  log(`churn threshold ${churnThreshold.toFixed(1)} commits/month (median region in this repo)`);

  // Low-meaning regions are demoted rather than deleted: a migrations directory nobody active
  // has touched is worth knowing about, it just should not win the top ten on churn alone.
  const lowMeaning = new Set(
    [...editsByRegion].filter(([r, e]) => isLowMeaningRegion(r, e)).map(([r]) => r)
  );
  // TEN ROWS ALWAYS, RANKED, WITH THE FLAGGED ONES MARKED — not only the regions that cleared
  // the rule. Two rows in a 37,000-commit repository reads as a tool that found nothing, and a
  // reader learns more from the gradient than from the cut: the rows just under the line are
  // where they recognise their own codebase and start arguing about the threshold, which is the
  // conversation this artifact exists to start.
  const rank = (r: Region) =>
    (r.flagged ? 2 : 0) + (r.flags.includes('hot') && r.orphanedShare >= 0.25 ? 1 : 0);
  const ordered = [...regions].sort(
    (a, b) =>
      rank(b) - rank(a) ||
      Number(lowMeaning.has(a.path)) - Number(lowMeaning.has(b.path)) ||
      b.orphanedShare - a.orphanedShare ||
      b.commitsPerMonth - a.commitsPerMonth
  );
  const top = ordered.slice(0, 10);
  void rankRegions;

  regions.sort((a, b) => b.orphanedShare - a.orphanedShare || b.commitsPerMonth - a.commitsPerMonth);

  const map: RiskMap = {
    report: {
      repo: repoName,
      headSha: head.sha,
      asOf,
      windowMonths: t.windowMonths,
      commitsSeen: raw.length,
      commitsKept: kept.length,
      dropped: {
        'bot-author': dropped.botAuthor,
        'oversized-commit': dropped.oversized,
        'no-surviving-files': dropped.noSurvivingFiles,
        'outside-window': dropped.outsideWindow,
      },
      pathsExcluded,
      identitiesBeforeMerge: ids.before,
      identitiesAfterMerge: ids.after,
      spanMonths,
      regionDepth: partition.maxDepth,
      regionDepthFallback: partition.fallback,
      // `trace` records SPLIT ITERATIONS, not depths. Serialising t.step under a `depth` key
      // asserted things like "depth 2 -> 74 regions" in customer-visible JSON, which is simply
      // a different claim from the one the partition makes.
      regionSplits: partition.trace.map((t) => ({ step: t.step, split: t.split, regions: t.regions })),
    },
    thresholds: { ...t, commitsPerMonth: churnThreshold },
    squash,
    regions,
    top,
    calibration: calibration
      ? { corpus: calibration.corpus, n: calibration.n, deciles: calibration.deciles, source: calibration.source }
      : null,
    generatedAtUtc: new Date().toISOString(),
  };

  return { map, calibration };
}
