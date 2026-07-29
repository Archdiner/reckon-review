# Corpus composition

Computed from the collected corpus with no model calls. This is not a finding about
records; it describes the sample that the scored study will run on.

Total PRs: **1000** — 500 agent-attested, 500 human

## Provenance evidence (agent arm)

| evidence | n | share of agent arm |
| --- | --- | --- |
| agent-trailer | 468 | 93.6% |
| agent-footer | 19 | 3.8% |
| bot-author | 13 | 2.6% |

`bot-author` is genuine agent authorship. `agent-trailer` and `agent-footer` attest
assistance only — a human may have driven and rewritten the change. If bot-author is
a small minority, the pooled contrast is about agent-ASSISTED PRs and must say so.

## By repository

| repo | total | agent | human |
| --- | --- | --- | --- |
| grafana/grafana | 455 | 231 | 224 |
| apache/airflow | 217 | 71 | 146 |
| supabase/supabase | 193 | 108 | 85 |
| prisma/prisma | 72 | 67 | 5 |
| langchain-ai/langchain | 63 | 23 | 40 |

## By language

| language | total | agent | human |
| --- | --- | --- | --- |
| TypeScript | 433 | 235 | 198 |
| Python | 224 | 78 | 146 |
| Go | 218 | 131 | 87 |
| JSON | 53 | 25 | 28 |
| YAML | 34 | 14 | 20 |
| JavaScript | 13 | 7 | 6 |
| TOML | 8 | 3 | 5 |
| Other | 8 | 4 | 4 |
| Shell | 5 | 1 | 4 |
| HTML | 1 | 1 | 0 |
| Svelte | 1 | 0 | 1 |
| XML | 1 | 0 | 1 |
| Vue | 1 | 1 | 0 |

## By size bucket (changed lines)

| bucket | total | agent | human |
| --- | --- | --- | --- |
| 20-49 | 208 | 78 | 130 |
| 50-149 | 260 | 116 | 144 |
| 150-499 | 273 | 145 | 128 |
| 500+ | 259 | 161 | 98 |

Median changed lines — agent **230**, human **126**

A gap here is exactly why matching is not optional: without it, any difference in
answerability could just be a difference in size.

## Empty records

PRs whose surviving record is the title alone: **16.4%** overall (agent 2.2%, human 30.6%)

These are kept. An author who wrote nothing is real data, and dropping them would
condition the sample on the outcome being measured.

## Record prose already present in the diff

PRs whose record shares any 8-word prose run with the diff: **29** (2.9%)
PRs where that is >=30% of the record: **1** (0.1%)

These are records recoverable from the artifact by copying rather than by
understanding — typically docs, changelog or ADR changes. The headline should be
recomputed with them excluded, in case they are the only reason the synthetic
description keeps up.

## Matching feasibility (language x size bucket)

Matched pairs, same repo x language x size (default): **337**
Discarded as unmatched: 163 agent, 163 human
Matched pairs ignoring repo (sensitivity check only): **380**

Matching within repo removes project culture as a confound. It is not optional here:
the agent arm is concentrated in grafana and prisma, and prisma contributes 66 agent
PRs against 1 human one, so a cross-repo pairing could read a difference between two
projects’ documentation norms as an agent-vs-human effect.

Restricted to true bot authorship: **12** pairs

| language\|size | agent | human | paired |
| --- | --- | --- | --- |
| grafana/grafana|Go|150-499 | 49 | 26 | 26 |
| grafana/grafana|TypeScript|150-499 | 27 | 26 | 26 |
| grafana/grafana|TypeScript|500+ | 26 | 24 | 24 |
| grafana/grafana|Go|500+ | 31 | 22 | 22 |
| supabase/supabase|TypeScript|150-499 | 29 | 20 | 20 |
| apache/airflow|Python|50-149 | 19 | 38 | 19 |
| grafana/grafana|Go|20-49 | 21 | 19 | 19 |
| grafana/grafana|Go|50-149 | 30 | 18 | 18 |
| supabase/supabase|TypeScript|20-49 | 18 | 19 | 18 |
| supabase/supabase|TypeScript|500+ | 25 | 18 | 18 |
| grafana/grafana|TypeScript|50-149 | 17 | 33 | 17 |
| supabase/supabase|TypeScript|50-149 | 21 | 17 | 17 |
| apache/airflow|Python|150-499 | 14 | 32 | 14 |
| apache/airflow|Python|500+ | 17 | 11 | 11 |
| apache/airflow|Python|20-49 | 10 | 33 | 10 |

