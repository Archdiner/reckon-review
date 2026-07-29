/**
 * The pipeline, steps 1 through 7, in one place.
 *
 * Kept separate from cli.ts because the retrospective validation in validate.ts needs to build
 * a map "as of" a past date using exactly the same code path. A validation that ran through a
 * different builder would be validating a different tool.
 */

import type { LlmBackend } from '@reckon/core';
import { readLog, readHead, readRepoName } from './gitlog.js';
import { resolveIdentities, isBot } from './identity.js';
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
  const ids = resolveIdentities(marked.filter((c) => !c.bot));
  const whoOf = (c: Commit) => ids.keyFor(c.authorName, c.authorEmail);

  const { kept, dropped, pathsExcluded } = filterCommits(marked, {
    maxFilesPerCommit: t.maxFilesPerCommit,
    windowStart,
  });
  log(`${raw.length} commits read, ${kept.length} in window after filtering`);

  // Activity is repo-wide and UNWINDOWED on purpose: the question is whether a person is still
  // around, and any commit at all is evidence of that.
  const activity = marked
    .filter((c) => !c.bot && c.at <= asOf)
    .map((c) => ({ who: whoOf(c), at: c.at }));
  const inactive = inactiveIdentities(activity, inactivityCutoff);

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

  let regions: Region[] = [];
  for (const [region, list] of editsByRegion) {
    regions.push(
      computeRegion(
        { region, edits: list, commits: commitsByRegion.get(region) ?? [], whoOf: new Map() },
        inactive,
        asOf,
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
      regions = applyCoverage(regions, result, () => 50);
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
  const ranked = rankRegions(regions);
  const top = [
    ...ranked.filter((r) => !lowMeaning.has(r.path)),
    ...ranked.filter((r) => lowMeaning.has(r.path)),
  ].slice(0, 10);

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
      regionDepth: partition.maxDepth,
      regionDepthFallback: partition.fallback,
      regionDepthCandidates: partition.trace.map((t) => ({ depth: t.step, regions: t.regions })),
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
