/**
 * Step 2 — who, reduced to an opaque key.
 *
 * This module is the only place in the tool that ever sees a name or an email address, and
 * nothing it returns carries either. Downstream code receives `who`, a stable opaque key, and
 * literally cannot name an individual because it was never given the material to do it with.
 *
 * That is a structural guarantee rather than a convention, and it is deliberate: the design
 * rule "no individual is ever named in the output" is the difference between an engineering
 * artifact and an HR object, and a rule that depends on every future author remembering it is
 * a rule that will be broken.
 *
 * TWO JOBS.
 *
 * ALIASING. The same person commits as three addresses — work laptop, personal machine, a
 * GitHub noreply — and if they are counted as three contributors the tool invents bus factors
 * that do not exist and then reports them as risk. Normalisation merges on the email local
 * part and on the display name, transitively, via union-find.
 *
 * BOTS. Dependabot, renovate, release bots and CI accounts commit constantly and explain
 * nothing. Left in, they dominate churn and drag record coverage toward zero everywhere, and
 * every number the map reports becomes fiction. They are excluded entirely and counted.
 *
 * The aliasing rules are heuristics and will occasionally over-merge two people who share a
 * common display name ("admin", "root"). That direction of error is the safe one: over-merging
 * UNDERSTATES contributor count and therefore OVERSTATES concentration risk toward the region
 * being flagged for review, which is a cheap error. Under-merging invents a bus factor and
 * sends a false alarm to a customer, which is not.
 */

import { createHash } from 'node:crypto';

const BOT_EMAIL =
  /(^|[+.@-])(dependabot|renovate(bot)?|greenkeeper|snyk-bot|github-actions|actions-user|semantic-release|release-please|imgbot|allcontributors|pre-commit-ci|mergify|codecov|weblate|crowdin|transifex|restyled|whitesource|scala-steward|pyup|deepsource|sonarcloud|netlify|vercel|stale)\b/i;

const BOT_NAME =
  /(\[bot\]|^bot$|\bbot$|^dependabot|^renovate|^github[ -]?actions|^semantic-release|^release[ -]?please|^weblate|^crowdin|^transifex|^scala steward|^pre-commit ci|^mergify|^codecov|^snyk|^whitesource|^imgbot|^allcontributors|^stale)/i;

export function isBot(name: string, email: string): boolean {
  return BOT_NAME.test(name.trim()) || BOT_EMAIL.test(email.trim());
}

/**
 * Reduce an address to the identity it most likely denotes.
 *
 * - `1234567+octocat@users.noreply.github.com` → `octocat` (the numeric prefix is a user id,
 *   and the same person's older commits carry the un-prefixed form)
 * - `first.last+github@example.com` → `first.last` (subaddressing is per-service, not per-person)
 * - case is not meaningful in practice
 */
export function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0) return e;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  // The noreply case must be handled BEFORE generic subaddress stripping. GitHub's form is
  // `<userid>+<login>@users.noreply.github.com`, where the part after the `+` is the identity
  // and the part before it is a number — the opposite of ordinary subaddressing. Stripping
  // `+...` first would reduce the address to the numeric id and merge on that instead.
  if (domain === 'users.noreply.github.com') {
    return `gh:${local.replace(/^\d+\+/, '')}`;
  }
  return `${local.replace(/\+.*$/, '')}@${domain}`;
}

export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 .'-]/g, '');
}

/**
 * Display names too generic to merge on.
 *
 * Merging every commit authored as "root" into one identity would collapse whole teams into a
 * single contributor and report a bus factor of one for regions that have none.
 */
const GENERIC_NAME = /^(root|admin|user|ubuntu|runner|builder|ci|jenkins|unknown|n\/?a|.{0,2})$/;

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export interface IdentityResolution {
  /** Maps `${name}\x00${email}` to the opaque key. */
  keyFor: (name: string, email: string) => string;
  before: number;
  after: number;
}

/**
 * Build the identity map over the whole commit set, then hash each cluster to an opaque key.
 *
 * The hash is what makes the no-names guarantee structural: the returned key is a truncated
 * SHA-256 of the cluster root, so a downstream bug cannot print an address it never received.
 * It is stable within a run and across runs on the same history, which is what the
 * retrospective validation needs.
 */
export function resolveIdentities(commits: { authorName: string; authorEmail: string }[]): IdentityResolution {
  const uf = new UnionFind();
  const pairs: { name: string; email: string; ne: string; nn: string }[] = [];
  const seen = new Set<string>();

  for (const c of commits) {
    const raw = `${c.authorName}\x00${c.authorEmail}`;
    if (seen.has(raw)) continue;
    seen.add(raw);
    const ne = normalizeEmail(c.authorEmail);
    const nn = normalizeName(c.authorName);
    pairs.push({ name: c.authorName, email: c.authorEmail, ne, nn });
    uf.union(`e:${ne}`, `e:${ne}`);
    if (nn && !GENERIC_NAME.test(nn)) uf.union(`e:${ne}`, `n:${nn}`);
  }

  const clusters = new Set<string>();
  for (const p of pairs) clusters.add(uf.find(`e:${p.ne}`));

  const keyFor = (name: string, email: string): string => {
    const root = uf.find(`e:${normalizeEmail(email)}`);
    // The name is deliberately not part of the hashed material beyond its role in clustering,
    // so two spellings of one person yield one key.
    void name;
    return createHash('sha256').update(root).digest('hex').slice(0, 12);
  };

  return { keyFor, before: pairs.length, after: clusters.size };
}
