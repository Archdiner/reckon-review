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
| `three-arm-report.md` | `analyze3` | **The headline.** Real, paraphrased and synthetic records, each scored independently, with the form control. |
| `three-arm-scores.csv` | `analyze3` | One row per PR from the independent three-arm run. |
| `record-vs-synthetic.svg` | `chart` | The score distribution by arm — the whole result in one picture. |
| `report.md` | `analyze` | The **paired**-scoring run, with confidence intervals. Different protocol from the headline; see below. |
| `analysis.json` | `analyze` | The same paired numbers, machine-readable. |
| `per-pr-scores.csv` | `analyze` | One row per PR from the paired run. The file to publish alongside a writeup. |
| `per-question-scores.csv` | `analyze` | One row per question from the paired run, including the scorer's rationale for each judgement. |
| `size-decomposition.md` | `decompose` | The agent/human contrast with diff size held fixed. Both terms of it move, so both are reported. |
| `length-vs-size.md` | `length` | Record length against change size, reported continuously rather than at a cutpoint chosen after seeing the data. |
| `corpus-summary.md` | `describe` | Composition: provenance, language, size, empty-record rates, matching feasibility. |
| `corpus-manifest.csv` | `publish` | Every sampled PR with its resolved SHA, so the exact corpus behind a published number stays recoverable however far upstream has moved. |
| `collect-report.json` | `collect` | Per-repo eligible counts and every exclusion, by reason. |
| `human-validation.md` | `handlabel-compare` | Agreement with hand labels, and every disagreement. **Absent — no human has labelled any of this.** |
| `human-questions-result.md` | `score-human-questions` | Every arm scored against hand-written questions. **Absent, for the same reason.** |

The last two are missing by design rather than by oversight. There is deliberately no code
path that fills either worksheet: a model writing those questions or those labels belongs to
the same class of generator as the one under test, and an auto-filled control would be
indistinguishable in the output from a real one. See the study README.

`collect-report.json`, `corpus-summary.md` and `corpus-manifest.csv` exist as soon as
`collect` and `describe` have run. Everything else requires stages 2-4 against a real model.

## Two scored runs, two protocols — read this before comparing them

`report.md` and `three-arm-report.md` cover the same 1,000 PRs and the same generated
questions and report different numbers. That is the scoring protocol, not a disagreement in
the data, and until recently neither file said which protocol it was.

- **`three-arm-report.md` is INDEPENDENT scoring** (`study score3`): each text judged alone in
  its own call, no A/B contrast, no ordering, plus the paraphrased-record form control. This
  is what the study leads with and what the top-level README quotes.
- **`report.md` is PAIRED scoring** (`study score`, which defaults to `--score-mode paired`):
  the real record and the synthetic description shown to the scorer together as A and B in a
  single call.

Paired presentation flatters the model-written text — on the pilot it lifted the synthetic arm
and left the real arm where it was — so the paired run reports a wider reproducibility gap and
a lower real-record explicit rate. Both are published because the distance between them is the
measurement of that effect. Where they disagree, quote the independent figures.

Each report now states its mode at the top, and `analysis.json` carries it as `scoreMode`. The
mode is read back from the `mode` field in each PR's `blind.json` — the artifact the scoring
run actually wrote — rather than from a flag or a default, for the same reason `publish` reads
the models out of the artifacts: a report that states its protocol from a hardcoded string can
state it wrongly, and nothing catches it.

## The question counts differ by one

`manifest.json` and `analysis.json` say **3,181** questions, and `per-question-scores.csv` has
3,181 data rows. `three-arm-scores.csv` sums `nQuestions` to **3,182**, and
`three-arm-report.md` and the top-level README say the same. The difference is one question in
one PR: `langchain-ai_langchain__32161` carries 2 questions in the paired run and 3 in the
three-arm run. Every other PR agrees, and both runs cover the same 1,000 PRs.

Both stages read the same `questions.json`, so the question set going in is identical, and
both drop a question when the scorer's reply cannot be parsed into an integer 0-2 after one
retry. Neither publishes how many it dropped. What differs is the output contract:

- **Stage 4 paired** makes ONE call per question and needs a single JSON object carrying
  *both* `A.score` and `B.score`. Two attempts; if either half is missing or unparseable on
  both, the question is discarded for both arms.
- **Stage 4b** makes THREE calls per question, each with its own two attempts against the
  simpler one-field schema. A question survives unless one of those three fails twice.

The paired contract is strictly harder to satisfy and spends one retry budget on two branches
at once, so it is the more likely of the two to lose a question — which is the direction the
discrepancy actually runs. **That is a mechanism, not a confirmed cause.** Confirming it needs
`scores.json`, `scores3.json` and `questions.json` for that PR, all of which live in the
gitignored `data/` and are not in this checkout. A second possibility the published files
cannot rule out is that the PR's `questions.json` was regenerated between the two scoring
runs, leaving the paired scores keyed to an older two-question set.

No number has been changed to make the two agree, and neither is wrong for its own run: each
report counts the questions its own scoring pass produced. But a reader who spots the mismatch
should not be left guessing, so what is known and what is not is written down here.

## Querying

`per-pr-scores.csv` (paired run) columns: `id, repo, prNumber, provenance, evidence, language,
changedLines, sizeBucket, emptyBody, nQuestions, realMean, syntheticMean, realPctExplicit,
syntheticPctExplicit, gap`.

`three-arm-scores.csv` (independent run, the headline) columns: `id, repo, provenance,
evidence, tier, nQuestions, real, paraphrase, synthetic, realPct2, paraphrasePct2,
syntheticPct2, recordChars, paraphraseChars, syntheticChars`. `tier` is the record-triviality
grade — `empty`, `trivial` or `substantive`.

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
they are 30.6% of human PRs against 2.2% of agent ones. A headline gap between the arms could
be largely that base rate rather than anything about how mechanism gets documented, so report
it both ways.
