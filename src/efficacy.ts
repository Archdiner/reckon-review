/**
 * Grader efficacy re-validation for the Vouch grader (gpt-5.4-mini via the OpenAI backend).
 * The SAME 8-scenario × 2-rigor battery that validated the original Haiku grader (0 false
 * pass/fail), now run through @reckon/core's real grade() path. This is the go/no-go: a
 * grader that mis-scores is worse than no gate.
 */
import { grade } from '@reckon/core';
import type { RigorLevel } from '@reckon/core';
import { loadConfig } from './config.js';
import { OpenAiBackend } from './grader/openai.js';

const GROUND_TRUTH = `
PLAN: Add a token-bucket rate limiter to the public /api/ingest endpoint.

Diff:
+ // Refill continuously: tokens += elapsedMs * (capacity / windowMs), capped at capacity.
+ function allow(key: string): boolean {
+   const b = buckets.get(key) ?? { tokens: CAPACITY, last: now() };
+   const elapsed = now() - b.last;
+   b.tokens = Math.min(CAPACITY, b.tokens + elapsed * (CAPACITY / WINDOW_MS));
+   b.last = now();
+   if (b.tokens < 1) return false;   // reject, do not decrement
+   b.tokens -= 1;
+   buckets.set(key, b);
+   return true;
+ }
+ // buckets is an in-process Map keyed by client IP.
`.trim();

interface Scenario { name: string; explanation: string; assisted: boolean; rigors: RigorLevel[]; expected: Record<string, boolean>; }

const SCENARIOS: Scenario[] = [
  { name: '1. STRONG mechanistic', assisted: false, rigors: ['medium', 'harsh'], expected: { medium: true, harsh: true },
    explanation: "The bucket refills lazily on read rather than on a timer: each call computes how much time elapsed and adds that fraction of a token, so we never need a background job ticking every client's bucket — the math amortizes the refill into the same request that spends a token. That's why it caps at CAPACITY: without the cap a client idle for an hour would bank thousands of tokens and could then burst past the intended rate, defeating the limiter. Keying by IP in an in-process Map is the fragile part — the moment you run two instances behind a load balancer each has its own Map, so a client gets N times the limit. It'd break the guarantee unless the buckets move to shared state like Redis." },
  { name: '2. PURE RESTATEMENT', assisted: false, rigors: ['medium', 'harsh'], expected: { medium: false, harsh: false },
    explanation: "It adds a token-bucket rate limiter to the public /api/ingest endpoint. The allow function refills continuously: tokens plus elapsedMs times capacity over windowMs, capped at capacity. If tokens is less than 1 it rejects and does not decrement, otherwise it subtracts 1. The buckets is an in-process Map keyed by client IP." },
  { name: '3. CONFIDENT BUT WRONG', assisted: false, rigors: ['medium', 'harsh'], expected: { medium: false, harsh: false },
    explanation: "This is a fixed-window counter: it resets the count to zero at the start of every window, so a client gets exactly CAPACITY requests per window and the counter is wiped on the boundary. It rejects by returning false once the counter hits the cap, and because it's a hard reset there's no burst smoothing — the whole allowance frees up at once each window. Storing it in a database row keyed by IP means it's shared across all servers automatically." },
  { name: '4. NAMES PARTS, NO MECHANISM', assisted: false, rigors: ['medium', 'harsh'], expected: { medium: false, harsh: false },
    explanation: "It uses a Map to hold buckets and a token count per client. There's a capacity and a window. The allow function checks the tokens and either lets the request through or rejects it. It's keyed by IP. So it rate-limits the ingest endpoint using a token bucket." },
  { name: '5. PARTIAL (medium yes, harsh no)', assisted: false, rigors: ['medium', 'harsh'], expected: { medium: true, harsh: false },
    explanation: "It refills the bucket based on elapsed time so it doesn't need a timer, and it caps the tokens so an idle client can't hoard a huge burst. It rejects when there aren't enough tokens. It's keyed by IP in a Map." },
  { name: '6. VERBOSE FLUENT SLOP', assisted: false, rigors: ['medium', 'harsh'], expected: { medium: false, harsh: false },
    explanation: "This is a really elegant and thoughtful piece of engineering that demonstrates a deep and nuanced understanding of the challenges inherent in modern distributed rate limiting at scale. The token-bucket approach chosen here is widely regarded across the industry as an excellent, battle-tested, production-grade pattern, and its adoption in this context reflects strong architectural judgment and a commitment to robustness. The implementation carefully manages tokens, capacity, and windows in a clean and maintainable way, striking a beautiful balance between simplicity and correctness. Rate limiting is of course critically important for protecting public endpoints from abuse, ensuring fairness, and maintaining system stability under load, and this solution addresses all of those concerns admirably. Overall this is exactly the kind of high-quality, well-considered code one hopes to see." },
  { name: '7. EMPTY / garbage', assisted: false, rigors: ['medium', 'harsh'], expected: { medium: false, harsh: false },
    explanation: 'idk it limits stuff. asdf.' },
  { name: '8. ASSISTED PARROT', assisted: true, rigors: ['medium', 'harsh'], expected: { medium: false, harsh: false },
    explanation: "Looking at the code: the allow function gets the bucket for the key or makes a new one at CAPACITY, computes elapsed = now minus last, sets tokens to the min of CAPACITY and tokens plus elapsed times CAPACITY over WINDOW_MS, updates last to now, and if tokens is under 1 returns false without decrementing, else subtracts 1 and returns true. The Map is keyed by client IP." },
];

async function main() {
  const cfg = loadConfig();
  const backend = new OpenAiBackend(cfg.openaiApiKey, cfg.graderModel);
  console.log(`grader model: ${cfg.graderModel}\n`);

  let total = 0, correct = 0, falsePass = 0, falseFail = 0;
  for (const sc of SCENARIOS) {
    for (const rigor of sc.rigors) {
      const g = await grade({ groundTruth: GROUND_TRUTH, explanation: sc.explanation, rigor, assisted: sc.assisted, backend });
      const expected = sc.expected[rigor];
      const ok = g.pass === expected && !g.ungraded;
      total++; if (ok) correct++;
      if (g.pass && !expected) falsePass++;
      if (!g.pass && expected) falseFail++;
      console.log(`  ${ok ? 'OK' : 'XX'} [${rigor.padEnd(6)}] exp=${expected ? 'PASS' : 'FAIL'} act=${g.pass ? 'PASS' : 'FAIL'}  ${sc.name}`);
      if (!ok) console.log(`       scores=${JSON.stringify(g.scores)} overlap=${g.overlap}`);
    }
  }
  console.log(`\n===== SUMMARY (gpt-5.4-mini) =====`);
  console.log(`accuracy = ${correct}/${total} (${Math.round((correct / total) * 100)}%)`);
  console.log(`false-PASS (slop waved through) = ${falsePass}   ← the dangerous one`);
  console.log(`false-FAIL (real understanding blocked) = ${falseFail}`);
  process.exit(falsePass > 0 ? 1 : 0);
}
main().catch((e) => { console.error('efficacy error:', e?.message || e); process.exit(1); });
