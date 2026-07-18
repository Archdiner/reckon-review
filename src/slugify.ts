// Turn arbitrary text into a URL-safe slug. We lowercase, strip non-alphanumerics to hyphens,
// and collapse/trim repeats so two inputs that differ only by punctuation or case map to the
// same slug - otherwise "Hello, World" and "hello world" would produce different keys.
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
