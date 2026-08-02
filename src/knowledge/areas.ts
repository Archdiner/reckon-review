/**
 * AXIS 1 of the knowledge map: WHERE. An "area" is a named subsystem of one repo, the level
 * of the boxes in an architecture diagram, NOT a file and NOT a directory listing.
 *
 * Why this exists: `demonstrations.concept` is free text minted per PR by decompose, so two
 * people who explained the same subsystem six weeks apart get two unrelated slugs. Grouping by
 * raw concept yields a pile of one-offs, never a map. An area is the STABLE SPINE the one-off
 * concepts get projected onto, so "who understands what" can actually aggregate.
 *
 * Deterministic and free: derived from the changed paths, no model call, so it can be recorded
 * on EVERY event including the ones we skip without spending a token. That matters because the
 * skipped ones are what drives freshness decay (see freshness.ts): code moving under a
 * demonstration is what makes it stale.
 *
 * Repo-overridable at READ time, not write time. A repo can name its own boxes in `.reckon.yml`
 * (`areas: { graph: "Codebase graph" }`, persisted to repos.config), and that renaming is applied
 * when the map is rendered. Keeping the stored key deterministic means renaming a subsystem is a
 * config edit, not a backfill, and it keeps the hot path free of an extra config read.
 */

/** Roots that carry no meaning of their own; the subsystem is the segment BELOW them. */
const SOURCE_ROOTS = new Set(['src', 'lib', 'app', 'source', 'internal', 'pkg', 'cmd']);

/** Monorepo containers: the segment below them IS the subsystem (the package name). */
const MONOREPO_ROOTS = new Set(['packages', 'apps', 'services', 'modules', 'libs']);

/** Paths that describe no subsystem at all; a change here should not credit or age an area. */
const NON_SUBSYSTEM = [
  /\.(md|txt|rst)$/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock)$/i,
  /(^|\/)(LICENSE|CHANGELOG|CODEOWNERS)/i,
  /^\.github\//i,
  /^docs?\//i,
  /(^|\/)(dist|build|out|coverage|vendor|node_modules|generated)\//i,
];

/**
 * Default labels for conventional directory names, so an auto-derived area reads as a topic
 * ("Persistence") and not as a path ("store"). Only a naming nicety: the KEY is what is stored
 * and joined on, the label is presentation. Anything unmapped is title-cased.
 */
const DEFAULT_LABELS: Record<string, string> = {
  api: 'API layer', auth: 'Auth and identity', cli: 'CLI', components: 'UI components',
  config: 'Configuration', db: 'Data model', migrations: 'Data model', models: 'Data model',
  graph: 'Codebase graph', grader: 'Grading', handlers: 'Request handling', hooks: 'UI hooks',
  jobs: 'Background jobs', workers: 'Background jobs', queue: 'Background jobs',
  middleware: 'Middleware', pages: 'Pages and routing', routes: 'Pages and routing',
  router: 'Pages and routing', report: 'Reporting', schema: 'Data model', server: 'Server',
  services: 'Services', store: 'Persistence', storage: 'Persistence', styles: 'Styling',
  test: 'Tests', tests: 'Tests', types: 'Type definitions', ui: 'UI', utils: 'Utilities',
  util: 'Utilities', knowledge: 'Knowledge model', infra: 'Infrastructure',
};

/** A repo's own naming of its boxes: area key to display label, `{ graph: "Codebase graph" }`. */
export type AreaLabels = Record<string, string>;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** True when a path describes no subsystem (docs, lockfiles, CI, generated output). */
export function isNonSubsystem(path: string): boolean {
  return NON_SUBSYSTEM.some((r) => r.test(path));
}

/**
 * The area key for one path. Returns null for paths that describe no subsystem.
 *
 * The rule, in order: a monorepo container hands off to the package below it; then source roots
 * are stripped; then the first remaining DIRECTORY is the area, or, for a file sitting directly
 * at that level, the file's own stem (a root-level `server.ts` is its own subsystem, not "the
 * root").
 */
export function areaFor(path: string): string | null {
  const p = path.replace(/^\.\//, '');
  if (isNonSubsystem(p)) return null;

  let segs = p.split('/').filter(Boolean);
  if (segs.length === 0) return null;

  if (MONOREPO_ROOTS.has(segs[0].toLowerCase()) && segs.length >= 2) {
    // The package IS the subsystem; anything deeper is internal structure of it.
    return slug(segs[1].replace(/\.[^.]+$/, ''));
  }
  while (segs.length > 1 && SOURCE_ROOTS.has(segs[0].toLowerCase())) segs = segs.slice(1);

  const head = segs[0];
  // A directory (something follows it) names the area; otherwise the file's own stem does.
  const key = segs.length > 1 ? head : head.replace(/\.[^.]+$/, '');
  return slug(key) || null;
}

/** The distinct areas a set of changed paths touches, in stable order. */
export function areasFor(paths: string[]): string[] {
  const seen = new Set<string>();
  for (const p of paths) {
    const a = areaFor(p);
    if (a) seen.add(a);
  }
  return [...seen].sort();
}

/** Presentation name for an area key: the repo's own naming first, then the conventional map,
 *  then a title-cased fallback. Read-time only, so renaming a box never needs a backfill. */
export function areaLabel(key: string, labels: AreaLabels = {}): string {
  const mapped = labels[key] ?? DEFAULT_LABELS[key];
  if (mapped) return mapped;
  const words = key.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Pull the optional `areas:` naming map out of a repo's stored `.reckon.yml` config. */
export function labelsFromConfig(config: unknown): AreaLabels {
  const raw = (config as any)?.areas;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: AreaLabels = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[slug(k)] = v;
  return out;
}
