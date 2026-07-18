// A token-bucket rate limiter. Tokens refill lazily on each call based on elapsed time, so
// there is no background timer ticking every bucket; the refill is amortized into the same
// request that spends a token. The cap prevents an idle client from banking a huge burst.
const CAPACITY = 20;
const WINDOW_MS = 60_000;
const buckets = new Map<string, { tokens: number; last: number }>();

// Bound the map so a flood of unique keys (e.g. spoofed IPs) can't grow it without limit.
// When it exceeds MAX_KEYS we evict the least-recently-used bucket, since the oldest 'last'
// is the client least likely to still be actively rate-limited.
const MAX_KEYS = 10_000;

function evictIfNeeded(): void {
  if (buckets.size <= MAX_KEYS) return;
  let oldestKey: string | null = null;
  let oldest = Infinity;
  for (const [k, v] of buckets) {
    if (v.last < oldest) { oldest = v.last; oldestKey = k; }
  }
  if (oldestKey) buckets.delete(oldestKey);
}

export function allow(key: string, now: number): boolean {
  const b = buckets.get(key) ?? { tokens: CAPACITY, last: now };
  const elapsed = now - b.last;
  b.tokens = Math.min(CAPACITY, b.tokens + elapsed * (CAPACITY / WINDOW_MS));
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  buckets.set(key, b);
  evictIfNeeded();
  return true;
}
