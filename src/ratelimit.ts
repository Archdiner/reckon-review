// A token-bucket rate limiter. Tokens refill lazily on each call based on elapsed time, so
// there is no background timer ticking every bucket; the refill is amortized into the same
// request that spends a token. The cap prevents an idle client from banking a huge burst.
const CAPACITY = 20;
const WINDOW_MS = 60_000;
const buckets = new Map<string, { tokens: number; last: number }>();

export function allow(key: string, now: number): boolean {
  const b = buckets.get(key) ?? { tokens: CAPACITY, last: now };
  const elapsed = now - b.last;
  b.tokens = Math.min(CAPACITY, b.tokens + elapsed * (CAPACITY / WINDOW_MS));
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}
