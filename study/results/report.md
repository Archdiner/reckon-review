# Record-survival study — results

> **This is the PAIRED-SCORING run, and it is not the study's headline.**
>
> Stage 4 defaults to `--score-mode paired`: the real record and the synthetic description
> go to the scorer together, as A and B, in a single call. Seeing both invites a contrast the
> rubric never asks for, and the pilot measured what that costs — paired presentation lifted
> the synthetic arm and left the real arm where it was. The reproducibility gap below is
> therefore wider than the same corpus gives when each text is judged alone.
>
> **The headline is `three-arm-report.md`**, which scores every text independently, one text
> per call, and adds the paraphrase form control. Expect it to report a smaller gap and a
> higher real-record explicit rate than this file. That difference is the protocol talking,
> not a different corpus: both cover the same PRs and the same generated questions.
>
> This run is published rather than dropped because the distance between the two files is the
> measurement of how much paired presentation moves the answer. Where they disagree, quote
> the independent ones.

Scoring mode: **paired**   PRs scored: **1000**   Questions scored: **3181**   Empty PR body: **16.4%**

## 1. Answerability of the real record

Mean score (0-2): **0.87**
Questions answered explicitly (score 2): **27.4%**
Questions with nothing at all in the record (score 0): **40.8%**

## 2. Reproducibility gap — real minus synthetic

Real mean **0.87** vs synthetic mean **1.47**
Per-PR mean gap: **-0.62**  95% CI **[-0.67, -0.57]** (cluster bootstrap over PRs)
Explicit-rate gap: **-32.0 pp**  95% CI **[-35.1, -28.8]**

Interpretation guard: a CI that merely straddles zero is not evidence of equivalence.
The "record is reproducible from the diff" reading requires the interval to be TIGHT
around zero. A wide interval means the study was underpowered, not that the gap is absent.

## 3. Agent-attested vs human-authored

- agent: n=500, real mean 1.23, explicit 45.9%
- human: n=500, real mean 0.49, explicit 8.4%

Matched on repo x language x size bucket: **337 pairs**
(discarded as unmatched: 163 agent, 163 human)
Agent 1.19 vs human 0.51; difference **0.68** 95% CI **[0.60, 0.76]**

Top strata (repo|language|size: agent/human/paired):
  - grafana/grafana|Go|150-499: 49/26/26
  - grafana/grafana|TypeScript|150-499: 27/26/26
  - grafana/grafana|TypeScript|500+: 26/24/24
  - grafana/grafana|Go|500+: 31/22/22
  - supabase/supabase|TypeScript|150-499: 29/20/20
  - apache/airflow|Python|50-149: 19/38/19
  - grafana/grafana|Go|20-49: 21/19/19
  - grafana/grafana|Go|50-149: 30/18/18

Sensitivity — same contrast without the repo constraint (380 pairs): difference **0.69** 95% CI **[0.62, 0.77]**
If this disagrees with the within-repo figure, the looser match is measuring
project culture rather than who wrote the change. Report the within-repo one.

Robustness — agent arm restricted to true bot authorship (12 pairs): difference **0.76** 95% CI **[0.19, 1.31]**

If the contrast holds pooled but vanishes here, the pooled result is about
agent-ASSISTED PRs, not agent-authored ones, and must be described that way.

## 4. Answerability against diff size

| bucket | n | real mean | real explicit % | synthetic mean |
| --- | --- | --- | --- | --- |
| 20-49 | 208 | 0.76 | 22.2 | 1.62 |
| 50-149 | 260 | 0.80 | 24.4 | 1.57 |
| 150-499 | 273 | 0.90 | 28.6 | 1.52 |
| 500+ | 259 | 0.97 | 32.4 | 1.23 |

## 5. By repository

| repo | n | real mean | synthetic mean |
| --- | --- | --- | --- |
| grafana/grafana | 455 | 0.87 | 1.55 |
| apache/airflow | 217 | 0.65 | 1.55 |
| supabase/supabase | 193 | 0.85 | 1.38 |
| prisma/prisma | 72 | 1.54 | 1.10 |
| langchain-ai/langchain | 63 | 0.73 | 1.47 |

A result that only appears in one repository is that repository's culture, not a finding.

## 6. Human validation

Run `study handlabel-export` and `study handlabel-compare` to fill this in.
Without it the study is one prompt grading another prompt, which is the first
criticism it will receive and a fair one.

