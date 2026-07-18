/**
 * Handler integration test: drives onPullRequestOpened + onIssueComment with a FAKE octokit
 * (records check/comment calls) against the REAL Supabase store + gpt-5.4-mini grader.
 * Proves the orchestration — not just that it type-checks. Uses test ids, cleans up.
 */
import { onPullRequestOpened, onIssueComment, type Deps } from './handlers.js';
import { loadConfig } from './config.js';
import { OpenAiBackend } from './grader/openai.js';
import { SupabaseStore } from './store/supabase.js';

const INST = 999000011, REPO = 999000012, PR = 77;

const diff = `PR — resilient webhook delivery.
1. Retry: replace fixed 1s retry with exponential backoff (1s,2s,4s,8s)+jitter — a fixed
   interval synchronizes failing senders into a thundering herd against a recovering
   consumer; backoff+jitter spreads retries so a downed consumer isn't re-hammered in lockstep.
2. Idempotency: attach a delivery UUID and dedupe on the consumer so a retried delivery after
   a timeout doesn't double-process.`;
const good = `A fixed 1s retry makes every sender that failed together retry in lockstep, so the
moment the downed consumer recovers the whole fleet hits it at once and it falls over again —
a self-inflicted thundering herd. Backoff+jitter desynchronizes them: each waits a growing
randomized interval, spreading load over time. The delivery UUID lets the consumer dedupe so a
timeout-triggered retry of an already-processed delivery can't double-apply. Cost is worse
worst-case latency, fine because never-recovering is worse.`;
const slop = `It swaps the fixed 1s retry for exponential backoff with 1,2,4,8s + jitter and
adds a UUID for idempotency. So it backs off exponentially and dedupes. More robust and modern.`;

function fakeOctokit(files: string[]) {
  const calls = { checksCreated: [] as any[], checksUpdated: [] as any[], comments: [] as string[] };
  const octokit = {
    pulls: { get: async () => ({ data: diff }), listFiles: 'listFiles' },
    paginate: async () => files.map((f) => ({ filename: f })),
    checks: {
      create: async (a: any) => { calls.checksCreated.push(a); return { data: { id: 555 } }; },
      update: async (a: any) => { calls.checksUpdated.push(a); return { data: {} }; },
    },
    issues: { createComment: async (a: any) => { calls.comments.push(a.body); return { data: { id: 1 } }; } },
  };
  return { octokit, calls };
}

const prCtx = (octokit: any) => ({ octokit, payload: {
  pull_request: { number: PR, node_id: 'PR_x', head: { sha: 'sha1' }, draft: false },
  repository: { id: REPO, name: 'roundtrip', full_name: 'reckon-test/roundtrip', default_branch: 'main', owner: { login: 'reckon-test', type: 'User' } },
  installation: { id: INST },
}});
const commentCtx = (octokit: any, body: string) => ({ octokit, payload: {
  issue: { number: PR, pull_request: {} },
  comment: { body, id: 9, user: { login: 'alice', id: 1, type: 'User' }, author_association: 'MEMBER' },
  repository: { id: REPO, name: 'roundtrip', owner: { login: 'reckon-test' } },
}});

async function main() {
  const cfg = loadConfig();
  const store = new SupabaseStore(cfg.supabaseUrl, cfg.supabaseSecretKey);
  const deps: Deps = { store, backend: new OpenAiBackend(cfg.openaiApiKey, cfg.graderModel), rigor: 'medium' };
  let failed = false;
  const step = (ok: boolean, label: string, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`); if (!ok) failed = true; };

  await store.deleteInstallation(INST).catch(() => {});
  console.log(`grader model: ${cfg.graderModel}\n`);

  // 1. PR opened
  const o1 = fakeOctokit(['src/webhook.ts']);
  await onPullRequestOpened(prCtx(o1.octokit), deps);
  const cp = await store.findPendingCheckpoint(REPO, PR);
  step(!!cp && cp.status === 'pending', 'PR opened → pending checkpoint persisted');
  step(o1.calls.checksCreated.length === 1 && o1.calls.checksCreated[0].status === 'in_progress', 'pending (merge-blocking) check created');
  step(o1.calls.comments.length === 1 && /explain to merge/i.test(o1.calls.comments[0]), 'elicit comment posted');

  // 2. SLOP comment → fail → rescue, stays blocked
  const o2 = fakeOctokit([]);
  await onIssueComment(commentCtx(o2.octokit, slop), deps);
  const stillPending = await store.findPendingCheckpoint(REPO, PR);
  step(!!stillPending, 'SLOP → checkpoint still pending (merge stays blocked)');
  step(!o2.calls.checksUpdated.some((c) => c.conclusion === 'success'), 'SLOP → check NOT flipped to success');
  step(o2.calls.comments.some((b) => /one more pass/i.test(b)), 'SLOP → rescue reply posted');

  // 3. GOOD comment → pass → flip check + mark passed
  const o3 = fakeOctokit([]);
  await onIssueComment(commentCtx(o3.octokit, good), deps);
  step(o3.calls.checksUpdated.some((c) => c.conclusion === 'success'), 'GOOD → check flipped to success');
  const after = await store.getCheckpoint(cp!.id);
  step(after?.status === 'passed' && after?.passed_by === 'alice', 'GOOD → checkpoint marked passed by alice');
  step(o3.calls.comments.some((b) => /comprehension passed/i.test(b)), 'GOOD → pass comment posted');

  await store.deleteInstallation(INST); // cascade cleanup
  console.log(`\n==> HANDLERS: ${failed ? 'FAIL' : 'PASS — full PR gate flow works (pending → rescue → pass)'}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('handler-test error:', e?.message || e); process.exit(1); });
