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
import { elicitBody, rescueBody, passBody, ungradedBody, cappedBody } from './format.js';
import { closeout } from './closeout.js';
import { hash, classify, decisionsToGroundTruth } from './util.js';
import { diffDigest } from './diff-digest.js';
import { structuralContext } from './graph/context.js';
import { pathTier } from './graph/repo-map.js';
import { areaFor, areasFor } from './knowledge/areas.js';
import { resolveDomains } from './knowledge/domains.js';

export interface Deps {
  store: SupabaseStore;
  backend: LlmBackend;
  rigor: 'medium' | 'harsh';
  dailyPerInstall: number;
  dailyGlobal: number;
}

// Only treat comments from someone with review standing as explanation attempts.
const REVIEWER_ASSOC = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * The single subsystem a change is most about: the area with the most changed files, ties broken
 * alphabetically so the same PR always resolves the same way. Placing a demonstration on one box
 * keeps the map honest, since explaining a change that happened to touch six directories is not
 * evidence of understanding all six.
 */
function dominantArea(files: string[]): string | null {
  const counts = new Map<string, number>();
  for (const f of files) {
    const a = areaFor(f);
    if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Beta cost guardrail: which daily limit (if any) is hit, checked BEFORE the decompose call
 *  so a capped install costs no OpenAI. Counts new gates in a rolling 24h window. */
async function overLimit(context: any, deps: Deps): Promise<'install' | 'global' | null> {
  const installId = context.payload.installation?.id;
  if (!installId) return null;
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const [perInstall, global] = await Promise.all([
    deps.store.countInstallGatesSince(installId, since),
    deps.store.countGlobalGatesSince(since),
  ]);
  if (global >= deps.dailyGlobal) return 'global';
  if (perInstall >= deps.dailyPerInstall) return 'install';
  return null;
}

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

/**
 * THE GATE PIPELINE, one path for both `opened` and `synchronize`. These were two ~90% identical
 * copies; every change (the graph, the digest, both policies) had to be made twice, and any miss
 * meant a re-push silently behaved differently from the first open. One function, one behaviour.
 *
 * Every exit writes a row. A skipped PR used to leave no trace at all, which made the most basic
 * usage question ("of the PRs Reckon saw, how many did it gate, and why not the rest?")
 * unanswerable from the data. The skip rows cost no model call.
 */
async function runGate(context: any, deps: Deps): Promise<void> {
  const pr = context.payload.pull_request;
  const repository = context.payload.repository;
  const owner = repository.owner.login;
  const repo = repository.name;
  const octokit = context.octokit;

  // Idempotency: GitHub delivers webhooks at-least-once, so a delivery can arrive more than once
  // for the same PR head (redeliveries, retries). Without this guard the whole path — decompose +
  // pending check + elicit comment — runs again and double-posts, and the checkpoint insert trips
  // the (repo, pr, head) unique index and aborts the handler mid-way. Synchronize had no such
  // guard at all. If we already recorded an outcome for THIS exact head, this is a duplicate.
  const prior = await deps.store.findLatestCheckpoint(repository.id, pr.number);
  if (prior && prior.head_sha === pr.head.sha) return;

  const files = await gh.fetchFiles(octokit, owner, repo, pr.number);
  const diff = await gh.fetchDiff(octokit, owner, repo, pr.number);

  // What the change is ABOUT, recorded on every outcome. `areas` is the subsystem spine the
  // knowledge map is built on; without it a demonstration cannot be placed on the architecture,
  // and freshness has nothing to decay against.
  const common = {
    repo_id: repository.id, pr_number: pr.number, pr_node_id: pr.node_id, head_sha: pr.head.sha,
    files, areas: areasFor(files),
    author_login: pr.user?.login ?? null,
    author_id: pr.user?.type === 'Bot' ? null : (pr.user?.id ?? null),
    decisions: [], decisions_hash: hash('[]'), rigor: deps.rigor,
  };

  const cls = classify(files, diff);
  if (cls.trivial) {
    await gh.createSuccessCheck(octokit, owner, repo, pr.head.sha, 'Trivial — no comprehension needed', cls.reason);
    await deps.store.recordSkip({ ...common, status: 'trivial', skip_reason: cls.reason });
    return;
  }

  // Policy A (criticality → policy): a PR that touches only PERIPHERAL files — styles, assets,
  // tests, config, docs — with no source-logic file gets no comprehension gate. Path-based, so it
  // needs no graph fetch; any .ts/.js logic file tiers 'core' and still gates. "Don't quiz me on CSS."
  if (files.length > 0 && files.every((f) => pathTier(f) !== 'core')) {
    await gh.createSuccessCheck(octokit, owner, repo, pr.head.sha, 'Peripheral change — no comprehension needed', 'only styles/assets/tests/config/docs changed');
    await deps.store.recordSkip({ ...common, status: 'peripheral', skip_reason: 'only styles/assets/tests/config/docs changed' });
    return;
  }

  const capped = await overLimit(context, deps);
  if (capped) {
    await gh.createNeutralCheck(octokit, owner, repo, pr.head.sha, 'Reckon Review beta limit', `${capped} daily beta limit reached`);
    await gh.postComment(octokit, owner, repo, pr.number, cappedBody(capped));
    await deps.store.recordSkip({ ...common, status: 'capped', skip_reason: `${capped} daily beta limit reached` });
    return;
  }

  // Digest large diffs so decompose sees the WHOLE PR, not just its first 8000 chars (classify
  // above still runs on the raw diff for accurate line counts). Small diffs pass through as-is.
  // Fold the codebase graph into decompose's input: the diff (digested) PLUS a compact map of how
  // the changed files sit in the repo (criticality + who references them). Best-effort — a null
  // structural context just falls back to diff-only decomposition. This is what makes the gate
  // criticality- and interaction-aware ("this touches a hub referenced by N files").
  const scStart = Date.now();
  const sc = await structuralContext(octokit, owner, repo, pr.head.sha, files);
  const graph_ms = Date.now() - scStart;
  context.log?.info?.(
    { pr: pr.number, repo: `${owner}/${repo}`, graphChars: sc.text.length, coreFiles: sc.coreCount, ms: graph_ms },
    sc.text ? 'reckon: structural context built (graph used)' : 'reckon: no structural context (diff-only)',
  );
  const plan = sc.text ? `${diffDigest(diff)}\n\n${sc.text}` : diffDigest(diff);
  // Policy B: a change touching a load-bearing HUB (referenced by many files) is graded strictly.
  const rigor: 'medium' | 'harsh' = sc.hubCount > 0 ? 'harsh' : deps.rigor;
  const d = await decompose(plan, deps.backend);
  const decisions: Decision[] = d.ok ? d.decisions : [];
  const decisions_hash = hash(JSON.stringify(decisions));

  // Carry-forward (D3): if the load-bearing decisions are UNCHANGED since a prior pass, carry
  // that pass onto the new head instead of re-quizzing on a typo fix. Changed decisions re-gate,
  // which is what closes the "pass then push slop" hole. Only reachable after a push, since an
  // unchanged head bailed at the idempotency guard above.
  if (prior && prior.status === 'passed' && prior.decisions_hash === decisions_hash) {
    await gh.createSuccessCheck(octokit, owner, repo, pr.head.sha, 'Comprehension carried forward', 'Load-bearing decisions unchanged since the passing explanation.');
    await deps.store.updateCheckpointHead(prior.id, pr.head.sha);
    return;
  }

  const check_run_id = await gh.createPendingCheck(octokit, owner, repo, pr.head.sha);
  await deps.store.createCheckpoint({
    ...common, check_run_id, decisions, decisions_hash, rigor, status: 'pending',
    hub_count: sc.hubCount, core_count: sc.coreCount, graph_used: Boolean(sc.text), graph_ms,
    // The subsystem rollup of the graph we just built and would otherwise throw away. The
    // report draws the architecture from the newest one of these per repo.
    area_graph: sc.areaGraph,
  });
  await gh.postComment(octokit, owner, repo, pr.number, elicitBody(decisions));
}

/**
 * App installed, or repos added to an existing install → make Reckon gate BY DEFAULT.
 * For each repo we ensure the managed branch ruleset that requires the "Reckon comprehension"
 * check, so a merge is blocked without the consumer touching branch protection.
 *
 * Best-effort and independent per repo: a repo where we lack `administration: write` (e.g. an
 * older install that hasn't re-consented to the new permission) just fails its own
 * ensureReckonRuleset — logged, skipped — and Reckon stays advisory there. One repo's failure
 * never blocks the rest. Idempotent: safe on redelivered installation webhooks.
 */
export async function onInstallation(context: any, deps: Deps): Promise<void> {
  const octokit = context.octokit;
  const installation = context.payload.installation;
  const account = installation?.account?.login;
  // installation.created carries `repositories`; installation_repositories.added carries
  // `repositories_added`. Either way each entry is { id, full_name, name, ... }.
  const repos: any[] = context.payload.repositories || context.payload.repositories_added || [];

  // PERSIST THE INSTALL. This handler used to configure the ruleset and store nothing, so
  // `installations` and `repos` only ever got rows when someone happened to open a PR. An install
  // that never opened one was invisible: no install count, no install-to-first-PR funnel, and
  // `countInstallGatesSince` silently scoping to zero repos. Best-effort and independent of the
  // ruleset work below, which needs a permission this write does not.
  if (installation?.id && account) {
    try {
      await deps.store.upsertInstallation({
        id: installation.id,
        account_login: account,
        account_type: installation.account?.type || 'Organization',
      });
      for (const r of repos) {
        if (!r?.id) continue;
        await deps.store.upsertRepo({
          id: r.id,
          installation_id: installation.id,
          full_name: r.full_name || `${account}/${r.name}`,
        });
      }
    } catch (err: any) {
      context.log?.warn?.({ err: err?.message || err, installation: installation.id }, 'reckon: could not persist installation');
    }
  }

  for (const r of repos) {
    const [owner, repo] = String(r.full_name || `${account}/${r.name}`).split('/');
    if (!owner || !repo) continue;
    try {
      await gh.ensureReckonRuleset(octokit, owner, repo);
    } catch (err: any) {
      // 403 = admin permission not granted (yet); anything else = transient. Degrade to advisory.
      context.log?.warn?.({ err: err?.message || err, repo: `${owner}/${repo}` }, 'reckon: could not auto-configure gating ruleset');
    }
  }
}

/**
 * App uninstalled from an account → delete everything we stored for it. deleteInstallation
 * removes the installations row and the FK cascade takes repos → checkpoints → attempts with it,
 * so no diff-derived data (topics, explanations, grades, who passed) outlives the uninstall.
 * This is the retention guarantee behind the data story: removing the app purges the account's
 * gate data, with no expiry job to wait on.
 */
export async function onInstallationDeleted(context: any, deps: Deps): Promise<void> {
  const id = context.payload.installation?.id;
  if (!id) return;
  await deps.store.deleteInstallation(id);
}

/**
 * Repos removed from an install (the install itself stays) → delete just those repos. Same
 * cascade (repo → checkpoints → attempts), so revoking Reckon on one repo purges that repo's
 * data immediately, not only on a full uninstall.
 */
export async function onInstallationReposRemoved(context: any, deps: Deps): Promise<void> {
  const removed: any[] = context.payload.repositories_removed || [];
  for (const r of removed) {
    if (r?.id) await deps.store.deleteRepo(r.id);
  }
}

export async function onPullRequestOpened(context: any, deps: Deps): Promise<void> {
  if (context.payload.pull_request.draft) return; // wait for ready_for_review
  await upsertParents(context, deps);
  await runGate(context, deps);
}

/** A new push to the PR (D3). Same pipeline; the carry-forward branch inside it is what makes a
 *  re-push cheap when the load-bearing decisions did not change. */
export async function onPullRequestSynchronize(context: any, deps: Deps): Promise<void> {
  if (context.payload.pull_request.draft) return;
  await upsertParents(context, deps);
  await runGate(context, deps);
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

  // Grade the reviewer's CUMULATIVE explanation across every round on this gate, not just this
  // reply. Each gate decomposes into several decisions; a single reply naturally covers a subset,
  // so grading replies in isolation reports the rest as "missing" every time and the gate never
  // converges (explain A → "missing B" → explain B → "missing A"). Concatenating all prior
  // explanations with this one lets coverage accumulate: once a decision is explained in any
  // round it stays covered, and the rescue prompt only ever names what is genuinely still absent.
  const prior = await deps.store.listAttemptExplanations(cp.id);
  const cumulative = [...prior, explanation].join('\n\n');

  const g = await gradePlan({
    groundTruth: decisionsToGroundTruth(decisions),
    explanation: cumulative,
    rigor: cp.rigor as 'medium' | 'harsh',
    decisions,
    backend: deps.backend,
  });

  // Record the attempt, and promote the person into the durable identity table. This is the
  // moment someone actually ENGAGES with Reckon, pass or fail, so it is the honest definition of
  // "a user" — populating `users` only on a pass made that table a strict subset of
  // `demonstrations` and blind to everyone still mid-conversation with the gate.
  //
  // Both writes are best-effort. They used to be able to throw straight out of the handler,
  // before the pass/fail comment was posted, so one transient Supabase blip both lost the data
  // AND left the reviewer staring at a silent, still-blocked gate with no idea why. A write
  // failure must degrade to a missing row, never to a wedged gate.
  try {
    await deps.store.recordAttempt({
      checkpoint_id: cp.id,
      reviewer_login: payload.comment.user.login,
      reviewer_id: payload.comment.user.id,
      comment_id: payload.comment.id,
      explanation,
      assisted: true, // the diff is always on screen on GitHub
      grade_pass: g.pass,
      ungraded: g.ungraded,
      // gradePlan reports coverage, not the per-dimension rubric scores that grade() returns, so
      // this is the whole of what it knows. `overlap` has no plan-level analogue at all.
      scores: { covered: g.covered, missing: g.missing },
      overlap: 'unknown',
      hole: g.hole,
    });
    await deps.store.upsertUser({ github_id: payload.comment.user.id, github_login: payload.comment.user.login });
  } catch (err: any) {
    context.log?.error?.({ err: err?.message || err, pr: pr_number, repo: `${owner}/${repo}` }, 'reckon: attempt not recorded (gate continues)');
  }

  if (g.ungraded) {
    if (cp.check_run_id) await gh.setCheckNeutral(octokit, owner, repo, cp.check_run_id, g.note || 'grader unavailable');
    await gh.postComment(octokit, owner, repo, pr_number, ungradedBody(g.note || 'grader unavailable'));
    return;
  }

  if (g.pass) {
    if (cp.check_run_id) {
      await gh.setCheckSuccess(octokit, owner, repo, cp.check_run_id, `Explained by @${payload.comment.user.login}.`);
    }
    // The DEPOSIT: a best-effort rich close over the cumulative explanation. Sequenced
    // AFTER the check flips green and cannot affect the merge — a null (grader hiccup)
    // just degrades to the plain pass message. Persisted so a user's Reckon record can
    // later show which topics they demonstrated they understand well.
    const close = await closeout(decisions, cumulative, deps.backend);
    await deps.store.markCheckpointPassed(cp.id, {
      passed_by: payload.comment.user.login,
      passed_by_id: payload.comment.user.id,
      closeout: close,
    });

    // THE DURABLE RECORD. Promote the passer into the cross-install users table and append one
    // demonstration row per topic they showed understanding of. This lives in tables keyed by
    // github_id that OUTLIVE uninstall (unlike the checkpoint/attempt data), which is the whole
    // point of a personal record — and is disclosed as persistent. Best-effort and sequenced
    // after the merge is already unblocked: a missing table (migration not yet applied) or any
    // write error is logged and swallowed, never affecting the gate. Prefer the closeout's
    // per-topic verdicts; fall back to the raw decisions if the best-effort close returned null.
    //
    // Each row is stamped on BOTH axes of the knowledge map at write time, because neither input
    // survives to read time: `area` needs the PR's changed paths (which live on a checkpoint that
    // cascade-purges on uninstall) and `domains` needs the explanation (which is never stored).
    // A record that outlives its source has to carry its own categorization.
    try {
      const gid = payload.comment.user.id;
      const glogin = payload.comment.user.login;
      // One area per demonstration: the dominant subsystem of the change. A PR spanning several
      // gets the one it touched most, so a demonstration lands on exactly one box of the
      // architecture rather than smearing thin credit across all of them.
      const area = dominantArea((cp.files as string[] | null) ?? []);
      const summaryOf = new Map(decisions.map((d) => [d.concept, d.summary]));
      const base = { github_id: gid, github_login: glogin, area, repo_full_name: `${owner}/${repo}`, pr_number, head_sha: cp.head_sha };
      const rows = close && close.topics.length
        ? close.topics.map((t) => ({
            ...base, concept: t.concept, summary: summaryOf.get(t.concept),
            verdict: t.verdict, note: t.note,
            domains: resolveDomains(t.domains, `${t.concept} ${summaryOf.get(t.concept) ?? ''} ${t.note}`),
          }))
        : decisions.map((d) => ({
            ...base, concept: d.concept, summary: d.summary, verdict: null,
            // No closeout means no model tags, so the keyword classifier is the only tagger left.
            domains: resolveDomains(null, `${d.concept} ${d.summary}`),
          }));
      await deps.store.recordDemonstrations(rows);
    } catch (err: any) {
      context.log?.warn?.({ err: err?.message || err, pr: pr_number }, 'reckon: durable record write failed (gate unaffected)');
    }

    await gh.postComment(octokit, owner, repo, pr_number, passBody(payload.comment.user.login, close));
  } else {
    // Stay blocked (check remains in_progress); offer the single hole.
    await gh.postComment(octokit, owner, repo, pr_number, rescueBody(g.hole));
  }
}
