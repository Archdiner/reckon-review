/**
 * Turn a raw Snapshot into the things the report actually shows. Pure: no IO, no Supabase, so
 * the aggregation and the health rules can be reasoned about (and later tested) on fixtures.
 *
 * Three outputs, answering three different questions:
 *   funnel() + health()   is the pipeline collecting what we think it is?
 *   knowledgeMap()        who understands which subsystem, how fresh, where is the bus factor 1?
 *   domainProfiles()      what kinds of understanding does each person carry across repos?
 */
import { areaLabel, labelsFromConfig, type AreaLabels } from '../knowledge/areas.js';
import { domainLabel } from '../knowledge/domains.js';
import {
  AREA_STATUS_META, FRESH_FLOOR, areaStatus, confidenceOf, daysBetween, rollup,
  type AreaStatus,
} from '../knowledge/freshness.js';
import type { AreaEdge, AreaNode } from '../graph/area-graph.js';
import type { CheckpointRow, DemonstrationRow, Snapshot } from './query.js';

/**
 * The composite (repo, area) key used by every map in this file. Behind a helper because it was
 * previously inlined at five call sites with a separator that is invisible in a diff: one of them
 * drifting to a different separator silently produced keys that never matched and areas that
 * split into undefined. A tab cannot appear in a repo full_name or an area slug.
 */
const KEY_SEP = '\t';
const areaKey = (repo: string, area: string): string => `${repo}${KEY_SEP}${area}`;
const splitAreaKey = (key: string): [string, string] => {
  const i = key.indexOf(KEY_SEP);
  return [key.slice(0, i), key.slice(i + 1)];
};

/** Statuses that represent a substantive change: the ones that age understanding (see
 *  freshness.ts). A trivial or peripheral skip touched nothing load-bearing by definition. */
const SUBSTANTIVE = new Set(['pending', 'passed', 'capped', 'error']);
const GATED = new Set(['pending', 'passed', 'error']);

export interface Funnel {
  seen: number; // every PR head Reckon reached a decision on
  gated: number; // opened a comprehension gate (spent a decompose call)
  answered: number; // at least one explanation attempt arrived
  passed: number;
  byStatus: { status: string; n: number }[];
  skipReasons: { reason: string; n: number }[];
}

export interface PersonInArea {
  githubId: number;
  login: string;
  confidence: number;
  demos: number;
  lastAt: string;
  bestVerdict: string | null;
  /** The PR behind their STRONGEST current demonstration, so the score is auditable in one
   *  click. Null only for rows written before provenance was recorded. */
  bestPr: number | null;
  bestConcept: string;
}

/** One demonstration, with everything needed to link back to where it happened. */
export interface Evidence {
  login: string;
  githubId: number;
  concept: string;
  verdict: string | null;
  note: string | null;
  at: string;
  repo: string | null;
  pr: number | null;
  headSha: string | null;
  /** What this single demonstration is worth today, after age and drift decay. */
  confidence: number;
}

export interface AreaSummary {
  repo: string;
  key: string;
  label: string;
  changes: number; // substantive changes ever recorded here
  changes30d: number;
  demos: number;
  /** From the persisted codebase graph: how big and how load-bearing this subsystem is. Null
   *  for an area we only know about because something changed there (no graph covered it). */
  node: AreaNode | null;
  people: PersonInArea[];
  fresh: PersonInArea[]; // people currently above the floor
  /** Every demonstration in this area, newest first. The receipts behind the status. */
  evidence: Evidence[];
  status: AreaStatus;
  statusLabel: string;
  statusIcon: string;
  statusTone: string;
  teamConfidence: number; // best current confidence held by anyone
  lastDemoAt: string | null;
  lastChangeAt: string | null;
}

export interface DomainProfile {
  githubId: number;
  login: string;
  total: number;
  domains: { key: string; label: string; n: number; confidence: number }[];
  areas: number;
  repos: number;
  lastAt: string | null;
}

export type Severity = 'critical' | 'serious' | 'warning' | 'ok';

export interface Finding {
  severity: Severity;
  title: string;
  detail: string;
  /** What to do about it. A finding with no fix is a complaint, not a diagnosis. */
  fix: string;
  count?: number;
  /** The specific PRs the finding is about. A count tells you something is wrong; these tell
   *  you WHERE, which is the difference between a dashboard and a work list. Capped, with the
   *  overflow disclosed rather than silently dropped. */
  refs?: { label: string; repo: string; pr: number }[];
  refsOmitted?: number;
}

/** Findings name at most this many PRs inline; the rest are counted. */
const MAX_REFS = 12;

function refsFor(rows: { repo_id: number; pr_number: number }[], names: Map<number, string>): Pick<Finding, 'refs' | 'refsOmitted'> {
  const all = rows
    .map((c) => ({ repo: names.get(c.repo_id) ?? '', pr: c.pr_number, label: `#${c.pr_number}` }))
    .filter((r) => r.repo);
  return { refs: all.slice(0, MAX_REFS), refsOmitted: Math.max(0, all.length - MAX_REFS) };
}

// ── Funnel ─────────────────────────────────────────────────────────────────────────────────

export function funnel(s: Snapshot): Funnel {
  const byStatus = new Map<string, number>();
  const skipReasons = new Map<string, number>();
  for (const c of s.checkpoints) {
    byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);
    if (c.skip_reason) {
      // Collapse the variable part of a reason ("tiny change (6 lines)") so the tally groups.
      const r = c.skip_reason.replace(/\(\d+[^)]*\)/g, '').replace(/\s+/g, ' ').trim();
      skipReasons.set(r, (skipReasons.get(r) ?? 0) + 1);
    }
  }
  const answeredIds = new Set(s.attempts.map((a) => a.checkpoint_id));
  return {
    seen: s.checkpoints.length,
    gated: s.checkpoints.filter((c) => GATED.has(c.status)).length,
    answered: s.checkpoints.filter((c) => answeredIds.has(c.id)).length,
    passed: s.checkpoints.filter((c) => c.status === 'passed').length,
    byStatus: [...byStatus.entries()].map(([status, n]) => ({ status, n })).sort((a, b) => b.n - a.n),
    skipReasons: [...skipReasons.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
  };
}

// ── The knowledge map ──────────────────────────────────────────────────────────────────────

function repoNameById(s: Snapshot): Map<number, string> {
  return new Map(s.repos.map((r) => [r.id, r.full_name]));
}

function labelsByRepo(s: Snapshot): Map<string, AreaLabels> {
  return new Map(s.repos.map((r) => [r.full_name, labelsFromConfig(r.config)]));
}

function loginById(s: Snapshot): Map<number, string> {
  const m = new Map<number, string>();
  for (const d of s.demonstrations) if (d.github_login) m.set(d.github_id, d.github_login);
  for (const u of s.users) if (u.github_login) m.set(u.github_id, u.github_login);
  return m;
}

/**
 * Substantive changes per (repo, area), with their timestamps. This is the drift signal: the
 * count of these landing AFTER a demonstration is what decays it.
 */
function areaChanges(s: Snapshot): Map<string, string[]> {
  const names = repoNameById(s);
  const out = new Map<string, string[]>();
  for (const c of s.checkpoints) {
    if (!SUBSTANTIVE.has(c.status)) continue;
    const repo = names.get(c.repo_id);
    if (!repo) continue;
    for (const a of c.areas ?? []) {
      const k = areaKey(repo, a);
      const arr = out.get(k) ?? [];
      arr.push(c.created_at);
      out.set(k, arr);
    }
  }
  for (const arr of out.values()) arr.sort();
  return out;
}

/**
 * The newest persisted subsystem rollup per repo. A diagram is a snapshot of one commit, so the
 * only sensible one to draw is the most recent, and a checkpoint that never built a graph (an
 * unsupported language, a timeout, a huge repo) simply does not contribute one.
 */
export function architectures(s: Snapshot): Architecture[] {
  const names = repoNameById(s);
  const newest = new Map<string, CheckpointRow>();
  for (const c of s.checkpoints) {
    const g = c.area_graph;
    if (!g || !Array.isArray(g.nodes) || g.nodes.length === 0) continue;
    const repo = names.get(c.repo_id);
    if (!repo) continue;
    const prev = newest.get(repo);
    if (!prev || c.created_at > prev.created_at) newest.set(repo, c);
  }
  return [...newest.entries()]
    .map(([repo, c]) => ({
      repo,
      nodes: (c.area_graph!.nodes ?? []) as AreaNode[],
      edges: (c.area_graph!.edges ?? []) as AreaEdge[],
      truncated: Boolean(c.area_graph!.truncated),
      omitted: Number(c.area_graph!.omitted ?? 0),
      headSha: c.head_sha,
      builtAt: c.created_at,
    }))
    .sort((a, b) => b.nodes.length - a.nodes.length || a.repo.localeCompare(b.repo));
}

export function knowledgeMap(s: Snapshot, now = new Date()): AreaSummary[] {
  const changes = areaChanges(s);
  const labels = labelsByRepo(s);
  const logins = loginById(s);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString();

  // Every (repo, area) the codebase graph knows EXISTS, plus anything changed or explained.
  //
  // Seeding from the graph is what makes the map honest about coverage. Built only from activity,
  // it could only ever show subsystems someone had already touched, so a subsystem nobody has
  // gone near, which is precisely the one with the worst bus factor, was invisible. The graph
  // enumerates the architecture independently of whether anyone worked on it.
  const nodesByKey = new Map<string, AreaNode>();
  for (const arch of architectures(s)) {
    for (const n of arch.nodes) nodesByKey.set(areaKey(arch.repo, n.area), n);
  }
  const keys = new Set<string>([...nodesByKey.keys(), ...changes.keys()]);
  for (const d of s.demonstrations) {
    if (d.repo_full_name && d.area) keys.add(areaKey(d.repo_full_name, d.area));
  }

  const demosByKey = new Map<string, DemonstrationRow[]>();
  for (const d of s.demonstrations) {
    if (!d.repo_full_name || !d.area) continue;
    const k = areaKey(d.repo_full_name, d.area);
    const arr = demosByKey.get(k) ?? [];
    arr.push(d);
    demosByKey.set(k, arr);
  }

  const out: AreaSummary[] = [];
  for (const key of keys) {
    const [repo, area] = splitAreaKey(key);
    const changeTimes = changes.get(key) ?? [];
    const demos = demosByKey.get(key) ?? [];

    // One entry per person: their strongest CURRENT demonstration in this area.
    const byPerson = new Map<number, DemonstrationRow[]>();
    for (const d of demos) {
      const arr = byPerson.get(d.github_id) ?? [];
      arr.push(d);
      byPerson.set(d.github_id, arr);
    }

    const people: PersonInArea[] = [];
    for (const [githubId, rows] of byPerson) {
      const scored = rows.map((d) => {
        // Drift: substantive changes to this same area landed after they explained it.
        const since = changeTimes.filter((t) => t > d.demonstrated_at).length;
        return { d, c: confidenceOf(d.verdict, daysBetween(d.demonstrated_at, now), since) };
      });
      const best = scored.reduce((a, b) => (b.c > a.c ? b : a));
      people.push({
        githubId,
        login: logins.get(githubId) ?? rows[0].github_login ?? `user ${githubId}`,
        confidence: rollup(scored.map((x) => x.c)),
        demos: rows.length,
        lastAt: rows.map((r) => r.demonstrated_at).sort().at(-1)!,
        bestVerdict: best.d.verdict,
        bestPr: best.d.pr_number ?? null,
        bestConcept: best.d.concept,
      });
    }
    people.sort((a, b) => b.confidence - a.confidence);
    const fresh = people.filter((p) => p.confidence >= FRESH_FLOOR);
    const status = areaStatus(fresh.length, demos.length);
    const meta = AREA_STATUS_META[status];

    // The receipts: every demonstration in this area with its provenance, newest first, each
    // scored the same way the rollup scores it so a reader can see WHY the area sits where it does.
    const evidence: Evidence[] = demos
      .map((d) => ({
        login: logins.get(d.github_id) ?? d.github_login ?? `user ${d.github_id}`,
        githubId: d.github_id,
        concept: d.concept,
        verdict: d.verdict,
        note: d.note,
        at: d.demonstrated_at,
        repo: d.repo_full_name,
        pr: d.pr_number,
        headSha: d.head_sha ?? null,
        confidence: confidenceOf(d.verdict, daysBetween(d.demonstrated_at, now), changeTimes.filter((t) => t > d.demonstrated_at).length),
      }))
      .sort((a, b) => (a.at < b.at ? 1 : -1));

    out.push({
      repo, key: area, label: areaLabel(area, labels.get(repo) ?? {}), evidence,
      node: nodesByKey.get(key) ?? null,
      changes: changeTimes.length,
      changes30d: changeTimes.filter((t) => t >= thirtyDaysAgo).length,
      demos: demos.length,
      people, fresh, status,
      statusLabel: meta.label, statusIcon: meta.icon, statusTone: meta.tone,
      teamConfidence: people.length ? people[0].confidence : 0,
      lastDemoAt: demos.map((d) => d.demonstrated_at).sort().at(-1) ?? null,
      lastChangeAt: changeTimes.at(-1) ?? null,
    });
  }

  // Riskiest first: unexplained before stale before single-point before covered. Within a
  // status, order by EXPOSURE, not just activity: an unexplained subsystem that 30 files
  // reference is a worse gap than an unexplained leaf that churns a lot, and only the graph
  // knows the difference. Falls back to change count where no graph covered the area.
  const rank: Record<AreaStatus, number> = { unexplained: 0, stale: 1, 'single-point': 2, covered: 3 };
  const exposure = (a: AreaSummary): number => (a.node ? a.node.fanIn * 2 + a.node.files : 0) + a.changes;
  return out.sort((a, b) => rank[a.status] - rank[b.status] || exposure(b) - exposure(a) || a.label.localeCompare(b.label));
}

// ── Domain profiles (the portable axis) ────────────────────────────────────────────────────

export function domainProfiles(s: Snapshot, now = new Date()): DomainProfile[] {
  const logins = loginById(s);
  const changes = areaChanges(s);
  const byPerson = new Map<number, DemonstrationRow[]>();
  for (const d of s.demonstrations) {
    const arr = byPerson.get(d.github_id) ?? [];
    arr.push(d);
    byPerson.set(d.github_id, arr);
  }

  const out: DomainProfile[] = [];
  for (const [githubId, rows] of byPerson) {
    const counts = new Map<string, { n: number; confidences: number[] }>();
    for (const d of rows) {
      const key = d.repo_full_name && d.area ? areaKey(d.repo_full_name, d.area) : null;
      const since = key ? (changes.get(key) ?? []).filter((t) => t > d.demonstrated_at).length : 0;
      const c = confidenceOf(d.verdict, daysBetween(d.demonstrated_at, now), since);
      for (const dom of d.domains ?? []) {
        const e = counts.get(dom) ?? { n: 0, confidences: [] };
        e.n += 1;
        e.confidences.push(c);
        counts.set(dom, e);
      }
    }
    out.push({
      githubId,
      login: logins.get(githubId) ?? rows[0].github_login ?? `user ${githubId}`,
      total: rows.length,
      domains: [...counts.entries()]
        .map(([key, e]) => ({ key, label: domainLabel(key), n: e.n, confidence: rollup(e.confidences) }))
        .sort((a, b) => b.confidence - a.confidence || b.n - a.n),
      areas: new Set(rows.map((r) => r.area).filter(Boolean)).size,
      repos: new Set(rows.map((r) => r.repo_full_name).filter(Boolean)).size,
      lastAt: rows.map((r) => r.demonstrated_at).sort().at(-1) ?? null,
    });
  }
  return out.sort((a, b) => b.total - a.total);
}

// ── Collection health ──────────────────────────────────────────────────────────────────────

function has(rows: object[], col: string): boolean {
  return rows.length === 0 || rows.some((r) => col in r);
}

function ageDays(iso: string | null | undefined, now: Date): number | null {
  return iso ? daysBetween(iso, now) : null;
}

/**
 * Every finding here is DERIVED from data that is present, because the thing we are checking for
 * is data that is absent. Background handler failures are logged to the process and nowhere else,
 * so the only way to see a dropped write after the fact is to look for its shadow: a passed gate
 * with no demonstrations, an attempt that graded PASS on a checkpoint that never flipped, a
 * demonstration whose owner has no identity row.
 */
export function health(s: Snapshot, now = new Date()): Finding[] {
  const f: Finding[] = [];
  const repoNames = repoNameById(s);

  for (const u of s.unreadable) {
    f.push({
      severity: u.table === 'mcp_events' ? 'warning' : 'critical',
      title: `Table \`${u.table}\` could not be read`,
      detail: u.reason,
      fix: u.table === 'mcp_events'
        ? 'Expected if the reckon-mcp host was never deployed. Nothing in this repo writes mcp_events, so the dev-time half of the cross-surface record is empty by construction, not by failure.'
        : 'Apply db/schema.sql in the Supabase SQL editor, then re-run.',
    });
  }

  // Migration drift. The app degrades to the old column set rather than failing, which is right
  // for uptime and invisible without this check.
  const cps = s.checkpoints as object[];
  for (const col of ['areas', 'files', 'skip_reason', 'author_id', 'hub_count'] as const) {
    if (cps.length && !has(cps, col)) {
      f.push({
        severity: col === 'areas' ? 'critical' : 'serious',
        title: `checkpoints.${col} is missing`,
        detail: col === 'areas'
          ? 'Without areas there is no subsystem spine, so the knowledge map cannot be built at all and freshness has no drift signal.'
          : 'The app is silently falling back to the pre-migration column set on every write.',
        fix: 'Apply db/schema.sql in the Supabase SQL editor.',
      });
    }
  }
  const dems = s.demonstrations as object[];
  for (const col of ['area', 'domains'] as const) {
    if (dems.length && !has(dems, col)) {
      f.push({
        severity: 'serious',
        title: `demonstrations.${col} is missing`,
        detail: `Demonstrations are being written without their ${col === 'area' ? 'subsystem' : 'domain'} tag, so they cannot be placed on the map.`,
        fix: 'Apply db/schema.sql in the Supabase SQL editor. Existing rows cannot be backfilled: the inputs (changed paths, explanation text) are not retained.',
      });
    }
  }

  // Rows written before the collection fix landed. Not an error, but they are invisible on the
  // map and would otherwise read as "these areas were never touched".
  const untagged = s.checkpoints.filter((c) => 'areas' in (c as object) && (c.areas ?? []).length === 0 && c.status !== 'trivial');
  if (untagged.length) {
    f.push({
      severity: 'warning',
      title: 'Checkpoints with no area tag',
      count: untagged.length,
      ...refsFor(untagged, repoNames),
      detail: 'Substantive checkpoints carrying no areas. Expected for anything recorded before area tagging shipped; these contribute no drift and appear nowhere on the map.',
      fix: 'Backfillable: areas derive from files, so any row that has files can be recomputed with areasFor(). Rows with neither are lost.',
    });
  }

  // Skip outcomes never recorded. The signature of a deploy predating the skip rows.
  const anySkips = s.checkpoints.some((c) => ['trivial', 'peripheral', 'capped'].includes(c.status));
  if (s.checkpoints.length > 0 && !anySkips) {
    f.push({
      severity: 'warning',
      title: 'No skipped-PR outcomes recorded',
      detail: 'Every checkpoint is a gate. Trivial, peripheral and rate-capped PRs are being decided and thrown away, so the denominator of the funnel (PRs Reckon actually saw) is unknown.',
      fix: 'Ships with this change. If it persists after deploy, the skip writes are failing.',
    });
  }

  // Installs that never produced a repo row.
  const reposByInstall = new Map<number, number>();
  for (const r of s.repos) reposByInstall.set(r.installation_id, (reposByInstall.get(r.installation_id) ?? 0) + 1);
  const emptyInstalls = s.installations.filter((i) => !reposByInstall.get(i.id));
  if (emptyInstalls.length) {
    f.push({
      severity: 'warning',
      title: 'Installations with no repos recorded',
      count: emptyInstalls.length,
      detail: emptyInstalls.map((i) => i.account_login).join(', '),
      fix: 'Expected for an install granted zero repositories. Otherwise the installation webhook did not persist its repo list.',
    });
  }

  // THE WEDGE SIGNATURE: an explanation graded PASS whose gate never flipped to passed. Means
  // the handler died between the grade and the state write.
  const cpById = new Map(s.checkpoints.map((c) => [c.id, c]));
  const wedged = s.attempts.filter((a) => a.grade_pass && !a.ungraded && cpById.get(a.checkpoint_id)?.status !== 'passed');
  if (wedged.length) {
    f.push({
      severity: 'critical',
      title: 'Passing explanations on gates that never opened',
      count: wedged.length,
      ...refsFor(wedged.map((a) => cpById.get(a.checkpoint_id)!).filter(Boolean), repoNames),
      detail: `${wedged.length} attempt(s) graded PASS while their checkpoint is still not 'passed'. Someone explained the change correctly and stayed blocked.`,
      fix: 'The pass path (checkpoint flip, closeout, comment) threw partway. Check the process logs around those timestamps.',
    });
  }

  // A gate cannot pass without an explanation arriving, so a passed checkpoint with no attempt
  // row means the attempt write was lost. This is also what makes the funnel non-monotonic
  // (more passed than answered), so the funnel points here rather than printing a nonsense rate.
  const answeredIds = new Set(s.attempts.map((a) => a.checkpoint_id));
  const passedNoAttempt = s.checkpoints.filter((c) => c.status === 'passed' && !answeredIds.has(c.id));
  if (passedNoAttempt.length) {
    f.push({
      severity: 'critical',
      title: 'Passed gates with no explanation recorded',
      count: passedNoAttempt.length,
      ...refsFor(passedNoAttempt, repoNames),
      detail: `${passedNoAttempt.length} gate(s) flipped to passed with no attempt row. A gate cannot pass without an explanation, so the explanation was graded and then lost.`,
      fix: 'recordAttempt failed while the pass path continued. Losing these also breaks cumulative grading on any gate still open, since prior rounds are read back from this table.',
    });
  }

  // Passed gates that produced no durable record.
  const demoKeys = new Set(s.demonstrations.map((d) => `${d.repo_full_name}#${d.pr_number}`));
  const passedNoDemos = s.checkpoints.filter((c) => c.status === 'passed' && !demoKeys.has(`${repoNames.get(c.repo_id)}#${c.pr_number}`));
  if (passedNoDemos.length) {
    f.push({
      severity: 'serious',
      title: 'Passed gates with no demonstrations',
      count: passedNoDemos.length,
      ...refsFor(passedNoDemos, repoNames),
      detail: `${passedNoDemos.length} of ${s.checkpoints.filter((c) => c.status === 'passed').length} passed gates wrote no durable record. That understanding is not on anyone's map.`,
      fix: 'The durable-record write is best-effort and swallowed. Most likely the demonstrations table or one of its columns was absent at the time.',
    });
  }

  // Passed gates with no closeout: the per-topic verdicts are the strength input to the map, so
  // without them every demonstration falls back to the unverdicted default.
  const passed = s.checkpoints.filter((c) => c.status === 'passed');
  const noCloseout = passed.filter((c) => !c.closeout);
  if (noCloseout.length) {
    f.push({
      severity: noCloseout.length === passed.length && passed.length > 0 ? 'serious' : 'warning',
      title: 'Passed gates with no closeout',
      count: noCloseout.length,
      ...refsFor(noCloseout, repoNames),
      detail: `${noCloseout.length} of ${passed.length} passed gates have no per-topic read, so those demonstrations carry no verdict and score at the neutral default rather than strong/solid/thin.`,
      fix: 'Either the closeout column was missing, or the closeout model call failed or returned unparseable JSON.',
    });
  }

  // Demonstrations whose owner has no identity row.
  const userIds = new Set(s.users.map((u) => u.github_id));
  const orphanDemos = s.demonstrations.filter((d) => !userIds.has(d.github_id));
  if (orphanDemos.length) {
    f.push({
      severity: 'serious',
      title: 'Demonstrations with no user row',
      count: orphanDemos.length,
      detail: `${new Set(orphanDemos.map((d) => d.github_id)).size} identity(ies) have a record but no users row, so the cross-surface join has nothing to anchor to.`,
      fix: 'upsertUser failed while the demonstration insert succeeded. Re-upsert those github_ids.',
    });
  }

  // Gates nobody answered. Product signal, not a bug: the gate is being ignored.
  const abandoned = s.checkpoints.filter((c) => c.status === 'pending' && !answeredIds.has(c.id) && (ageDays(c.created_at, now) ?? 0) > 7);
  if (abandoned.length) {
    f.push({
      severity: 'warning',
      title: 'Gates open over a week with no reply',
      count: abandoned.length,
      ...refsFor(abandoned, repoNames),
      detail: 'Opened, commented on, and never answered. Either the PR was abandoned, or the gate is being routed around.',
      fix: 'Not a data bug. Worth checking whether those PRs merged anyway, which would mean the ruleset is not enforcing.',
    });
  }

  // A gate with no topics is a gate asking nothing.
  const emptyDecisions = s.checkpoints.filter((c) => GATED.has(c.status) && Array.isArray(c.decisions) && c.decisions.length === 0);
  if (emptyDecisions.length) {
    f.push({
      severity: 'serious',
      title: 'Gates opened with zero decisions',
      count: emptyDecisions.length,
      ...refsFor(emptyDecisions, repoNames),
      detail: 'decompose returned nothing, so the elicit comment listed no topics and the grader had no ground truth to score against.',
      fix: 'Check the decompose backend for errors or truncation on those PRs.',
    });
  }

  // Cross-surface: events that cannot be joined to a person.
  const unjoined = s.mcpEvents.filter((e) => !e.github_id);
  if (unjoined.length) {
    f.push({
      severity: 'warning',
      title: 'MCP events with no github_id',
      count: unjoined.length,
      detail: 'Dev-time events arrived without a resolved identity, so they join to nobody and cannot appear on any personal record.',
      fix: 'The MCP host is not resolving the GitHub numeric id before forwarding.',
    });
  }
  if (!s.unreadable.some((u) => u.table === 'mcp_events') && s.mcpEvents.length === 0) {
    f.push({
      severity: 'warning',
      title: 'No dev-time (MCP) events at all',
      detail: 'The mcp_events table exists and is empty. The cross-surface record is merge-time only; nothing in this repo ever writes it.',
      fix: 'Expected unless the reckon-mcp host is deployed and forwarding. Worth confirming which you intend.',
    });
  }

  // Pipeline staleness: is anything arriving at all?
  const last = (rows: { created_at?: string; demonstrated_at?: string }[]): string | null =>
    rows.map((r) => r.created_at ?? r.demonstrated_at ?? '').filter(Boolean).sort().at(-1) ?? null;
  const lastCp = last(s.checkpoints);
  const lastAge = ageDays(lastCp, now);
  if (s.checkpoints.length > 0 && lastAge !== null && lastAge > 14) {
    f.push({
      severity: 'warning',
      title: 'No new checkpoints in over two weeks',
      detail: `Most recent checkpoint is ${Math.round(lastAge)} days old. Either nothing is being opened, or webhooks stopped arriving.`,
      fix: 'Check the GitHub App webhook deliveries and that the service is up.',
    });
  }

  if (f.length === 0) {
    f.push({ severity: 'ok', title: 'No collection anomalies found', detail: 'Every derived consistency check passed against the current snapshot.', fix: '' });
  }
  return f.sort((a, b) => ({ critical: 0, serious: 1, warning: 2, ok: 3 })[a.severity] - ({ critical: 0, serious: 1, warning: 2, ok: 3 })[b.severity]);
}

/** One repo's architecture, straight out of the codebase graph, with the map laid over it. */
export interface Architecture {
  repo: string;
  nodes: AreaNode[];
  edges: AreaEdge[];
  truncated: boolean;
  omitted: number;
  /** Which commit the diagram is OF, and when. A diagram is a snapshot, not a standing fact. */
  headSha: string;
  builtAt: string;
}

export interface ReportModel {
  snapshot: Snapshot;
  funnel: Funnel;
  areas: AreaSummary[];
  architectures: Architecture[];
  profiles: DomainProfile[];
  findings: Finding[];
  generatedAt: string;
}

export function build(s: Snapshot, now = new Date()): ReportModel {
  return {
    snapshot: s,
    funnel: funnel(s),
    areas: knowledgeMap(s, now),
    architectures: architectures(s),
    profiles: domainProfiles(s, now),
    findings: health(s, now),
    generatedAt: now.toISOString(),
  };
}
