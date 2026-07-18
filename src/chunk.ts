// Split a list into fixed-size batches. Used to keep bulk GitHub/OpenAI calls under
// per-request limits: sending everything at once risks a 413/timeout, while one-at-a-time
// wastes round-trips, so a bounded batch size trades a few requests for staying under limits.
export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error('chunk size must be >= 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
