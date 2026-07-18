/**
 * Thin wrappers over the installation-scoped Octokit (provided by Probot as context.octokit).
 * Typed loosely (`any`) on purpose — Probot's generated types are heavy and we only touch a
 * handful of endpoints. The gating contract lives here: a pending check is `in_progress`
 * (no conclusion) so branch protection treats it as unresolved and blocks merge; only a
 * `success` conclusion unblocks it.
 */
import { RECKON_CHECK } from './format.js';

export async function fetchDiff(octokit: any, owner: string, repo: string, pull_number: number): Promise<string> {
  const res = await octokit.pulls.get({ owner, repo, pull_number, mediaType: { format: 'diff' } });
  return res.data as unknown as string;
}

export async function fetchFiles(octokit: any, owner: string, repo: string, pull_number: number): Promise<string[]> {
  const files = await octokit.paginate(octokit.pulls.listFiles, { owner, repo, pull_number, per_page: 100 });
  return files.map((f: any) => f.filename);
}

/** Create the gating check in the pending (merge-blocking) state; returns its id. */
export async function createPendingCheck(octokit: any, owner: string, repo: string, head_sha: string): Promise<number> {
  const res = await octokit.checks.create({
    owner, repo, name: RECKON_CHECK, head_sha, status: 'in_progress',
    output: { title: 'Explain to merge', summary: 'Reply to the Reckon comment with your explanation of the mechanism.' },
  });
  return res.data.id;
}

export async function setCheckSuccess(octokit: any, owner: string, repo: string, check_run_id: number, summary: string): Promise<void> {
  await octokit.checks.update({
    owner, repo, check_run_id, status: 'completed', conclusion: 'success',
    output: { title: 'Comprehension passed', summary },
  });
}

/** Create a fresh check already in the success state on a given commit (trivial PRs, or
 *  carrying a prior pass forward onto a new head after a push). */
export async function createSuccessCheck(octokit: any, owner: string, repo: string, head_sha: string, title: string, summary: string): Promise<void> {
  await octokit.checks.create({
    owner, repo, name: RECKON_CHECK, head_sha, status: 'completed', conclusion: 'success',
    output: { title, summary },
  });
}

/** Create a fresh neutral check on a commit (beta rate-limit: not blocking, not a pass). */
export async function createNeutralCheck(octokit: any, owner: string, repo: string, head_sha: string, title: string, summary: string): Promise<void> {
  await octokit.checks.create({
    owner, repo, name: RECKON_CHECK, head_sha, status: 'completed', conclusion: 'neutral',
    output: { title, summary },
  });
}

/** Grader outage: neutral does not block merge but is clearly not a pass. */
export async function setCheckNeutral(octokit: any, owner: string, repo: string, check_run_id: number, summary: string): Promise<void> {
  await octokit.checks.update({
    owner, repo, check_run_id, status: 'completed', conclusion: 'neutral',
    output: { title: 'Grader unavailable', summary },
  });
}

export async function postComment(octokit: any, owner: string, repo: string, issue_number: number, body: string): Promise<number> {
  const res = await octokit.issues.createComment({ owner, repo, issue_number, body });
  return res.data.id;
}
