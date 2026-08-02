/**
 * FRESHNESS. A demonstration is a fact about a moment, not a permanent property of a person,
 * so a map built from raw demonstration counts lies within weeks: it shows a team fluent in
 * subsystems that have since been rewritten by someone else.
 *
 * The naive fix is a wall-clock timer ("expires after 90 days"). That is wrong in both
 * directions: it ages out a correct explanation of a file nobody has touched since, and it
 * keeps full credit for an area that was rewritten twice last Tuesday.
 *
 * So freshness here is TWO factors, and the second is the real idea:
 *
 *   age   — memory decays. Half-life in days.
 *   drift — the CODE MOVED UNDER THE DEMONSTRATION. Half-life in substantive changes landed in
 *           that same area since the person explained it. We already observe every one of those
 *           changes (every PR is a webhook), so drift costs nothing to measure. This is why
 *           checkpoints record their areas even when the gate is skipped: a skipped PR still
 *           moves the code, and still ages everyone's understanding of what it touched.
 *
 * Both are exponential so they compose by multiplication and neither ever hits exactly zero:
 * old understanding is weak evidence, not no evidence.
 */

/** Days after which an untouched demonstration is worth half as much. */
export const AGE_HALF_LIFE_DAYS = 120;

/** Substantive changes in the same area after which a demonstration is worth half as much. */
export const DRIFT_HALF_LIFE_CHANGES = 6;

/** Confidence at or above this counts as "this person currently understands this area". */
export const FRESH_FLOOR = 0.5;

/**
 * How much a verdict is worth before decay. `null` (the closeout failed, so we only know they
 * passed the gate) sits just under 'solid': a pass is real evidence, but we never saw the
 * per-topic read, so it must not outrank a topic explicitly graded 'solid'.
 */
export const STRENGTH: Record<string, number> = { strong: 1, solid: 0.7, thin: 0.4 };
export const STRENGTH_UNVERDICTED = 0.55;

export function strengthOf(verdict: string | null | undefined): number {
  if (!verdict) return STRENGTH_UNVERDICTED;
  return STRENGTH[verdict] ?? STRENGTH_UNVERDICTED;
}

export function daysBetween(from: Date | string, to: Date | string): number {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, (b - a) / 86_400_000);
}

/** age decay x drift decay, each a half-life curve, in [0, 1]. */
export function freshness(ageDays: number, changesSince: number): number {
  const age = Math.pow(0.5, Math.max(0, ageDays) / AGE_HALF_LIFE_DAYS);
  const drift = Math.pow(0.5, Math.max(0, changesSince) / DRIFT_HALF_LIFE_CHANGES);
  return age * drift;
}

/** What one demonstration is worth right now: how well it went, discounted by how stale it is. */
export function confidenceOf(
  verdict: string | null | undefined,
  ageDays: number,
  changesSince: number,
): number {
  return strengthOf(verdict) * freshness(ageDays, changesSince);
}

/**
 * A person's confidence in an area is the MAX over their demonstrations there, not the mean or
 * the sum. Mean punishes someone for having also explained a thin corner of the same area, and
 * sum lets ten shallow passes outrank one deep one. What you actually want to know is "is there
 * a live, strong demonstration to lean on", which is a max.
 */
export function rollup(confidences: number[]): number {
  return confidences.length ? Math.max(...confidences) : 0;
}

/** How an area stands for the team. Ordered worst to best; drives the status colour + icon. */
export type AreaStatus = 'unexplained' | 'stale' | 'single-point' | 'covered';

export function areaStatus(freshPeople: number, everDemonstrated: number): AreaStatus {
  if (freshPeople >= 2) return 'covered';
  if (freshPeople === 1) return 'single-point';
  if (everDemonstrated > 0) return 'stale';
  return 'unexplained';
}

export const AREA_STATUS_META: Record<AreaStatus, { label: string; icon: string; tone: 'good' | 'warning' | 'serious' | 'critical'; blurb: string }> = {
  covered: { label: 'Covered', icon: '●', tone: 'good', blurb: 'two or more people hold current understanding' },
  'single-point': { label: 'Single point', icon: '▲', tone: 'warning', blurb: 'exactly one person holds current understanding' },
  stale: { label: 'Stale', icon: '◆', tone: 'serious', blurb: 'explained before, but the code has moved or time has passed' },
  unexplained: { label: 'Unexplained', icon: '■', tone: 'critical', blurb: 'changed here, never explained by anyone' },
};
