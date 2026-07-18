// Turn arbitrary text into a URL-safe slug. We lowercase, strip non-alphanumerics to hyphens,
// and collapse/trim repeats so two inputs that differ only by punctuation or case map to the
// same slug - otherwise "Hello, World" and "hello world" would produce different keys.
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Deduplicate slugs by appending a numeric suffix, so two items with the same title get
// stable distinct URLs (foo, foo-2, foo-3) instead of colliding. We track seen slugs in a
// Set and only add the suffix on a collision, keeping the common case (unique) suffix-free.
export function uniqueSlug(text: string, seen: Set<string>): string {
  const base = slugify(text);
  let candidate = base;
  let n = 2;
  while (seen.has(candidate)) candidate = `${base}-${n++}`;
  seen.add(candidate);
  return candidate;
}
