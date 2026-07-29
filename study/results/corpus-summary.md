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

| repo | total | agent | human |
| --- | --- | --- | --- |
| grafana/grafana | 440 | 236 | 204 |
| apache/airflow | 212 | 65 | 147 |
| supabase/supabase | 211 | 110 | 101 |
| langchain-ai/langchain | 70 | 23 | 47 |
| prisma/prisma | 67 | 66 | 1 |

## By language

| language | total | agent | human |
| --- | --- | --- | --- |
| TypeScript | 427 | 230 | 197 |
| Go | 229 | 136 | 93 |
| Python | 227 | 74 | 153 |
| JSON | 51 | 28 | 23 |
| YAML | 25 | 10 | 15 |
| JavaScript | 12 | 8 | 4 |
| Other | 10 | 6 | 4 |
| TOML | 9 | 4 | 5 |
| Shell | 3 | 1 | 2 |
| CSS | 2 | 0 | 2 |
| HTML | 2 | 2 | 0 |
| XML | 2 | 0 | 2 |
| Vue | 1 | 1 | 0 |

## By size bucket (changed lines)

| bucket | total | agent | human |
| --- | --- | --- | --- |
| 20-49 | 204 | 84 | 120 |
| 50-149 | 281 | 116 | 165 |
| 150-499 | 271 | 149 | 122 |
| 500+ | 244 | 151 | 93 |

Median changed lines — agent **208**, human **117**

A gap here is exactly why matching is not optional: without it, any difference in
answerability could just be a difference in size.

## Empty records

PRs whose surviving record is the title alone: **15.3%** overall (agent 2.6%, human 28.0%)

These are kept. An author who wrote nothing is real data, and dropping them would
condition the sample on the outcome being measured.

## Record prose already present in the diff

PRs whose record shares any 8-word prose run with the diff: **33** (3.3%)
PRs where that is >=30% of the record: **5** (0.5%)

These are records recoverable from the artifact by copying rather than by
understanding — typically docs, changelog or ADR changes. The headline should be
recomputed with them excluded, in case they are the only reason the synthetic
description keeps up.

## Matching feasibility (language x size bucket)

Matched pairs, same repo x language x size (default): **342**
Discarded as unmatched: 158 agent, 158 human
Matched pairs ignoring repo (sensitivity check only): **374**

Matching within repo removes project culture as a confound. It is not optional here:
the agent arm is concentrated in grafana and prisma, and prisma contributes 66 agent
PRs against 1 human one, so a cross-repo pairing could read a difference between two
projects’ documentation norms as an agent-vs-human effect.

Restricted to true bot authorship: **14** pairs

| language\|size | agent | human | paired |
| --- | --- | --- | --- |
| grafana/grafana|Go|150-499 | 45 | 32 | 32 |
| supabase/supabase|TypeScript|150-499 | 35 | 30 | 30 |
| grafana/grafana|Go|50-149 | 34 | 25 | 25 |
| grafana/grafana|TypeScript|150-499 | 29 | 22 | 22 |
| supabase/supabase|TypeScript|50-149 | 22 | 25 | 22 |
| supabase/supabase|TypeScript|500+ | 24 | 21 | 21 |
| grafana/grafana|TypeScript|50-149 | 19 | 31 | 19 |
| grafana/grafana|Go|20-49 | 24 | 18 | 18 |
| grafana/grafana|Go|500+ | 33 | 18 | 18 |
| apache/airflow|Python|50-149 | 17 | 40 | 17 |
| grafana/grafana|TypeScript|500+ | 18 | 16 | 16 |
| apache/airflow|Python|150-499 | 13 | 16 | 13 |
| supabase/supabase|TypeScript|20-49 | 14 | 13 | 13 |
| apache/airflow|Python|500+ | 15 | 12 | 12 |
| apache/airflow|Python|20-49 | 11 | 44 | 11 |

