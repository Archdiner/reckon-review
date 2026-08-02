/**
 * AXIS 2 of the knowledge map: WHAT KIND. A "domain" is a portable category of engineering
 * understanding (concurrency, data modeling, auth, ...) that means the same thing in every repo.
 *
 * Areas (areas.ts) answer "which parts of THIS codebase are understood" — a team question, and
 * worthless the moment you change jobs. Domains answer "what kinds of understanding has this
 * person demonstrated, anywhere" — the person question, and the thing a record can carry across
 * repos. Same demonstration, tagged on both axes; that is the whole "higher level categorizing".
 *
 * CLOSED VOCABULARY on purpose. The failure mode of the current `concept` field is that free
 * text never aggregates: 40 demonstrations produce 40 categories and no map. A fixed enum is
 * lossy by design, and lossy is exactly what makes it groupable.
 *
 * Two taggers, in order of preference:
 *   1. the closeout model, which is already reading the explanation (zero extra calls), and
 *   2. a keyword classifier here, for when the closeout is unavailable or returns junk.
 * Neither is allowed to invent a domain: anything off the enum is dropped, and no match yields
 * NO tag rather than a wrong one. An honest blank beats a confident miscategorization.
 */

export const DOMAINS = [
  'data-modeling',
  'api-contracts',
  'state-and-lifecycle',
  'concurrency-and-async',
  'error-handling',
  'performance',
  'caching',
  'security',
  'auth-and-identity',
  'distributed-systems',
  'algorithms',
  'testing',
  'build-and-deploy',
  'observability',
  'ui-and-rendering',
  'migration-and-compat',
] as const;

export type Domain = (typeof DOMAINS)[number];

const DOMAIN_SET = new Set<string>(DOMAINS);

export const DOMAIN_LABELS: Record<Domain, string> = {
  'data-modeling': 'Data modeling',
  'api-contracts': 'API contracts',
  'state-and-lifecycle': 'State and lifecycle',
  'concurrency-and-async': 'Concurrency and async',
  'error-handling': 'Error handling',
  performance: 'Performance',
  caching: 'Caching',
  security: 'Security',
  'auth-and-identity': 'Auth and identity',
  'distributed-systems': 'Distributed systems',
  algorithms: 'Algorithms and data structures',
  testing: 'Testing',
  'build-and-deploy': 'Build and deploy',
  observability: 'Observability',
  'ui-and-rendering': 'UI and rendering',
  'migration-and-compat': 'Migration and compatibility',
};

/**
 * Keyword classifier: the deterministic fallback when the model did not tag. Ordered patterns,
 * scored by match count, top 2 returned. Deliberately conservative: these fire on vocabulary
 * that is specific to a domain, not on words that show up in every explanation ("data", "state"
 * alone would match everything and tell you nothing).
 */
const PATTERNS: [Domain, RegExp][] = [
  ['concurrency-and-async', /\b(race condition|deadlock|mutex|lock|atomic|concurren\w*|parallel|thread|async|await|promise|debounce|throttle|backpressure|queue|worker)\b/i],
  ['caching', /\b(cache|caching|cached|memoiz\w+|invalidat\w+|ttl|stale-while-revalidate|etag|cdn)\b/i],
  ['security', /\b(sanitiz\w+|escap\w+|injection|xss|csrf|ssrf|secret|encrypt\w*|hash\w*|vulnerab\w+|exploit|rls|row-level)\b/i],
  ['auth-and-identity', /\b(auth|authn|authz|oauth|jwt|session|login|permission|role|scope|token|identity|credential)\b/i],
  ['distributed-systems', /\b(idempoten\w+|retry|retries|at-least-once|exactly-once|eventual\w* consist\w+|replica|shard|partition|webhook|distributed|consensus|leader)\b/i],
  ['data-modeling', /\b(schema|migration|foreign key|primary key|index|normaliz\w+|denormaliz\w+|cascade|constraint|table|column|upsert|transaction)\b/i],
  ['api-contracts', /\b(api|endpoint|contract|interface|payload|request|response|versioning|backward.compat\w*|rest|graphql|rpc|protocol|serializ\w+)\b/i],
  ['error-handling', /\b(error|exception|throw|catch|fail.(open|closed|safe)|fallback|degrade|graceful|recover\w*|timeout|guard)\b/i],
  ['performance', /\b(performance|latency|throughput|slow|optimiz\w+|n\+1|hot path|allocation|memory|profil\w+|bottleneck|budget|bounded)\b/i],
  ['algorithms', /\b(algorithm|complexity|o\(n|traversal|recursi\w+|graph|pagerank|sort\w*|search|heuristic|greedy|dynamic programming)\b/i],
  ['state-and-lifecycle', /\b(lifecycle|state machine|transition|mount\w*|unmount\w*|initializ\w+|teardown|cleanup|idempotent state|reducer|immutab\w+)\b/i],
  ['testing', /\b(test|tests|spec|fixture|mock|stub|assertion|coverage|regression|flaky)\b/i],
  ['build-and-deploy', /\b(build|bundl\w+|compil\w+|deploy\w*|docker|ci\/cd|pipeline|dependency|dev depend\w+|runtime depend\w+|tree.shak\w+)\b/i],
  ['observability', /\b(log|logging|metric|trace|tracing|telemetry|monitor\w*|alert|instrument\w+|observab\w+)\b/i],
  ['ui-and-rendering', /\b(render\w*|dom|css|layout|paint|reflow|component|accessib\w+|aria|responsive|viewport)\b/i],
  ['migration-and-compat', /\b(migrat\w+|backfill|deprecat\w+|breaking change|backward|forward.compat\w*|rollout|feature flag|legacy)\b/i],
];

/** Keep only real domains, deduped, at most `max`. The gate every tagger passes through. */
export function normalizeDomains(raw: unknown, max = 2): Domain[] {
  if (!Array.isArray(raw)) return [];
  const out: Domain[] = [];
  for (const v of raw) {
    const s = String(v ?? '').trim().toLowerCase();
    if (DOMAIN_SET.has(s) && !out.includes(s as Domain)) out.push(s as Domain);
    if (out.length >= max) break;
  }
  return out;
}

/** Deterministic fallback tagger over whatever text we have about a topic. */
export function classifyDomains(text: string, max = 2): Domain[] {
  if (!text || !text.trim()) return [];
  const scored: { d: Domain; n: number }[] = [];
  for (const [d, re] of PATTERNS) {
    const m = text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
    if (m && m.length) scored.push({ d, n: m.length });
  }
  // Ties break on PATTERNS order, which runs most-specific first.
  scored.sort((a, b) => b.n - a.n);
  return scored.slice(0, max).map((s) => s.d);
}

/** Prefer the model's tags; fall back to keywords; never invent. */
export function resolveDomains(modelTags: unknown, fallbackText: string): Domain[] {
  const tagged = normalizeDomains(modelTags);
  return tagged.length ? tagged : classifyDomains(fallbackText);
}

export function domainLabel(d: string): string {
  return DOMAIN_LABELS[d as Domain] ?? d;
}
