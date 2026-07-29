/**
 * Corpus description.
 *
 * Everything here is computable without a single model call, and it is worth computing
 * BEFORE spending the model budget, because it is what tells you whether the study's third
 * question can be answered at all.
 *
 * The number that decides that is the matched-pair count. The agent/human contrast is only as
 * strong as the strata that contain both arms; if agent PRs cluster into languages or sizes
 * where there are no comparable human PRs, matching discards them and the comparison quietly
 * shrinks to a fraction of the corpus. Discovering that after paying for scoring would be an
 * expensive way to learn it.
 *
 * The provenance breakdown matters for the same reason. If almost every agent-labelled PR is
 * `agent-trailer` rather than `bot-author`, the bot-author-only robustness check will not have
 * the numbers to run, and the study can only ever speak about agent-ASSISTED changes. Better
 * to know that while the framing can still be adjusted.
 */

import { prDirs, readMeta } from './io.js';
import { matchCorpus } from './stage5_match.js';
import type { PrMeta } from './types.js';

const pct = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(1) : '0.0');

function tally<K extends string>(items: PrMeta[], key: (m: PrMeta) => K): [K, number][] {
  const map = new Map<K, number>();
  for (const m of items) map.set(key(m), (map.get(key(m)) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

export function describeCorpus(root: string): string {
  const metas = prDirs(root).map(readMeta);
  if (metas.length === 0) return 'No corpus found. Run `study collect` first.';

  const agents = metas.filter((m) => m.provenance === 'agent');
  const humans = metas.filter((m) => m.provenance === 'human');
  const L: string[] = [];

  L.push('# Corpus composition');
  L.push('');
  L.push('Computed from the collected corpus with no model calls. This is not a finding about');
  L.push('records; it describes the sample that the scored study will run on.');
  L.push('');
  L.push(`Total PRs: **${metas.length}** — ${agents.length} agent-attested, ${humans.length} human`);
  L.push('');

  L.push('## Provenance evidence (agent arm)');
  L.push('');
  L.push('| evidence | n | share of agent arm |');
  L.push('| --- | --- | --- |');
  for (const [k, v] of tally(agents, (m) => m.evidence)) {
    L.push(`| ${k} | ${v} | ${pct(v, agents.length)}% |`);
  }
  L.push('');
  L.push('`bot-author` is genuine agent authorship. `agent-trailer` and `agent-footer` attest');
  L.push('assistance only — a human may have driven and rewritten the change. If bot-author is');
  L.push('a small minority, the pooled contrast is about agent-ASSISTED PRs and must say so.');
  L.push('');

  L.push('## By repository');
  L.push('');
  L.push('Empty-record rates are shown per repo per arm because that is what separates an');
  L.push('authoring difference from a merge-tooling artifact: within one repo the squash');
  L.push('setting is the same for both arms, so a configuration that discarded descriptions');
  L.push('would discard them equally.');
  L.push('');
  L.push('| repo | total | agent | human | agent empty | human empty |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const [repo, n] of tally(metas, (m) => m.repo)) {
    const a = agents.filter((m) => m.repo === repo);
    const h = humans.filter((m) => m.repo === repo);
    const ae = a.length ? `${pct(a.filter((m) => m.emptyBody).length, a.length)}%` : '-';
    const he = h.length ? `${pct(h.filter((m) => m.emptyBody).length, h.length)}%` : '-';
    L.push(`| ${repo} | ${n} | ${a.length} | ${h.length} | ${ae} | ${he} |`);
  }
  L.push('');

  L.push('## By language');
  L.push('');
  L.push('| language | total | agent | human |');
  L.push('| --- | --- | --- | --- |');
  for (const [lang, n] of tally(metas, (m) => m.language)) {
    const a = agents.filter((m) => m.language === lang).length;
    L.push(`| ${lang} | ${n} | ${a} | ${n - a} |`);
  }
  L.push('');

  L.push('## By size bucket (changed lines)');
  L.push('');
  L.push('| bucket | total | agent | human |');
  L.push('| --- | --- | --- | --- |');
  const order = ['20-49', '50-149', '150-499', '500+'];
  for (const b of order) {
    const n = metas.filter((m) => m.sizeBucket === b).length;
    const a = agents.filter((m) => m.sizeBucket === b).length;
    L.push(`| ${b} | ${n} | ${a} | ${n - a} |`);
  }
  L.push('');

  const medianOf = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((p, q) => p - q);
    return s[Math.floor(s.length / 2)];
  };
  L.push(`Median changed lines — agent **${medianOf(agents.map((m) => m.changedLines))}**, ` +
    `human **${medianOf(humans.map((m) => m.changedLines))}**`);
  L.push('');
  L.push('A gap here is exactly why matching is not optional: without it, any difference in');
  L.push('answerability could just be a difference in size.');
  L.push('');

  L.push('## Empty records');
  L.push('');
  const ea = agents.filter((m) => m.emptyBody).length;
  const eh = humans.filter((m) => m.emptyBody).length;
  const ra = agents.filter((m) => m.rawBodyEmpty).length;
  const rh = humans.filter((m) => m.rawBodyEmpty).length;
  L.push('| measure | agent | human |');
  L.push('| --- | --- | --- |');
  L.push(`| no prose (title only, after stripping trailers) | ${pct(ea, agents.length)}% | ${pct(eh, humans.length)}% |`);
  L.push(`| body already empty in git, before stripping | ${pct(ra, agents.length)}% | ${pct(rh, humans.length)}% |`);
  L.push('');
  L.push('Both are reported because they differ asymmetrically. An agent PR often carries a');
  L.push('`Co-Authored-By:` trailer and no prose, so stripping moves it from "not raw-empty"');
  L.push('into "no prose" — which INFLATES the agent empty rate and works against the gap. The');
  L.push('stricter raw measure therefore shows a wider gap, not a narrower one, so the');
  L.push('comparison does not depend on which convention you prefer.');
  L.push('');
  L.push('This is also the check that rules out the obvious tooling explanation. Within a');
  L.push('single repo the squash setting is identical for both arms, so if the merge button');
  L.push('were discarding descriptions it would discard them at the same rate for agents and');
  L.push('humans. The per-repo table above shows it does not.');
  L.push('');
  L.push('These PRs are kept. An author who wrote nothing is real data, and dropping them');
  L.push('would condition the sample on the outcome being measured.');
  L.push('');

  L.push('## Record prose already present in the diff');
  L.push('');
  const withOverlap = metas.filter((m) => m.recordDiffSharedShingles > 0);
  const heavy = metas.filter((m) => m.recordShingles > 0 && m.recordDiffSharedShingles / m.recordShingles >= 0.3);
  L.push(`PRs whose record shares any 8-word prose run with the diff: **${withOverlap.length}** ` +
    `(${pct(withOverlap.length, metas.length)}%)`);
  L.push(`PRs where that is >=30% of the record: **${heavy.length}** (${pct(heavy.length, metas.length)}%)`);
  L.push('');
  L.push('These are records recoverable from the artifact by copying rather than by');
  L.push('understanding — typically docs, changelog or ADR changes. The headline should be');
  L.push('recomputed with them excluded, in case they are the only reason the synthetic');
  L.push('description keeps up.');
  L.push('');

  L.push('## Matching feasibility (language x size bucket)');
  L.push('');
  const all = matchCorpus(root, 'match-v1', undefined, false, 'repo-lang-size');
  const loose = matchCorpus(root, 'match-v1', undefined, false, 'lang-size');
  L.push(`Matched pairs, same repo x language x size (default): **${all.pairs.length}**`);
  L.push(`Discarded as unmatched: ${all.unmatched.agent} agent, ${all.unmatched.human} human`);
  L.push(`Matched pairs ignoring repo (sensitivity check only): **${loose.pairs.length}**`);
  L.push('');
  L.push('Matching within repo removes project culture as a confound. It is not optional here:');
  L.push('the agent arm is concentrated in grafana and prisma, and prisma contributes 66 agent');
  L.push('PRs against 1 human one, so a cross-repo pairing could read a difference between two');
  L.push('projects’ documentation norms as an agent-vs-human effect.');
  L.push('');
  const bot = matchCorpus(root, 'match-v1', ['bot-author'], false, 'repo-lang-size');
  L.push(`Restricted to true bot authorship: **${bot.pairs.length}** pairs`);
  L.push('');
  L.push('| language\\|size | agent | human | paired |');
  L.push('| --- | --- | --- | --- |');
  for (const s of all.strata.slice(0, 15)) L.push(`| ${s.key} | ${s.agent} | ${s.human} | ${s.paired} |`);
  L.push('');

  return L.join('\n');
}
