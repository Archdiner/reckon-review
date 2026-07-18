/**
 * Live round-trip: proves Supabase persistence + the gpt-5.4-mini grader + @reckon/core
 * all work together with real credentials. Mirrors the real flow:
 *   upsert install/repo → decompose the diff → create pending checkpoint →
 *   grade a GOOD explanation (pass) → record attempt + mark passed →
 *   grade SLOP (fail) → record attempt → read back → cascade-clean.
 * Uses distinctive test ids and deletes them at the end (idempotent).
 */
import crypto from 'crypto';
import { grade, decompose } from '@reckon/core';
import { loadConfig } from './config.js';
import { OpenAiBackend } from './grader/openai.js';
import { SupabaseStore } from './store/supabase.js';

const TEST_INSTALL = 999000001;
const TEST_REPO = 999000002;
const PR = 412;

const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// Ground truth: a small two-decision PR (gives decompose real material).
const diff = `PR #412 — resilient webhook delivery.
1. Retry policy: replace the fixed 1s retry with exponential backoff (1s, 2s, 4s, 8s) plus
   jitter, because a fixed interval synchronizes all failing senders into a thundering herd
   against a recovering consumer; backoff + jitter spreads retries so a downed consumer is
   not re-hammered in lockstep.
2. Idempotency: attach a delivery UUID and dedupe on the consumer so a retried delivery
   after a timeout does not double-process.`;

const good = `The fixed 1s retry made every sender that failed at the same moment retry in
lockstep, so the instant a downed consumer recovered it got hit by the whole fleet at once
and fell over again — a self-inflicted thundering herd. Exponential backoff plus jitter
desynchronizes them: each sender waits a growing, randomized interval, spreading load over
time instead of one spike. And because a timeout can make us retry a delivery the consumer
already processed, the delivery UUID lets the consumer dedupe so retries can't double-apply.
The cost is higher worst-case delivery latency, which is fine — never recovering is worse.`;

const slop = `It changes the retry to exponential backoff with delays of 1, 2, 4, 8 seconds
and jitter instead of retrying every 1 second, and adds a UUID for idempotency. So it backs
off exponentially and dedupes. This is more robust and modern than the old approach.`;

async function main() {
  const cfg = loadConfig();
  const backend = new OpenAiBackend(cfg.openaiApiKey, cfg.graderModel);
  const store = new SupabaseStore(cfg.supabaseUrl, cfg.supabaseSecretKey);

  let failed = false;
  const step = (ok: boolean, label: string, extra = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
    if (!ok) failed = true;
  };

  console.log(`grader model: ${cfg.graderModel}\n`);
  await store.deleteInstallation(TEST_INSTALL).catch(() => {}); // clean any prior run

  // 1. FK parents
  await store.upsertInstallation({ id: TEST_INSTALL, account_login: 'reckon-test', account_type: 'User' });
  await store.upsertRepo({ id: TEST_REPO, installation_id: TEST_INSTALL, full_name: 'reckon-test/roundtrip' });
  step(true, 'installation + repo upserted');

  // 2. decompose via gpt-5.4-mini
  const d = await decompose(diff, backend);
  step(d.ok, 'decompose via gpt-5.4-mini', `${d.decisions.length} decision(s)`);

  // 3. create pending checkpoint
  const cp = await store.createCheckpoint({
    repo_id: TEST_REPO, pr_number: PR, pr_node_id: 'PR_test', head_sha: 'abc123def',
    decisions: d.decisions, decisions_hash: hash(JSON.stringify(d.decisions)), rigor: 'medium',
  });
  step(!!cp.id && cp.status === 'pending', 'checkpoint created (pending)', cp.id.slice(0, 8));

  // 4. find pending
  const pending = await store.findPendingCheckpoint(TEST_REPO, PR);
  step(pending?.id === cp.id, 'findPendingCheckpoint returns it');

  // 5. GOOD → pass → record + mark passed
  const g = await grade({ groundTruth: diff, explanation: good, rigor: 'medium', assisted: true, backend });
  step(g.pass && !g.ungraded, 'GOOD explanation graded PASS', `overlap=${g.overlap}`);
  await store.recordAttempt({
    checkpoint_id: cp.id, reviewer_login: 'alice', reviewer_id: 1, explanation: good,
    assisted: true, grade_pass: g.pass, ungraded: g.ungraded, scores: g.scores, overlap: g.overlap, hole: g.hole,
  });
  await store.markCheckpointPassed(cp.id, { passed_by: 'alice', passed_by_id: 1 });

  // 6. SLOP → fail → record (fail path)
  const b = await grade({ groundTruth: diff, explanation: slop, rigor: 'medium', assisted: true, backend });
  step(!b.pass && !b.ungraded, 'SLOP explanation graded FAIL', b.hole ? `hole: "${b.hole.slice(0, 48)}…"` : '');
  await store.recordAttempt({
    checkpoint_id: cp.id, reviewer_login: 'bob', reviewer_id: 2, explanation: slop,
    assisted: true, grade_pass: b.pass, ungraded: b.ungraded, scores: b.scores, overlap: b.overlap, hole: b.hole,
  });

  // 7. read back
  const after = await store.getCheckpoint(cp.id);
  step(after?.status === 'passed' && after?.passed_by === 'alice', 'checkpoint reads back as passed by alice');
  const n = await store.countAttempts(cp.id);
  step(n === 2, 'both attempts persisted', `count=${n}`);

  // 8. cascade cleanup
  await store.deleteInstallation(TEST_INSTALL);
  const gone = await store.getCheckpoint(cp.id);
  step(gone === null, 'cascade delete cleaned up test rows');

  console.log(`\n==> ROUND-TRIP: ${failed ? 'FAIL' : 'PASS — Supabase + gpt-5.4-mini grader + @reckon/core all live'}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('round-trip error:', e?.message || e);
  process.exit(1);
});
