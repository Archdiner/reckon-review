/**
 * Objective eval harness for the codebase graph (run: `npx tsx src/graph/eval.ts`).
 *
 * Answers, with numbers, the three questions we committed to proving:
 *   1. Does it WORK?       edge precision / recall vs hand-labeled ground truth
 *   2. Good COVERAGE?      blast-radius (neighborhood) recall on a changed file
 *   3. Executed EFFICIENTLY? build+rank+serialize time and context size vs budget
 *
 * It is deliberately honest about the advisory ceiling: one fixture is a dynamic-dispatch case
 * that name-based extraction CANNOT resolve, so aggregate recall is < 100% by construction. That
 * gap is the point — it's the measured version of "a lower bound on blast radius" (docs §3).
 */
import { buildGraph, criticality, neighborhood, serializeContext, pathTier, type RepoFile, type Tier } from './repo-map.js';

interface Fixture {
  name: string;
  files: RepoFile[];
  edges: Array<[string, string]>; // ground-truth file→file reference edges
  tiers: Record<string, Tier>; // ground-truth criticality
  coverageFor?: string; // a changed file whose referrer-recall we measure
  coverageReferrers?: string[]; // its ground-truth referrer files
  unrecoverable?: number; // # of ground-truth edges name-based extraction can't see (documented)
}

const F = (path: string, content: string): RepoFile => ({ path, content });

const fixtures: Fixture[] = [
  {
    name: 'layered-app (happy path)',
    files: [
      F('src/db/pool.ts', `export function createPool(){ return {}; }\nexport function getConn(){ return createPool(); }`),
      F('src/auth/session.ts', `import { getConn } from "../db/pool";\nexport function createSession(u:any){ return getConn(); }\nexport function validateSession(t:any){ return getConn(); }`),
      F('src/api/login.ts', `import { validateSession, createSession } from "../auth/session";\nexport function login(r:any){ createSession(r); return validateSession(r); }`),
      F('src/api/logout.ts', `import { validateSession } from "../auth/session";\nexport function logout(r:any){ return validateSession(r); }`),
      F('src/middleware/auth.ts', `import { validateSession } from "../auth/session";\nexport function requireAuth(r:any){ return validateSession(r); }`),
      F('src/ui/button.css', `.button { color: red; }`),
      F('README.md', `# hello`),
    ],
    edges: [
      ['src/auth/session.ts', 'src/db/pool.ts'],
      ['src/api/login.ts', 'src/auth/session.ts'],
      ['src/api/logout.ts', 'src/auth/session.ts'],
      ['src/middleware/auth.ts', 'src/auth/session.ts'],
    ],
    tiers: { 'src/auth/session.ts': 'core', 'src/db/pool.ts': 'core', 'src/ui/button.css': 'peripheral', 'README.md': 'trivial' },
    coverageFor: 'src/auth/session.ts',
    coverageReferrers: ['src/api/login.ts', 'src/api/logout.ts', 'src/middleware/auth.ts'],
  },
  {
    name: 'service (methods + new)',
    files: [
      F('src/services/order.ts', `export class OrderService { run(){ return 1; } }`),
      F('src/api/orders.ts', `import { OrderService } from "../services/order";\nexport function handle(){ const s = new OrderService(); return s.run(); }`),
    ],
    edges: [['src/api/orders.ts', 'src/services/order.ts']],
    tiers: { 'src/services/order.ts': 'core', 'src/api/orders.ts': 'core' },
  },
  {
    name: 'dynamic-dispatch (KNOWN MISS — the advisory ceiling)',
    files: [
      F('src/handlers/registry.ts', `export function start(){ return 1; }\nexport function stop(){ return 0; }`),
      F('src/handlers/dispatch.ts', `import * as reg from "./registry";\nexport function dispatch(name:string){ const fn = (reg as any)[name]; return fn(); }`),
    ],
    edges: [['src/handlers/dispatch.ts', 'src/handlers/registry.ts']],
    tiers: { 'src/handlers/registry.ts': 'core', 'src/handlers/dispatch.ts': 'core' },
    unrecoverable: 1, // the only edge is dynamic → name-based cannot see it (expected miss)
  },
];

function engineEdges(g: ReturnType<typeof buildGraph>): Set<string> {
  const s = new Set<string>();
  for (const [from, tos] of g.out) for (const to of tos.keys()) s.add(`${from} -> ${to}`);
  return s;
}

function main(): void {
  let truePos = 0, falsePos = 0, groundTruth = 0, unrecoverable = 0;
  let tierCorrect = 0, tierTotal = 0;
  const cov: Array<{ name: string; got: number; want: number }> = [];

  for (const fx of fixtures) {
    const g = buildGraph(fx.files);
    const edges = engineEdges(g);
    const truth = new Set(fx.edges.map(([a, b]) => `${a} -> ${b}`));
    for (const e of truth) (edges.has(e) ? truePos++ : void 0);
    for (const e of edges) (truth.has(e) ? void 0 : falsePos++);
    groundTruth += truth.size;
    unrecoverable += fx.unrecoverable ?? 0;

    for (const [path, want] of Object.entries(fx.tiers)) {
      const got = criticality(g, [path])[0];
      tierTotal++;
      if (got.tier === want) tierCorrect++;
      else console.log(`   tier miss: ${path} want=${want} got=${got.tier} (${got.reason})`);
    }

    if (fx.coverageFor && fx.coverageReferrers) {
      const n = neighborhood(g, [fx.coverageFor]);
      const found = n.referrers.get(fx.coverageFor);
      const got = fx.coverageReferrers.filter((r) => found?.has(r)).length;
      cov.push({ name: fx.name, got, want: fx.coverageReferrers.length });
    }
  }

  const recall = truePos / groundTruth;
  const recoverableRecall = truePos / (groundTruth - unrecoverable);
  const precision = truePos + falsePos === 0 ? 1 : truePos / (truePos + falsePos);

  // Efficiency: generate a synthetic repo of N files and time the full pipeline.
  const N = 300;
  const bigFiles: RepoFile[] = [];
  for (let i = 0; i < N; i++) {
    let c = `import { dep_${(i + 1) % N} } from "./mod${(i + 1) % N}";\n`;
    c += `export function fn_${i}(){ return dep_${(i + 1) % N}(); }\n`;
    c += `export function dep_${i}(){ return ${i}; }\n`;
    bigFiles.push(F(`src/mod${i}.ts`, c));
  }
  const t0 = Date.now();
  const bg = buildGraph(bigFiles);
  const changed = ['src/mod0.ts', 'src/mod1.ts', 'src/mod2.ts'];
  const ctx = serializeContext(bg, changed, 1200);
  const ms = Date.now() - t0;

  const p = (x: number) => `${(x * 100).toFixed(1)}%`;
  const ok = (b: boolean) => (b ? '✓' : '✗');
  console.log('\n=== Codebase graph — objective eval ===\n');
  console.log('1. CORRECTNESS (edge precision/recall vs hand-labeled ground truth)');
  console.log(`   precision            ${p(precision)}   ${ok(precision >= 0.9)}  (>=90%)`);
  console.log(`   recall (all edges)   ${p(recall)}   incl. ${unrecoverable} known-unrecoverable (dynamic dispatch)`);
  console.log(`   recall (recoverable) ${p(recoverableRecall)}   ${ok(recoverableRecall >= 0.99)}  (=100% on statically-resolvable edges)`);
  console.log(`   criticality tiering  ${tierCorrect}/${tierTotal}   ${ok(tierCorrect === tierTotal)}`);
  console.log('\n2. COVERAGE (blast-radius / neighborhood recall on a changed file)');
  for (const c of cov) console.log(`   ${c.name}: recovered ${c.got}/${c.want} true referrers   ${ok(c.got === c.want)}`);
  console.log('\n3. EFFICIENCY (full pipeline on a synthetic repo)');
  console.log(`   ${N} files, build+rank+serialize   ${ms}ms   ${ok(ms < 1000)}  (<1000ms)`);
  console.log(`   serialized context size            ${ctx.length} chars   ${ok(ctx.length <= 1200)}  (<=budget 1200)`);

  // 4. POLICY (criticality → gate behavior)
  const policyCases: Array<[string, Tier]> = [
    ['src/ui/button.css', 'peripheral'],
    ['src/api/login.test.ts', 'peripheral'],
    ['config/app.json', 'peripheral'],
    ['README.md', 'trivial'],
    ['src/auth/session.ts', 'core'],
    ['src/components/Button.tsx', 'core'], // frontend LOGIC still gates (not peripheral)
  ];
  const policyOk = policyCases.filter(([p, t]) => pathTier(p) === t).length;
  const peripheralOnlySkips = ['a.css', 'b.test.ts', 'c.md', 'd.json'].every((f) => pathTier(f) !== 'core');
  const mixedGates = !['a.css', 'src/core.ts'].every((f) => pathTier(f) !== 'core'); // has a .ts → must gate
  console.log('\n4. POLICY (criticality → gate behavior)');
  console.log(`   path tiering          ${policyOk}/${policyCases.length}   ${ok(policyOk === policyCases.length)}`);
  console.log(`   peripheral-only → skip   ${ok(peripheralOnlySkips)}   (css+test+md+json auto-pass)`);
  console.log(`   any source file → gate   ${ok(mixedGates)}   (css + .ts still gates)`);

  const pass =
    precision >= 0.9 &&
    recoverableRecall >= 0.99 &&
    tierCorrect === tierTotal &&
    cov.every((c) => c.got === c.want) &&
    ms < 1000 &&
    ctx.length <= 1200 &&
    policyOk === policyCases.length &&
    peripheralOnlySkips &&
    mixedGates;
  console.log(`\n==> GRAPH EVAL: ${pass ? 'PASS' : 'FAIL'}  (recoverable edges exact; dynamic dispatch is a documented, advisory lower bound)\n`);
  process.exit(pass ? 0 : 1);
}

main();
