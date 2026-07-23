/**
 * Handler integration test: drives onPullRequestOpened + onIssueComment with a FAKE octokit
 * (records check/comment calls) against the REAL Supabase store + gpt-5.4-mini grader.
 * Proves the orchestration — not just that it type-checks. Uses test ids, cleans up.
 */
import { onPullRequestOpened, onIssueComment, onInstallation, type Deps } from './handlers.js';
import { loadConfig } from './config.js';
import { OpenAiBackend } from './grader/openai.js';
import { SupabaseStore } from './store/supabase.js';

const INST = 999000011, REPO = 999000012, PR = 77;

// A real unified diff (has +/- lines so classify() sees a substantive change).
const diff = `diff --git a/src/webhook.ts b/src/webhook.ts
@@ -10,7 +10,14 @@ export async function deliver(msg: Msg) {
-  await retryAfter(1000); // fixed 1s retry
+  // Exponential backoff (1s,2s,4s,8s) + jitter: a fixed interval synchronizes all failing
+  // senders into a thundering herd against a recovering consumer; backoff+jitter spreads
+  // retries so a downed consumer isn't re-hammered in lockstep.
+  await retryAfter(backoffWithJitter(attempt));
+  // Idempotency: attach a delivery UUID and dedupe on the consumer so a retried delivery
+  // after a timeout doesn't double-process.
+  msg.deliveryId = msg.deliveryId ?? randomUUID();
+  await consumer.send(msg);`;
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

// A fake octokit for the install path: an in-memory rulesets table its `request` honors, so
// GET reflects prior POSTs — enough to prove find-or-create idempotency without a network.
function fakeInstallOctokit() {
  const rulesets: any[] = [];
  const calls = { gets: 0, posts: 0 };
  const octokit = {
    request: async (route: string, params: any) => {
      if (route.startsWith('GET')) { calls.gets++; return { data: rulesets }; }
      if (route.startsWith('POST')) { calls.posts++; rulesets.push({ id: rulesets.length + 1, name: params.name }); return { data: rulesets.at(-1) }; }
      throw new Error(`unexpected route ${route}`);
    },
  };
  return { octokit, calls, rulesets };
}
const installCtx = (octokit: any, repos: any[]) => ({
  octokit,
  log: { warn: () => {} },
  payload: { installation: { id: INST, account: { login: 'reckon-test' } }, repositories: repos },
});

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
  const deps: Deps = { store, backend: new OpenAiBackend(cfg.openaiApiKey, cfg.graderModel), rigor: 'medium', dailyPerInstall: 1000, dailyGlobal: 10000 };
  let failed = false;
  const step = (ok: boolean, label: string, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`); if (!ok) failed = true; };

  await store.deleteInstallation(INST).catch(() => {});
  console.log(`grader model: ${cfg.graderModel}\n`);

  // 0. Install → auto-configure the merge-gating ruleset (no network; fake octokit).
  const i1 = fakeInstallOctokit();
  await onInstallation(installCtx(i1.octokit, [{ full_name: 'reckon-test/roundtrip', name: 'roundtrip' }]), deps);
  step(i1.calls.posts === 1 && i1.rulesets.length === 1, 'install → managed ruleset created (gates by default)');
  await onInstallation(installCtx(i1.octokit, [{ full_name: 'reckon-test/roundtrip', name: 'roundtrip' }]), deps);
  step(i1.calls.posts === 1, 'install redelivery → idempotent (no duplicate ruleset)');
  const iErr = { request: async (r: string) => { if (r.startsWith('GET')) return { data: [] }; throw new Error('403'); } };
  let threw = false;
  await onInstallation(installCtx(iErr, [{ full_name: 'reckon-test/roundtrip', name: 'roundtrip' }]), deps).catch(() => { threw = true; });
  step(!threw, 'install with no admin permission → degrades to advisory (does not throw)');

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
  // Match the rescue's STABLE closing line, not the rotating header (which is seeded off the
  // hole text and varies with the decomposition — asserting a specific header is brittle).
  step(o2.calls.comments.some((b) => /give it one more go right here/i.test(b)), 'SLOP → rescue reply posted');

  // 3. GOOD comment → pass → flip check + mark passed
  const o3 = fakeOctokit([]);
  await onIssueComment(commentCtx(o3.octokit, good), deps);
  step(o3.calls.checksUpdated.some((c) => c.conclusion === 'success'), 'GOOD → check flipped to success');
  const after = await store.getCheckpoint(cp!.id);
  step(after?.status === 'passed' && after?.passed_by === 'alice', 'GOOD → checkpoint marked passed by alice');
  step(o3.calls.comments.some((b) => /you explained it\. merge unblocked/i.test(b)), 'GOOD → pass comment posted');

  await store.deleteInstallation(INST); // cascade cleanup
  console.log(`\n==> HANDLERS: ${failed ? 'FAIL' : 'PASS — full PR gate flow works (pending → rescue → pass)'}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('handler-test error:', e?.message || e); process.exit(1); });
