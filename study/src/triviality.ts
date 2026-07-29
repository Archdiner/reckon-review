/**
 * How much the record actually says, in three nested tiers.
 *
 * `emptyBody` — the record is the title alone — was the study's only exclusion level, and
 * reading the pilot by hand showed it is too lenient. `apache_airflow__51297` is flagged
 * non-empty, and its entire body is:
 *
 *     * Bring back mapped task extra links test
 *     * rebase and fixing test
 *
 * The first bullet restates the title verbatim; the second is a rebase note. There is no
 * mechanism in it, and no author intended there to be. Counting that PR as "the author wrote
 * a description" understates how much of the corpus carries nothing, and it does so in the
 * direction that flatters the record — exactly the wrong direction for this study's headline.
 *
 * So triviality is graded rather than binary:
 *
 *   empty      — no body at all; the record is the title.
 *   trivial    — a body exists but carries no content beyond the title: restatements of the
 *                title, and process chatter ("rebase and fixing test", "address review").
 *   substantive— everything else.
 *
 * The tiers NEST: every empty record is trivial. The analysis reports the headline at all
 * three levels so a reader can see how much of any gap lives in records that were never
 * really written.
 *
 * NOTE ON WHAT THIS IS NOT. This is not a quality filter and must never become one. It keys
 * on whether the author wrote anything beyond the title, never on whether what they wrote is
 * good. Excluding records for being *bad* would condition the sample on the outcome being
 * measured; excluding them for being *absent* is describing the sample.
 */

/** Lines that are pure process chatter and carry no information about the change. */
const CHATTER =
  /^(rebase|rebased?( and | )?(fix(ing|es|ed)?|updat(e|ing)|merg(e|ing))?|fix(ing|es|ed)? (tests?|lint|ci|typos?|review|comments?)|address(ing|ed)? (review|comments?|feedback)|update[sd]? (tests?|snapshots?|docs?)|lint|format(ting)?|cleanup|nit|wip|minor|typo|revert|bump|chore|no-?op|apply suggestions?|self[- ]review|pr feedback|see (title|above|description)|n\/?a|same as (title|above))\b/i;

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Token-overlap similarity in [0,1]. Used only to detect title restatement. */
function similarity(a: string, b: string): number {
  const ta = new Set(normalize(a).split(' ').filter(Boolean));
  const tb = new Set(normalize(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

export type RecordTier = 'empty' | 'trivial' | 'substantive';

export interface Triviality {
  tier: RecordTier;
  /** Characters of body text left after removing title restatements and process chatter. */
  novelChars: number;
  title: string;
}

/**
 * Characters of body that say something the title does not.
 *
 * A line is discarded when it restates the title (token overlap >= 0.8, which catches
 * "Bring back mapped task extra links test" against its own title while leaving a line that
 * merely shares a noun phrase) or when it is process chatter.
 */
const TRIVIAL_CHAR_FLOOR = 80;

export function classifyRecord(recordMd: string): Triviality {
  const lines = recordMd.split('\n');
  const titleLine = lines.find((l) => l.trim().length > 0) ?? '';
  const title = titleLine.replace(/^#+\s*/, '').trim();

  const bodyLines = lines.slice(lines.indexOf(titleLine) + 1);
  const body = bodyLines.join('\n').trim();
  if (!body) return { tier: 'empty', novelChars: 0, title };

  let novelChars = 0;
  for (const raw of bodyLines) {
    // Strip list markers and quote markers before judging the line's content.
    const line = raw.replace(/^\s*([-*+]|\d+\.|>)\s*/, '').trim();
    if (!line) continue;
    if (similarity(line, title) >= 0.8) continue;
    if (CHATTER.test(line)) continue;
    novelChars += normalize(line).length;
  }

  if (novelChars < TRIVIAL_CHAR_FLOOR) return { tier: 'trivial', novelChars, title };
  return { tier: 'substantive', novelChars, title };
}
