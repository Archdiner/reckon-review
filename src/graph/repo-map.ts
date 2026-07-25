/**
 * The codebase graph engine (see docs/CODEBASE-GRAPH.md). Pure and backend-agnostic: give it a
 * set of files, it builds a name-based def/ref graph, ranks it with personalized PageRank, and
 * answers the two questions the gate needs:
 *   - criticality(changed): is this change in a load-bearing hub, or a peripheral leaf?
 *   - neighborhood(changed): what depends on it (blast radius) and what it depends on?
 * plus serialize(): a compact, budget-bounded structural context to inject into decompose.
 *
 * "Advisory, not authoritative": edges are name-based and over-approximate, so treat outputs as a
 * LOWER BOUND on blast radius (see §3 of the doc). Good enough to steer a human's attention.
 */
import type { SymbolDef } from './extractor.js';
import { DEFAULT_EXTRACTORS, extractorFor, type SymbolExtractor } from './extractor.js';

export interface RepoFile {
  path: string;
  content: string;
}

export interface Graph {
  files: string[];
  defsByFile: Map<string, SymbolDef[]>;
  defSites: Map<string, string[]>; // symbol name → files that define it
  out: Map<string, Map<string, Set<string>>>; // F → (G → symbols of G that F references)
  in: Map<string, Map<string, Set<string>>>; // G → (F → symbols) — the referrers (blast radius)
}

export function buildGraph(files: RepoFile[], extractors: SymbolExtractor[] = DEFAULT_EXTRACTORS): Graph {
  const defsByFile = new Map<string, SymbolDef[]>();
  const refsByFile = new Map<string, { name: string }[]>();
  const defSites = new Map<string, string[]>();

  for (const f of files) {
    const ex = extractorFor(f.path, extractors);
    if (!ex) continue;
    const { defs, refs } = ex.extract(f.path, f.content);
    defsByFile.set(f.path, defs);
    refsByFile.set(f.path, refs);
    for (const d of defs) {
      const arr = defSites.get(d.name) ?? [];
      if (!arr.includes(f.path)) arr.push(f.path);
      defSites.set(d.name, arr);
    }
  }

  const out = new Map<string, Map<string, Set<string>>>();
  const inn = new Map<string, Map<string, Set<string>>>();
  const addEdge = (from: string, to: string, sym: string): void => {
    if (from === to) return;
    let o = out.get(from);
    if (!o) out.set(from, (o = new Map()));
    let os = o.get(to);
    if (!os) o.set(to, (os = new Set()));
    os.add(sym);
    let i = inn.get(to);
    if (!i) inn.set(to, (i = new Map()));
    let is = i.get(from);
    if (!is) i.set(from, (is = new Set()));
    is.add(sym);
  };

  // A name defined in many files (check, run, setup, handle, get…) is a generic collision, not a
  // real reference target — linking every caller to every definer floods the graph with false
  // hubs (test files full of common helper names dominate fan-in). Drop names above this cap:
  // they carry no resolution signal. Precise import-resolution is the later (SCIP-backed) upgrade.
  const AMBIGUITY_CAP = 3;
  for (const [file, refs] of refsByFile) {
    for (const r of refs) {
      const sites = defSites.get(r.name);
      if (!sites || sites.length > AMBIGUITY_CAP) continue;
      for (const g of sites) addEdge(file, g, r.name);
    }
  }

  return { files: [...defsByFile.keys()], defsByFile, defSites, out, in: inn };
}

/** Distinct referrer files of a file — the simplest, most legible criticality signal. */
export function fanIn(g: Graph, file: string): number {
  return g.in.get(file)?.size ?? 0;
}

/**
 * Personalized PageRank over F→G ("F references G"). Rank accumulates on files that are
 * referenced by many (important) files, so hubs rise. `personalize` biases the teleport vector
 * toward the changed files, making the ranking task-scoped (Aider's trick).
 */
export function pageRank(g: Graph, personalize: string[] = [], opts?: { damping?: number; iters?: number }): Map<string, number> {
  const d = opts?.damping ?? 0.85;
  const iters = opts?.iters ?? 40;
  const nodes = g.files;
  const n = nodes.length;
  const rank = new Map<string, number>();
  if (n === 0) return rank;

  const teleport = new Map<string, number>();
  const pset = new Set(personalize.filter((p) => g.defsByFile.has(p)));
  for (const f of nodes) teleport.set(f, pset.size ? (pset.has(f) ? 1 / pset.size : 0) : 1 / n);
  for (const f of nodes) rank.set(f, 1 / n);

  const outWeight = new Map<string, number>();
  for (const f of nodes) {
    let w = 0;
    const o = g.out.get(f);
    if (o) for (const syms of o.values()) w += syms.size;
    outWeight.set(f, w);
  }

  for (let it = 0; it < iters; it++) {
    const next = new Map<string, number>();
    let dangling = 0;
    for (const f of nodes) if ((outWeight.get(f) ?? 0) === 0) dangling += rank.get(f)!;
    for (const f of nodes) next.set(f, (1 - d) * teleport.get(f)! + d * dangling * teleport.get(f)!);
    for (const f of nodes) {
      const o = g.out.get(f);
      const w = outWeight.get(f) ?? 0;
      if (!o || w === 0) continue;
      const rf = rank.get(f)!;
      for (const [to, syms] of o) next.set(to, (next.get(to) ?? 0) + d * rf * (syms.size / w));
    }
    for (const [k, v] of next) rank.set(k, v);
  }
  return rank;
}

// ── Criticality tiering ────────────────────────────────────────────────────────────────────
export type Tier = 'core' | 'peripheral' | 'trivial';

const TRIVIAL = [/\.(md|txt|rst)$/i, /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i, /(^|\/)(dist|build|generated)\//i, /\.min\.(js|css)$/i];
const PERIPHERAL = [/\.(css|scss|less|svg|png|jpg|ico|woff2?)$/i, /(^|\/)(assets|public|static)\//i, /\.(test|spec)\.[jt]sx?$/i, /(^|\/)__tests__\//i, /\.(html|md?x)$/i, /\.(json|ya?ml|toml)$/i];
const CORE_FANIN = 3; // referenced by >= this many files → core regardless of path
export const HUB_FANIN = 8; // referenced by >= this many files → a load-bearing hub (→ harsh rigor)

/** Path-only tier (no graph needed): the cheap, always-available signal used for the
 *  peripheral-only skip. A source-code path defaults to 'core' unless it matches a
 *  non-logic pattern (styles, assets, tests, config, docs). */
export function pathTier(path: string): Tier {
  if (TRIVIAL.some((r) => r.test(path))) return 'trivial';
  if (PERIPHERAL.some((r) => r.test(path))) return 'peripheral';
  return 'core';
}

export interface CriticalityTier {
  path: string;
  tier: Tier;
  fanIn: number;
  reason: string;
}

export function criticality(g: Graph, changed: string[]): CriticalityTier[] {
  return changed.map((path) => {
    const fi = fanIn(g, path);
    const pt = pathTier(path);
    if (pt === 'trivial') return { path, tier: 'trivial' as Tier, fanIn: fi, reason: 'generated/docs/lockfile' };
    if (fi >= CORE_FANIN) return { path, tier: 'core' as Tier, fanIn: fi, reason: `hub: referenced by ${fi} files` };
    if (pt === 'peripheral') return { path, tier: 'peripheral' as Tier, fanIn: fi, reason: 'peripheral file type, low fan-in' };
    return { path, tier: 'core' as Tier, fanIn: fi, reason: fi > 0 ? `referenced by ${fi} file(s)` : 'source file' };
  });
}

// ── Neighborhood (blast radius) ────────────────────────────────────────────────────────────
export interface Neighborhood {
  changedSymbols: string[];
  referrers: Map<string, Map<string, Set<string>>>; // changedFile → (referrerFile → symbols used)
  dependencies: Map<string, Map<string, Set<string>>>; // changedFile → (depFile → symbols used)
}

export function neighborhood(g: Graph, changed: string[]): Neighborhood {
  const changedSet = new Set(changed);
  const changedSymbols = new Set<string>();
  for (const c of changed) for (const d of g.defsByFile.get(c) ?? []) changedSymbols.add(d.name);
  const referrers = new Map<string, Map<string, Set<string>>>();
  const dependencies = new Map<string, Map<string, Set<string>>>();
  for (const c of changed) {
    if (g.in.get(c)) referrers.set(c, g.in.get(c)!);
    const deps = new Map<string, Set<string>>();
    for (const [to, syms] of g.out.get(c) ?? []) if (!changedSet.has(to)) deps.set(to, syms);
    if (deps.size) dependencies.set(c, deps);
  }
  return { changedSymbols: [...changedSymbols], referrers, dependencies };
}

// ── Serialize: compact structural context for decompose ──────────────────────────────────────
export function serializeContext(g: Graph, changed: string[], budget = 1200): string {
  const tiers = new Map(criticality(g, changed).map((t) => [t.path, t]));
  const nbh = neighborhood(g, changed);
  const ordered = [...changed].sort((a, b) => {
    const ta = tiers.get(a)!, tb = tiers.get(b)!;
    const rank = (t: Tier): number => (t === 'core' ? 0 : t === 'peripheral' ? 2 : 3);
    return rank(ta.tier) - rank(tb.tier) || tb.fanIn - ta.fanIn;
  });

  const lines: string[] = [`[Structural context for this change — ${changed.length} file(s). Advisory: name-based, a lower bound.]`];
  for (const path of ordered) {
    const t = tiers.get(path)!;
    const defs = (g.defsByFile.get(path) ?? []).map((d) => d.name);
    const refMap = nbh.referrers.get(path);
    let block = `- ${path} — ${t.tier}${t.fanIn ? `, referenced by ${t.fanIn} file(s)` : ''}`;
    if (defs.length) block += `\n    defines: ${defs.slice(0, 8).join(', ')}${defs.length > 8 ? ` (+${defs.length - 8})` : ''}`;
    if (refMap && refMap.size) {
      const refs = [...refMap.entries()].slice(0, 4).map(([f, syms]) => `${f} (${[...syms].slice(0, 3).join(', ')})`);
      block += `\n    referenced by: ${refs.join('; ')}${refMap.size > 4 ? `; (+${refMap.size - 4} more)` : ''}`;
    }
    if (lines.join('\n').length + block.length + 1 > budget) {
      lines.push(`… (+${ordered.length - ordered.indexOf(path)} more files)`);
      break;
    }
    lines.push(block);
  }
  return lines.join('\n');
}
