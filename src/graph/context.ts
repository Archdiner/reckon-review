/**
 * The gate's entry point into the codebase graph. Given a PR's changed files, fetch the repo at
 * its head, build the ephemeral graph, and return a compact structural-context string to fold
 * into decompose's input — so the generated questions become criticality- and interaction-aware
 * ("this touches a hub referenced by 12 files, explain the contract") instead of diff-only.
 *
 * Strictly best-effort and bounded by a timeout: a fetch failure, a huge/slow repo, an
 * unsupported-language repo, or any error returns '' and the gate proceeds exactly as before on
 * the diff alone. It NEVER blocks or delays the merge path.
 */
import { fetchRepoSources } from './fetch.js';
import { buildGraph, serializeContext } from './repo-map.js';
import { extractorFor } from './extractor.js';

const DEFAULT_TIMEOUT_MS = 8000;

export interface StructuralContext {
  text: string; // the serialized context, or '' if unavailable
  coreCount: number; // changed files tiered 'core' (for future policy; unused today)
}

export async function structuralContext(
  octokit: any,
  owner: string,
  repo: string,
  ref: string,
  changedPaths: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<StructuralContext> {
  const empty: StructuralContext = { text: '', coreCount: 0 };
  // Skip entirely if none of the changed files are in a language we can extract — no point
  // pulling a tarball to learn nothing.
  const changedSupported = changedPaths.filter((p) => extractorFor(p));
  if (changedSupported.length === 0) return empty;

  try {
    const work = (async (): Promise<StructuralContext> => {
      const { files, truncated } = await fetchRepoSources(octokit, owner, repo, ref);
      if (files.length === 0) return empty;
      const g = buildGraph(files);
      const { criticality } = await import('./repo-map.js');
      const tiers = criticality(g, changedSupported);
      let text = serializeContext(g, changedSupported);
      if (truncated) text += '\n(note: large repo — graph built over a bounded subset of files)';
      return { text, coreCount: tiers.filter((t) => t.tier === 'core').length };
    })();
    const timeout = new Promise<StructuralContext>((resolve) => setTimeout(() => resolve(empty), timeoutMs));
    return await Promise.race([work, timeout]);
  } catch {
    return empty;
  }
}
