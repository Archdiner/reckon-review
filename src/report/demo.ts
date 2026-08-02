/**
 * `npm run report:demo` — render the report against a synthetic snapshot, no database needed.
 *
 * Two jobs. It is how the layout gets eyeballed without pointing at production, and it is a
 * worked example of what the map looks like once the collection fixes have been live for a
 * while: every area status, a stale demonstration decayed by drift, and a couple of the health
 * findings firing, so the page can be reviewed before there is enough real data to fill it.
 */
import { writeFileSync } from 'node:fs';
import { build } from './model.js';
import { renderReport } from './render.js';
import type { Snapshot } from './query.js';

const NOW = new Date('2026-08-02T12:00:00Z');
const day = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

let cpSeq = 0;
function cp(o: Partial<Snapshot['checkpoints'][number]> & { areas: string[]; daysAgo: number }): any {
  const { daysAgo, ...rest } = o;
  return {
    id: `cp-${++cpSeq}`, repo_id: 1, pr_number: 100 + cpSeq, head_sha: `sha${cpSeq}`,
    status: 'passed', skip_reason: null, files: [], hub_count: 0, core_count: 1,
    graph_used: true, graph_ms: 900, author_login: 'archdiner', author_id: 11,
    decisions: [{ concept: 'x', summary: 'y' }], rigor: 'medium', closeout: { topics: [] },
    passed_by: 'archdiner', passed_by_id: 11, passed_at: day(daysAgo),
    created_at: day(daysAgo), updated_at: day(daysAgo), ...rest,
  };
}

let demSeq = 0;
function dem(github_id: number, login: string, area: string, verdict: string | null, daysAgo: number, concept: string, domains: string[]): any {
  return {
    id: `d-${++demSeq}`, github_id, github_login: login, concept, summary: concept,
    verdict, note: '', area, domains, repo_full_name: 'archdiner/reckon-review',
    pr_number: 200 + demSeq, head_sha: 'abc', demonstrated_at: day(daysAgo),
  };
}

const snapshot: Snapshot = {
  installations: [
    { id: 1, account_login: 'archdiner', account_type: 'User', suspended_at: null, created_at: day(120) },
    { id: 2, account_login: 'example-org', account_type: 'Organization', suspended_at: null, created_at: day(9) },
  ],
  repos: [
    // The `areas` naming map a repo can set in .reckon.yml, applied at render time.
    { id: 1, installation_id: 1, full_name: 'archdiner/reckon-review', default_branch: 'main', created_at: day(120),
      config: { areas: { graph: 'Codebase graph', handlers: 'Gate pipeline', store: 'Persistence', knowledge: 'Knowledge model' } } },
  ],
  checkpoints: [
    // The gate pipeline is hot: lots of recent change, which is what decays understanding of it.
    ...[2, 5, 8, 11, 14, 20, 26, 33, 40].map((d) => cp({ areas: ['handlers'], daysAgo: d })),
    ...[3, 17, 44].map((d) => cp({ areas: ['graph'], daysAgo: d })),
    ...[6, 29].map((d) => cp({ areas: ['store'], daysAgo: d })),
    cp({ areas: ['knowledge'], daysAgo: 1 }),
    cp({ areas: ['grader'], daysAgo: 55 }),
    // Nobody has ever explained the closeout, and it keeps changing.
    ...[4, 12, 31].map((d) => cp({ areas: ['closeout'], daysAgo: d })),
    // Skips: recorded, cost nothing, and give the funnel its denominator.
    ...[1, 2, 3, 7, 9, 13].map((d) => cp({ areas: [], daysAgo: d, status: 'trivial', skip_reason: 'only docs/lockfile/generated files', decisions: [] })),
    ...[4, 10].map((d) => cp({ areas: ['styles'], daysAgo: d, status: 'peripheral', skip_reason: 'only styles/assets/tests/config/docs changed', decisions: [] })),
    cp({ areas: ['handlers'], daysAgo: 15, status: 'capped', skip_reason: 'install daily beta limit reached', decisions: [] }),
    // Open and unanswered for a fortnight: the gate being routed around.
    cp({ areas: ['handlers'], daysAgo: 16, status: 'pending', passed_by: null, passed_by_id: null, passed_at: null, closeout: null }),
  ],
  // A passed gate always has at least one attempt behind it, so the fixture builds them from the
  // passed checkpoints rather than hand-listing a few. Two of them took a second round.
  attempts: [],
  users: [
    { github_id: 11, github_login: 'archdiner', email: null, first_seen: day(120), last_seen: day(1) },
    { github_id: 22, github_login: 'sam', email: null, first_seen: day(60), last_seen: day(6) },
  ],
  demonstrations: [
    dem(11, 'archdiner', 'handlers', 'strong', 2, 'webhook-idempotency', ['distributed-systems', 'error-handling']),
    dem(11, 'archdiner', 'handlers', 'solid', 40, 'carry-forward-hash', ['state-and-lifecycle']),
    dem(22, 'sam', 'handlers', 'solid', 6, 'background-ack', ['concurrency-and-async', 'distributed-systems']),
    dem(11, 'archdiner', 'graph', 'strong', 17, 'pagerank-personalization', ['algorithms', 'performance']),
    dem(11, 'archdiner', 'graph', 'thin', 44, 'ambiguity-cap', ['algorithms']),
    // Explained long ago, and the area has moved twice since: the drift case.
    dem(22, 'sam', 'store', 'solid', 95, 'cascade-purge', ['data-modeling', 'security']),
    dem(11, 'archdiner', 'knowledge', 'strong', 1, 'two-axis-taxonomy', ['data-modeling']),
    dem(22, 'sam', 'grader', 'solid', 55, 'cross-vendor-grading', ['api-contracts']),
  ],
  mcpEvents: [],
  unreadable: [],
  fetchedAt: NOW.toISOString(),
};

// Point each demonstration at a real passed checkpoint in the same area, so provenance lines up
// the way it does in production. Two passed gates are deliberately left with no demonstration, so
// the "passed gates with no durable record" finding shows what a partial drop looks like.
const passedByArea = new Map<string, any[]>();
for (const c of snapshot.checkpoints) {
  if (c.status !== 'passed') continue;
  for (const a of c.areas ?? []) passedByArea.set(a, [...(passedByArea.get(a) ?? []), c]);
}
const used = new Map<string, number>();
for (const d of snapshot.demonstrations) {
  const pool = passedByArea.get(d.area!) ?? [];
  if (!pool.length) continue;
  const i = (used.get(d.area!) ?? 0) % pool.length;
  used.set(d.area!, i + 1);
  d.pr_number = pool[i].pr_number;
  d.head_sha = pool[i].head_sha;
}

let atSeq = 0;
for (const c of snapshot.checkpoints) {
  if (c.status !== 'passed') continue;
  const who = Number(c.id.slice(3)) % 3 === 0 ? { login: 'sam', id: 22 } : { login: 'archdiner', id: 11 };
  const rounds = Number(c.id.slice(3)) % 4 === 0 ? 2 : 1; // some gates take a second swing
  for (let r = 0; r < rounds; r++) {
    snapshot.attempts.push({
      id: `a-${++atSeq}`, checkpoint_id: c.id, reviewer_login: who.login, reviewer_id: who.id,
      explanation: '...', grade_pass: r === rounds - 1, ungraded: false,
      hole: r === rounds - 1 ? null : 'the mechanism, not the effect', created_at: c.created_at,
    });
  }
}

const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'reckon-report-demo.html';
const model = build(snapshot, NOW);
writeFileSync(out, renderReport(model), 'utf8');
console.log(`wrote ${out}`);
console.log(`  funnel: seen ${model.funnel.seen} -> gated ${model.funnel.gated} -> answered ${model.funnel.answered} -> passed ${model.funnel.passed}`);
for (const a of model.areas) console.log(`  ${a.statusIcon} ${a.label.padEnd(18)} ${a.statusLabel.padEnd(13)} conf=${a.teamConfidence.toFixed(2)} demos=${a.demos} changes=${a.changes}`);
for (const f of model.findings) console.log(`  [${f.severity.toUpperCase()}] ${f.title}${f.count ? ` (${f.count})` : ''}`);
