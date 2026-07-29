# Corpus composition

Computed from the collected corpus with no model calls. This is not a finding about
records; it describes the sample that the scored study will run on.

Total PRs: **1000** — 500 agent-attested, 500 human

## Provenance evidence (agent arm)

| evidence | n | share of agent arm |
| --- | --- | --- |
| agent-trailer | 465 | 93.0% |
| agent-footer | 21 | 4.2% |
| bot-author | 14 | 2.8% |

`bot-author` is genuine agent authorship. `agent-trailer` and `agent-footer` attest
assistance only — a human may have driven and rewritten the change. If bot-author is
a small minority, the pooled contrast is about agent-ASSISTED PRs and must say so.

## By repository

Empty-record rates are shown per repo per arm because that is what separates an
authoring difference from a merge-tooling artifact: within one repo the squash
setting is the same for both arms, so a configuration that discarded descriptions
would discard them equally.

| repo | total | agent | human | agent empty | human empty |
| --- | --- | --- | --- | --- | --- |
| grafana/grafana | 441 | 237 | 204 | 2.1% | 28.4% |
| apache/airflow | 227 | 65 | 162 | 9.2% | 35.8% |
| supabase/supabase | 192 | 109 | 83 | 0.9% | 10.8% |
| langchain-ai/langchain | 71 | 23 | 48 | 4.3% | 37.5% |
| prisma/prisma | 69 | 66 | 3 | 0.0% | 66.7% |

## By language

| language | total | agent | human |
| --- | --- | --- | --- |
| TypeScript | 406 | 230 | 176 |
| Python | 244 | 74 | 170 |
| Go | 224 | 137 | 87 |
| JSON | 52 | 27 | 25 |
| YAML | 27 | 10 | 17 |
| Other | 16 | 6 | 10 |
| JavaScript | 11 | 8 | 3 |
| TOML | 7 | 4 | 3 |
| Shell | 5 | 1 | 4 |
| HTML | 3 | 2 | 1 |
| XML | 2 | 0 | 2 |
| Kotlin | 1 | 0 | 1 |
| Vue | 1 | 1 | 0 |
| CSS | 1 | 0 | 1 |

## By size bucket (changed lines)

| bucket | total | agent | human |
| --- | --- | --- | --- |
| 20-49 | 207 | 84 | 123 |
| 50-149 | 257 | 116 | 141 |
| 150-499 | 297 | 150 | 147 |
| 500+ | 239 | 150 | 89 |

Median changed lines — agent **208**, human **135**

A gap here is exactly why matching is not optional: without it, any difference in
answerability could just be a difference in size.

## Empty records

| measure | agent | human |
| --- | --- | --- |
| no prose (title only, after stripping trailers) | 2.6% | 29.0% |
| body already empty in git, before stripping | 0.2% | 26.4% |

Both are reported because they differ asymmetrically. An agent PR often carries a
`Co-Authored-By:` trailer and no prose, so stripping moves it from "not raw-empty"
into "no prose" — which INFLATES the agent empty rate and works against the gap. The
stricter raw measure therefore shows a wider gap, not a narrower one, so the
comparison does not depend on which convention you prefer.

This is also the check that rules out the obvious tooling explanation. Within a
single repo the squash setting is identical for both arms, so if the merge button
were discarding descriptions it would discard them at the same rate for agents and
humans. The per-repo table above shows it does not.

These PRs are kept. An author who wrote nothing is real data, and dropping them
would condition the sample on the outcome being measured.

## Record prose already present in the diff

PRs whose record shares any 8-word prose run with the diff: **30** (3.0%)
PRs where that is >=30% of the record: **3** (0.3%)

These are records recoverable from the artifact by copying rather than by
understanding — typically docs, changelog or ADR changes. The headline should be
recomputed with them excluded, in case they are the only reason the synthetic
description keeps up.

## Matching feasibility (language x size bucket)

Matched pairs, same repo x language x size (default): **323**
Discarded as unmatched: 177 agent, 177 human
Matched pairs ignoring repo (sensitivity check only): **356**

Matching within repo removes project culture as a confound. It is not optional here:
the agent arm is concentrated in grafana and prisma, and prisma contributes 66 agent
PRs against 1 human one, so a cross-repo pairing could read a difference between two
projects’ documentation norms as an agent-vs-human effect.

Restricted to true bot authorship: **13** pairs

| language\|size | agent | human | paired |
| --- | --- | --- | --- |
| grafana/grafana|Go|150-499 | 46 | 29 | 29 |
| grafana/grafana|TypeScript|150-499 | 29 | 28 | 28 |
| supabase/supabase|TypeScript|150-499 | 35 | 26 | 26 |
| grafana/grafana|Go|50-149 | 34 | 25 | 25 |
| supabase/supabase|TypeScript|50-149 | 22 | 23 | 22 |
| grafana/grafana|Go|500+ | 33 | 19 | 19 |
| grafana/grafana|TypeScript|50-149 | 19 | 28 | 19 |
| apache/airflow|Python|50-149 | 17 | 35 | 17 |
| apache/airflow|Python|500+ | 15 | 23 | 15 |
| grafana/grafana|Go|20-49 | 24 | 14 | 14 |
| supabase/supabase|TypeScript|20-49 | 14 | 14 | 14 |
| apache/airflow|Python|150-499 | 13 | 32 | 13 |
| apache/airflow|Python|20-49 | 11 | 45 | 11 |
| grafana/grafana|TypeScript|20-49 | 11 | 22 | 11 |
| supabase/supabase|TypeScript|500+ | 24 | 10 | 10 |

