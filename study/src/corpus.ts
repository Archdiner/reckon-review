/**
 * Which repositories the study draws from, and why each one qualifies.
 *
 * THE SELECTION CONSTRAINT THAT MATTERS
 *
 * This study reconstructs "the record" from git rather than the GitHub API. That is only
 * sound for repositories whose merge convention PRESERVES the pull-request description in
 * the commit it lands. Repos configured to squash with the PR title alone (home-assistant/core,
 * n8n-io/n8n — both measured at 0% non-trivial bodies over 2000 merges) destroy the
 * description at merge time. Sampling those would not measure "authors documented nothing",
 * it would measure "the merge button discarded what they wrote", and it would fabricate a
 * dramatic result out of a tooling setting.
 *
 * So repos are admitted on their CONVENTION, never on the richness of any individual PR.
 * Within an admitted repo, an empty description is real data and is kept: those are the
 * PRs where an author genuinely wrote nothing. Filtering on body length would condition the
 * sample on the outcome being measured, which is the same error in a subtler form.
 *
 * Admission rule: >=25% of the repo's recent merges carry a non-trivial body. That
 * threshold separates the two populations cleanly — the admitted repos measured 41-95%,
 * the rejected ones measured 0%. Nothing sits near the line.
 *
 * The five admitted repos span Python, TypeScript, Go and Rust, and four separate
 * engineering cultures, which is the protocol's "use a mix, not one repo" requirement.
 */

export interface RepoSpec {
  /** owner/name on GitHub. */
  slug: string;
  /** Local clone directory name. */
  dir: string;
  /** Measured share of recent merges carrying a >=200 char body, at admission time. */
  bodyDensity: number;
  primaryLanguages: string[];
}

export const REPOS: RepoSpec[] = [
  { slug: 'langchain-ai/langchain', dir: 'langchain', bodyDensity: 0.42, primaryLanguages: ['Python'] },
  { slug: 'supabase/supabase', dir: 'supabase', bodyDensity: 0.85, primaryLanguages: ['TypeScript'] },
  { slug: 'apache/airflow', dir: 'airflow', bodyDensity: 0.47, primaryLanguages: ['Python', 'Go'] },
  { slug: 'grafana/grafana', dir: 'grafana', bodyDensity: 0.41, primaryLanguages: ['Go', 'TypeScript'] },
  { slug: 'prisma/prisma', dir: 'prisma', bodyDensity: 0.95, primaryLanguages: ['TypeScript', 'Rust'] },
];

/** Repos evaluated and REJECTED, kept in the source so the exclusion is auditable. */
export const REJECTED_REPOS = [
  { slug: 'home-assistant/core', bodyDensity: 0.0, reason: 'squash-merges with PR title only; description not preserved in git' },
  { slug: 'n8n-io/n8n', bodyDensity: 0.0, reason: 'squash-merges with PR title only; description not preserved in git' },
  { slug: 'django/django', bodyDensity: null, reason: 'no squash convention; PR description never enters the commit record' },
  { slug: 'kubernetes/kubernetes', bodyDensity: null, reason: 'tide merge commits; PR description never enters the commit record' },
  { slug: 'withastro/astro', bodyDensity: 0.17, reason: 'below the 25% admission threshold (changeset-driven commit bodies)' },
];

const EXT_LANG: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', pyi: 'Python',
  go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', rb: 'Ruby',
  c: 'C', h: 'C', cc: 'C++', cpp: 'C++', hpp: 'C++',
  cs: 'C#', php: 'PHP', swift: 'Swift', scala: 'Scala',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'Shell',
  sql: 'SQL', proto: 'Protobuf',
  ex: 'Elixir', exs: 'Elixir', dart: 'Dart', lua: 'Lua', r: 'R',
  clj: 'Clojure', hs: 'Haskell', groovy: 'Groovy', vue: 'Vue', svelte: 'Svelte',
  // Configuration and markup are counted as first-class languages rather than swept into
  // "Other". A YAML-heavy infrastructure change and a Terraform change are different kinds
  // of work, and matching an agent YAML change against a human Terraform change because
  // both landed in one "Other" bucket would defeat the point of matching.
  yaml: 'YAML', yml: 'YAML', json: 'JSON', toml: 'TOML',
  tf: 'Terraform', hcl: 'Terraform',
  css: 'CSS', scss: 'CSS', less: 'CSS', html: 'HTML', xml: 'XML',
};

/**
 * Dominant language by changed lines across the PR's surviving files. Ties break
 * alphabetically so the label is deterministic across runs.
 */
export function inferLanguage(files: { path: string; changed: number }[]): string {
  const tally = new Map<string, number>();
  for (const f of files) {
    const ext = f.path.split('.').pop()?.toLowerCase() ?? '';
    const lang = EXT_LANG[ext];
    if (!lang) continue;
    tally.set(lang, (tally.get(lang) ?? 0) + f.changed);
  }
  if (tally.size === 0) return 'Other';
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}
