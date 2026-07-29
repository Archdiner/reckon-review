# Retrospective validation — does a flag predict anything?

The map was rebuilt as of 18 months before each repository's HEAD, using only commits before that date, and outcomes were measured over the following 12 months.

Repositories: grafana/grafana (T=2025-01-27), apache/airflow (T=2025-01-27), supabase/supabase (T=2025-01-27), langchain-ai/langchain (T=2025-01-27)
Regions with any post-T activity: **194** — 8 flagged, 186 not.

Regions with NO post-T commits at all: **20 flagged**, 67 not flagged. These are reported rather than excluded. An activity floor preferentially deletes the flagged arm, because a region nobody is working on any more is exactly what the map flags — an earlier version of this harness used a 5-commit floor and removed every flagged region on grafana, then reported a difference of zero with a zero-width interval.

## Distributions, not means

Means are shown last and on purpose. Outcome rates across regions are skewed, so a
difference of means can describe no actual region.

### fix / revert rate

| arm | p10 | p25 | median | p75 | p90 | mean |
| --- | --- | --- | --- | --- | --- | --- |
| flagged | 0.000 | 0.000 | 0.000 | 0.007 | 0.008 | 0.003 |
| not flagged | 0.000 | 0.000 | 0.000 | 0.011 | 0.020 | 0.010 |

Difference (flagged − not): **-0.007** 95% CI [-0.014, -0.001], cluster bootstrap over regions.

Post-T commits per region — flagged: median 68 (p10 2, p90 614); not flagged: median 42 (p10 2, p90 500). A rate from a single-figure denominator is not a measurement.

> **The interval excludes zero in the WRONG direction: flagged regions did BETTER than unflagged ones.** This is evidence against the map, not for it. Do not cite this run in support of the flagging rule.

### rework rate (file re-touched within 30 days)

| arm | p10 | p25 | median | p75 | p90 | mean |
| --- | --- | --- | --- | --- | --- | --- |
| flagged | 0.000 | 0.000 | 0.321 | 0.718 | 0.875 | 0.384 |
| not flagged | 0.000 | 0.334 | 0.616 | 0.790 | 0.888 | 0.551 |

Difference (flagged − not): **-0.167** 95% CI [-0.444, 0.103], cluster bootstrap over regions.

Post-T commits per region — flagged: median 68 (p10 2, p90 614); not flagged: median 42 (p10 2, p90 500). A rate from a single-figure denominator is not a measurement.

> The interval crosses zero. On this evidence the flag does not predict this outcome. Note that a CI straddling zero is not evidence of equivalence — it may mean the comparison is underpowered, which the region count above will show.

## Stratified by churn at T

Churn is the obvious confound: the map flags partly on churn, and a busier region has
more opportunities to contain a fix commit. Splitting at the median does not remove the
confound; it shows whether the difference survives inside a stratum.

| stratum | metric | flagged n | unflagged n | difference | 95% CI |
| --- | --- | --- | --- | --- | --- |
| below median churn at T | fix / revert rate | 0 | 98 | not computed | one arm empty |
| below median churn at T | rework rate (file re-touched within 30 days) | 0 | 98 | not computed | one arm empty |
| above median churn at T | fix / revert rate | 8 | 88 | -0.006 | [-0.010, -0.002] |
| above median churn at T | rework rate (file re-touched within 30 days) | 8 | 88 | -0.275 | [-0.550, -0.007] |

## What this cannot establish

- Flagging is not random assignment. Flagged regions differ from unflagged ones in ways
  the map measures and in ways it does not, so this is an association and not an effect.
- Outcomes are derived from commit messages, which is the same channel the record
  dimension measures. A team that never writes "revert" looks healthy here by construction.
- Public repositories are not private codebases, and their review culture is stronger.

## Notes

- Only 8 flagged regions had any post-T activity. That is too few to lean on: report the direction, not the interval, and add repositories before citing this.
