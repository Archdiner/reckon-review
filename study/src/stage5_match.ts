/**
 * Stage 5 — match agent PRs to human PRs.
 *
 * The protocol calls matching non-optional, and it is right to: agent-opened PRs skew small
 * and skew toward particular languages, so an unmatched comparison would mostly be measuring
 * "agent PRs are different sizes" and the first reviewer to look would say so.
 *
 * Matching is exact on (language, size bucket) and one-to-one without replacement, which is
 * the strictest version and the easiest to defend. The cost is discarded data — any stratum
 * with agents but no humans, or the reverse, contributes nothing.
 *
 * That cost is reported rather than hidden. `unmatched` in the output is the number of PRs
 * that fell out, per arm, and the writeup is expected to quote it: a matched comparison over
 * 180 pairs drawn from 900 PRs is a different claim from one over 450 pairs, and a reader
 * cannot tell which they are looking at unless told.
 *
 * The full corpus is still analysed unmatched for the overall answerability and
 * real-vs-synthetic numbers, which do not involve the agent/human contrast and therefore do
 * not need matching. Only analysis (3) uses these pairs.
 */

import { prDirs, readMeta, has } from './io.js';
import type { PrMeta } from './types.js';

export interface MatchPair {
  agent: string;
  human: string;
  language: string;
  sizeBucket: string;
}

export interface MatchResult {
  pairs: MatchPair[];
  unmatched: { agent: number; human: number };
  strata: { key: string; agent: number; human: number; paired: number }[];
}

function seedFrom(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param evidenceFilter restrict the agent arm to particular provenance evidence. Passing
 *        `['bot-author']` reruns the contrast on genuine agent AUTHORSHIP only, which is the
 *        robustness check the weaker trailer-based labels demand (see provenance.ts).
 */
export function matchCorpus(root: string, seed: string, evidenceFilter?: string[]): MatchResult {
  const metas: PrMeta[] = prDirs(root)
    .filter((d) => has(d, 'scores.json'))
    .map(readMeta);

  const rng = mulberry32(seedFrom(seed));
  const shuffle = <T,>(xs: T[]) => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const agents = metas.filter(
    (m) => m.provenance === 'agent' && (!evidenceFilter || evidenceFilter.includes(m.evidence))
  );
  const humans = metas.filter((m) => m.provenance === 'human');

  const key = (m: PrMeta) => `${m.language}|${m.sizeBucket}`;
  const bucket = <T,>(xs: PrMeta[]) => {
    const map = new Map<string, PrMeta[]>();
    for (const m of xs) {
      const k = key(m);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(m);
    }
    return map;
  };

  const aMap = bucket(agents);
  const hMap = bucket(humans);

  const pairs: MatchPair[] = [];
  const strata: MatchResult['strata'] = [];
  let pairedAgents = 0;

  for (const k of new Set([...aMap.keys(), ...hMap.keys()])) {
    const a = shuffle(aMap.get(k) ?? []);
    const h = shuffle(hMap.get(k) ?? []);
    const n = Math.min(a.length, h.length);
    for (let i = 0; i < n; i++) {
      pairs.push({ agent: a[i].id, human: h[i].id, language: a[i].language, sizeBucket: a[i].sizeBucket });
    }
    pairedAgents += n;
    strata.push({ key: k, agent: a.length, human: h.length, paired: n });
  }

  strata.sort((x, y) => y.paired - x.paired || x.key.localeCompare(y.key));

  return {
    pairs,
    unmatched: { agent: agents.length - pairedAgents, human: humans.length - pairedAgents },
    strata,
  };
}
