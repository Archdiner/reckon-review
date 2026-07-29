# Retrospective validation — does a flag predict anything?

The map was rebuilt as of 18 months before each repository's HEAD, using only commits before that date, and outcomes were measured over the following 12 months.

Repositories: grafana/grafana (T=2025-01-27)
Regions with any post-T activity: **62** — 0 flagged, 62 not.

Regions with NO post-T commits at all: **4 flagged**, 5 not flagged. These are reported rather than excluded. An activity floor preferentially deletes the flagged arm, because a region nobody is working on any more is exactly what the map flags — an earlier version of this harness used a 5-commit floor and removed every flagged region on grafana, then reported a difference of zero with a zero-width interval.

## Distributions, not means

Means are shown last and on purpose. Outcome rates across regions are skewed, so a
difference of means can describe no actual region.

### fix / revert rate

| arm | p10 | p25 | median | p75 | p90 | mean |
| --- | --- | --- | --- | --- | --- | --- |
| flagged | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| not flagged | 0.000 | 0.000 | 0.006 | 0.017 | 0.025 | 0.020 |

Difference (flagged − not): **0.000** 95% CI [0.000, 0.000], cluster bootstrap over regions.

> **Not computed.** One arm is empty, so this difference is a placeholder and not a measurement. See the notes.

### rework rate (file re-touched within 30 days)

| arm | p10 | p25 | median | p75 | p90 | mean |
| --- | --- | --- | --- | --- | --- | --- |
| flagged | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| not flagged | 0.667 | 0.854 | 0.924 | 0.966 | 1.000 | 0.849 |

Difference (flagged − not): **0.000** 95% CI [0.000, 0.000], cluster bootstrap over regions.

> **Not computed.** One arm is empty, so this difference is a placeholder and not a measurement. See the notes.

## Stratified by churn at T

Churn is the obvious confound: the map flags partly on churn, and a busier region has
more opportunities to contain a fix commit. Splitting at the median does not remove the
confound; it shows whether the difference survives inside a stratum.

| stratum | metric | flagged n | unflagged n | difference | 95% CI |
| --- | --- | --- | --- | --- | --- |
| below median churn at T | fix / revert rate | 0 | 32 | 0.000 | [0.000, 0.000] |
| below median churn at T | rework rate (file re-touched within 30 days) | 0 | 32 | 0.000 | [0.000, 0.000] |
| above median churn at T | fix / revert rate | 0 | 30 | 0.000 | [0.000, 0.000] |
| above median churn at T | rework rate (file re-touched within 30 days) | 0 | 30 | 0.000 | [0.000, 0.000] |

## What this cannot establish

- Flagging is not random assignment. Flagged regions differ from unflagged ones in ways
  the map measures and in ways it does not, so this is an association and not an effect.
- Outcomes are derived from commit messages, which is the same channel the record
  dimension measures. A team that never writes "revert" looks healthy here by construction.
- Public repositories are not private codebases, and their review culture is stronger.

## Notes

- THE COMPARISON IS EMPTY, AND THAT IS THE RESULT. All 4 flagged regions received no commits at all in the follow-up window, so there is no post-T behaviour to compare. Read the difference tables below as "not computed", never as "no effect" — both arms of a difference must be non-empty for it to mean anything.
- This is close to mechanical rather than predictive, and must not be sold as a hit: the map flags a region for having contributors who stopped committing, and such a region then receiving no commits is nearly the same statement made twice. It is weak evidence that the ownership signal identifies genuinely dormant code, and it is NOT evidence that flagged regions produce worse outcomes when someone does touch them — which is the claim the outreach would want and this run does not support.
- To test the real claim, the harness needs repositories where flagged regions are still being modified — a shorter follow-up window will not help, and adding repositories only helps if their flagged regions are live.
