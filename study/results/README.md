# Results

Committed, human- and machine-readable outputs of the study. Written by `npm run study --
publish`, never by hand.

This directory is the **queryable surface**. The working directory it is copied from (`data/`,
gitignored) holds ~1000 PR folders of raw diffs — derived data, rebuilt deterministically by
`study clone && study collect`, far too large to version. Everything needed to re-check a
claim is here instead.

`publish` refuses to run on a mock backend, so nothing in this directory can be hash values
masquerading as findings.

## Files

| File | Written by | Contents |
| --- | --- | --- |
| `manifest.json` | `publish` | Publish timestamp, git commit, models used, PR and question counts. Start here. |
| `collect-report.json` | `collect` | Per-repo eligible counts and every exclusion, by reason. |
| `corpus-summary.md` | `describe` | Composition: provenance, language, size, empty-record rates, matching feasibility. |
| `report.md` | `analyze` | The findings, with confidence intervals. |
| `analysis.json` | `analyze` | The same numbers, machine-readable. |
| `per-pr-scores.csv` | `analyze` | One row per PR. The file to publish alongside a writeup. |
| `per-question-scores.csv` | `analyze` | One row per question, including the scorer's rationale for each judgement. |
| `human-validation.md` | `handlabel-compare` | Agreement with hand labels, and every disagreement. |

Only the first three exist until stages 2-4 have run against a real model.

## Querying

`per-pr-scores.csv` columns: `id, repo, prNumber, provenance, evidence, language,
changedLines, sizeBucket, emptyBody, nQuestions, realMean, syntheticMean, realPctExplicit,
syntheticPctExplicit, gap`.

`gap` is `realMean - syntheticMean` — the reproducibility measure, per PR. Negative means the
synthetic description answered the mechanism questions better than the real record did.

```sql
-- duckdb
SELECT provenance, count(*) n, avg(realMean) real, avg(syntheticMean) synth, avg(gap) gap
FROM 'per-pr-scores.csv' GROUP BY 1;
```

```bash
# no dependencies
awk -F, 'NR>1 {n[$4]++; g[$4]+=$15} END {for (p in n) printf "%s n=%d gap=%.3f\n", p, n[p], g[p]/n[p]}' per-pr-scores.csv
```

## Two cuts to run before believing anything

**Filter `evidence` to `bot-author` for any claim about agent-*authored* PRs.** On the
collected corpus 93% of the agent arm is `agent-trailer`, which attests assistance only.
Pooled agent-vs-human numbers describe agent-assisted work.

**Check `emptyBody`.** Records that are a title alone score near zero by construction, and
they are 28% of human PRs against 2.6% of agent ones. A headline gap between the arms could be
largely that base rate rather than anything about how mechanism gets documented, so report it
both ways.
