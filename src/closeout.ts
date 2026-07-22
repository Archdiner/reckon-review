import type { Decision, LlmBackend } from '@reckon/core';

/**
 * The DEPOSIT (the rich close). A passing explanation is the highest-value moment Reckon
 * has — nine minutes of real reasoning — and the old pass message spent it on one line
 * ("explained the mechanism. Merge unblocked."). This turns that moment into a deposit:
 * an honest, per-topic read of what the reviewer nailed, what was thinner, and where they
 * could have gone deeper. It is a PRESENTATION concern, not a gating one — a separate,
 * best-effort call that runs AFTER the gate already cleared, so on any failure it degrades
 * to the plain pass message and NEVER wedges or delays an already-earned merge.
 *
 * Cross-vendor, like the grader: GPT reads a (probably) Claude-written change, so the close
 * can't be self-preferential flattery. The bar is calibrated honesty, not praise.
 */

export type TopicVerdict = 'strong' | 'solid' | 'thin';

export interface TopicRead {
  concept: string;
  verdict: TopicVerdict;
  note: string; // one short line, specific to what they said
}

export interface Closeout {
  topics: TopicRead[];
  strongest: string; // the single best-explained point, named concretely
  growth_edge: string; // the one place they could have gone deeper
  one_line: string; // warm one-liner of what the log now holds
}

function closeoutSystemPrompt(decisions: Decision[]): string {
  const list = decisions.length
    ? decisions.map((d, i) => `  ${i + 1}. ${d.concept}: ${d.summary}`).join('\n')
    : '  (the change as a whole)';
  return [
    'You are Reckon writing the CLOSE after a reviewer has already PASSED a comprehension',
    'gate on a code change. They understood it well enough to merge — your job is not to',
    're-judge pass/fail, it is to give them an honest, specific, encouraging deposit of what',
    'their explanation demonstrated. This is the reward for real understanding; make it worth',
    'reading, and make it TRUE (calibrated, not flattery).',
    '',
    'The load-bearing topics of this change were:',
    list,
    '',
    "You are given the reviewer's cumulative explanation. For EACH topic, judge how well their",
    'explanation demonstrated understanding of THAT topic:',
    '  strong = named the real mechanism + a consequence/tradeoff not visible in a diff summary',
    '  solid  = correct mechanism, but stayed close to the surface / could go one level deeper',
    '  thin   = covered it, but mostly restated what it does rather than why it holds',
    '',
    'Then name: the single STRONGEST thing they showed (concretely), and the ONE growth edge —',
    'the place a senior engineer would have pushed further. Be specific to what they actually',
    'wrote; never generic ("good job", "clear explanation") — cite the actual idea.',
    '',
    'Respond with ONLY a JSON object (no prose, no code fences):',
    '{',
    '  "topics": [ { "concept": "<the topic>", "verdict": "strong|solid|thin", "note": "<one specific line>" } ],',
    '  "strongest": "<one sentence naming their best-explained point>",',
    '  "growth_edge": "<one sentence: where they could have gone deeper>",',
    '  "one_line": "<warm one-liner of what the log now records they understand>"',
    '}',
  ].join('\n');
}

function extractJson(raw: string): any | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

const VERDICTS = new Set<TopicVerdict>(['strong', 'solid', 'thin']);

/**
 * Produce the rich close for a passed gate. Best-effort: returns null on any failure
 * (grader error, unparseable output) so the caller falls back to the simple pass message —
 * a presentation nicety must never wedge or delay an already-earned merge.
 */
export async function closeout(
  decisions: Decision[],
  explanation: string,
  backend: LlmBackend
): Promise<Closeout | null> {
  const system = closeoutSystemPrompt(decisions);
  const user = ["THE REVIEWER'S EXPLANATION (they passed):", '"""', explanation.slice(0, 6000), '"""'].join('\n');

  let raw: string;
  try {
    raw = await backend.complete(system, user, { timeoutMs: 30_000 });
  } catch {
    return null;
  }

  const parsed = extractJson(raw);
  if (!parsed || !Array.isArray(parsed.topics)) return null;

  const topics: TopicRead[] = parsed.topics
    .map((t: any) => ({
      concept: String(t?.concept || '').slice(0, 120),
      verdict: (VERDICTS.has(t?.verdict) ? t.verdict : 'solid') as TopicVerdict,
      note: String(t?.note || '').slice(0, 240),
    }))
    .filter((t: TopicRead) => t.concept);

  if (topics.length === 0) return null;

  return {
    topics,
    strongest: String(parsed.strongest || '').slice(0, 400),
    growth_edge: String(parsed.growth_edge || '').slice(0, 400),
    one_line: String(parsed.one_line || '').slice(0, 300),
  };
}
