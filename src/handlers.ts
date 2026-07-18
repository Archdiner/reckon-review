/**
 * The two webhook handlers — the glue between GitHub events and the proven core/store/grader.
 *
 *   pull_request.opened  → diff → (trivial? pass) → decompose → pending check + elicit comment
 *   issue_comment.created → find pending checkpoint → gradePlan → pass: flip check + mark passed
 *                                                                fail: rescue reply (stays blocked)
 */
import { decompose, gradePlan } from '@reckon/core';
import type { Decision } from '@reckon/core';
import type { LlmBackend } from '@reckon/core';
import { SupabaseStore } from './store/supabase.js';
import * as gh from './github.js';
import { elicitBody, rescueBody, passBody, ungradedBody } from './format.js';
import { hash, classify, decisionsToGroundTruth } from './util.js';

export interface Deps {
  store: SupabaseStore;
  backend: LlmBackend;
  rigor: 'medium' | 'harsh';
}

// Only treat comments from someone with review standing as explanation attempts.
const REVIEWER_ASSOC = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Persist the FK parents (installation + repo). Idempotent; safe to call on any event. */
async function upsertParents(context: any, deps: Deps): Promise<void> {
  const repository = context.payload.repository;
  const installation = context.payload.installation;
  if (!installation) return;
  await deps.store.upsertInstallation({
    id: installation.id,
    account_login: repository.owner.login,
    account_type: repository.owner.type || 'Organization',
  });
  await deps.store.upsertRepo({
    id: repository.id,
    installation_id: installation.id,
    full_name: repository.full_name,
    default_branch: repository.default_branch,
  });
}

/** Open a fresh comprehension gate on a PR's current head: pending check + checkpoint + elicit. */
async function openGate(context: any, deps: Deps): Promise<void> {
  const pr = context.payload.pull_request;
  const repository = context.payload.repository;
  const owner = repository.owner.login;
  const repo = repository.name;
  const octokit = context.octokit;

  const files = await gh.fetchFiles(octokit, owner, repo, pr.number);
  const diff = await gh.fetchDiff(octokit, owner, repo, pr.number);
  const cls = classify(files, diff);
  if (cls.trivial) {
    await gh.createSuccessCheck(octokit, owner, repo, pr.head.sha, 'Trivial — no comprehension needed', cls.reason);
    return;
  }

  const d = await decompose(diff, deps.backend);
  const decisions: Decision[] = d.ok ? d.decisions : [];
  const check_run_id = await gh.createPendingCheck(octokit, owner, repo, pr.head.sha);
  await deps.store.createCheckpoint({
    repo_id: repository.id, pr_number: pr.number, pr_node_id: pr.node_id, head_sha: pr.head.sha,
    check_run_id, decisions, decisions_hash: hash(JSON.stringify(decisions)), rigor: deps.rigor,
  });
  await gh.postComment(octokit, owner, repo, pr.number, elicitBody(decisions));
}

export async function onPullRequestOpened(context: any, deps: Deps): Promise<void> {
  if (context.payload.pull_request.draft) return; // wait for ready_for_review
  await upsertParents(context, deps);
  await openGate(context, deps);
}

/**
 * A new push to the PR (D3). Re-decompose; if the load-bearing decisions are UNCHANGED since
 * a prior pass, carry that pass forward onto the new head (don't re-quiz on a typo fix). If
 * they changed (or it never passed), re-gate on the new head — this closes the
 * "pass then push slop" hole.
 */
export async function onPullRequestSynchronize(context: any, deps: Deps): Promise<void> {
  const pr = context.payload.pull_request;
  if (pr.draft) return;
  const repository = context.payload.repository;
  const owner = repository.owner.login;
  const repo = repository.name;
  const octokit = context.octokit;
  await upsertParents(context, deps);

  const files = await gh.fetchFiles(octokit, owner, repo, pr.number);
  const diff = await gh.fetchDiff(octokit, owner, repo, pr.number);
  const cls = classify(files, diff);
  if (cls.trivial) {
    await gh.createSuccessCheck(octokit, owner, repo, pr.head.sha, 'Trivial — no comprehension needed', cls.reason);
    return;
  }

  const d = await decompose(diff, deps.backend);
  const decisions: Decision[] = d.ok ? d.decisions : [];
  const newHash = hash(JSON.stringify(decisions));
  const latest = await deps.store.findLatestCheckpoint(repository.id, pr.number);

  if (latest && latest.status === 'passed' && latest.decisions_hash === newHash) {
    await gh.createSuccessCheck(octokit, owner, repo, pr.head.sha, 'Comprehension carried forward', 'Load-bearing decisions unchanged since the passing explanation.');
    await deps.store.updateCheckpointHead(latest.id, pr.head.sha);
    return;
  }

  // Decisions changed, or never passed → re-gate on the new head.
  const check_run_id = await gh.createPendingCheck(octokit, owner, repo, pr.head.sha);
  await deps.store.createCheckpoint({
    repo_id: repository.id, pr_number: pr.number, pr_node_id: pr.node_id, head_sha: pr.head.sha,
    check_run_id, decisions, decisions_hash: newHash, rigor: deps.rigor,
  });
  await gh.postComment(octokit, owner, repo, pr.number, elicitBody(decisions));
}

export async function onIssueComment(context: any, deps: Deps): Promise<void> {
  const payload = context.payload;
  if (!payload.issue.pull_request) return; // not a PR
  if (payload.comment.user.type === 'Bot') return; // ignore our own / other bots
  if (!REVIEWER_ASSOC.has(payload.comment.author_association)) return; // must have review standing
  const explanation: string = payload.comment.body || '';
  if (explanation.trim().length < 40) return; // ignore "lgtm"-style chatter

  const repository = payload.repository;
  const owner = repository.owner.login;
  const repo = repository.name;
  const octokit = context.octokit;
  const pr_number = payload.issue.number;

  const cp = await deps.store.findPendingCheckpoint(repository.id, pr_number);
  if (!cp) return; // no open gate → nothing to grade

  const decisions = (Array.isArray(cp.decisions) ? cp.decisions : []) as Decision[];
  const g = await gradePlan({
    groundTruth: decisionsToGroundTruth(decisions),
    explanation,
    rigor: cp.rigor as 'medium' | 'harsh',
    decisions,
    backend: deps.backend,
  });

  await deps.store.recordAttempt({
    checkpoint_id: cp.id,
    reviewer_login: payload.comment.user.login,
    reviewer_id: payload.comment.user.id,
    comment_id: payload.comment.id,
    explanation,
    assisted: true, // the diff is always on screen on GitHub
    grade_pass: g.pass,
    ungraded: g.ungraded,
    scores: { covered: g.covered, missing: g.missing },
    overlap: 'unknown',
    hole: g.hole,
  });

  if (g.ungraded) {
    if (cp.check_run_id) await gh.setCheckNeutral(octokit, owner, repo, cp.check_run_id, g.note || 'grader unavailable');
    await gh.postComment(octokit, owner, repo, pr_number, ungradedBody(g.note || 'grader unavailable'));
    return;
  }

  if (g.pass) {
    if (cp.check_run_id) {
      await gh.setCheckSuccess(octokit, owner, repo, cp.check_run_id, `Explained by @${payload.comment.user.login}.`);
    }
    await deps.store.markCheckpointPassed(cp.id, {
      passed_by: payload.comment.user.login,
      passed_by_id: payload.comment.user.id,
    });
    await gh.postComment(octokit, owner, repo, pr_number, passBody(payload.comment.user.login));
  } else {
    // Stay blocked (check remains in_progress); offer the single hole.
    await gh.postComment(octokit, owner, repo, pr_number, rescueBody(g.hole));
  }
}
