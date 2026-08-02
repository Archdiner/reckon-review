/**
 * GitHub URLs for the provenance the record already stores.
 *
 * The map's claim is that something was DEMONSTRABLY explained. A number with no way to open the
 * conversation behind it is an assertion, not evidence, so every demonstration, every finding, and
 * every diagram links back to the PR it came from. `demonstrations` already carries
 * (repo_full_name, pr_number, head_sha) precisely because it outlives the repo row.
 *
 * The base is overridable for GitHub Enterprise, where the host is not github.com. A link that
 * silently points at the wrong host is worse than no link.
 */
const BASE = (process.env.RECKON_GITHUB_BASE || 'https://github.com').replace(/\/+$/, '');

/** Guard against a malformed repo name producing a link to somewhere unintended. */
function isRepo(full?: string | null): full is string {
  return !!full && /^[\w.-]+\/[\w.-]+$/.test(full);
}

export function repoUrl(full?: string | null): string | null {
  return isRepo(full) ? `${BASE}/${full}` : null;
}

export function prUrl(full?: string | null, pr?: number | null): string | null {
  return isRepo(full) && typeof pr === 'number' && pr > 0 ? `${BASE}/${full}/pull/${pr}` : null;
}

export function commitUrl(full?: string | null, sha?: string | null): string | null {
  return isRepo(full) && !!sha && /^[0-9a-f]{7,40}$/i.test(sha) ? `${BASE}/${full}/commit/${sha}` : null;
}
