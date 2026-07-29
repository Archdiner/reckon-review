# The unit mismatch, and why it does not reduce to one number

The risk map scores **commit messages** and reports the result as a position against this
study's distribution of **pull-request records**. It ships a directional hedge — "a commit-only
record is a subset of a PR record, so the percentile is biased low" — with no magnitude. This
file is the attempt to supply that magnitude, what it found instead, and what was measurable.

> ## Read this before quoting any number below
>
> **These figures come from a fresh 250-PR draw, NOT the published 1,000-PR corpus.** The
> repos keep merging, seeded sampling fixes the draw and not the population, and this corpus
> was collected months after the published one. **No absolute number in this file is
> comparable to a published figure, and none of them replaces one.** Nothing published was
> modified to produce this file.
>
> The quantity of interest here is a **within-PR contrast** — the same PR, the same questions,
> two variants of its own record. A paired contrast is internally valid on any draw, which is
> what makes a fresh draw acceptable for this purpose and unacceptable for any other.

---

## 1. The contrast that was asked for cannot be built from this corpus

**The record is not separable into "PR description" and "commit messages", and the reason is
structural rather than a parsing difficulty.**

`study/src/stage1_collect.ts` builds `record.md` as `# <subject>` plus the **body of one squash
commit**, read out of git (`git log --no-merges --format=…%s…%b`), with agent attribution
trailers stripped. That body is a single field. Whether it holds the author's PR description or
GitHub's concatenation of the branch's commit messages depends on the repository's squash
setting and on how many commits the branch had, and **nothing in the artifact records which**.
Where the body is the description, the branch's individual commit messages are not in the
corpus at all: squash discarded them before stage 1 ran, and they are not in any clone.

So there is no section to remove. There are two possible **whole-body provenances**, one per
PR, and no marker distinguishing them.

### The obvious marker is provably wrong here

GitHub's commit-detail concatenation looks like a top-level `* ` bullet list, so that is the
tempting discriminator. Over the 250 records:

| body shape | n | what it actually is |
| --- | --- | --- |
| no body — title alone | 30 | nothing to split |
| prose/markdown, no `* ` bullets | 69 | a PR description; commit messages absent from git |
| prose first, then `* ` bullets | 35 | **a PR description whose bullets are markdown** — 33 are CodeRabbit release-note blocks, the other 2 (`apache_airflow__50960`, `langchain-ai_langchain__30451`) are hand-written summary lists. All 35 read by hand. |
| body starts with `* ` bullets | 116 | predominantly GitHub commit concatenation — 10 sampled and read by hand, all commit-shaped (`* fix test`, `* Initial plan`, `* Revert "…" This reverts commit <sha>`) |

A parser keying on `* ` would classify 35 PR descriptions as commit messages. That is 14% of
the corpus mislabelled in the direction that manufactures a difference where there is none, and
it would be invisible in the output. **No split was performed.**

### What this implies about the hedge itself

For the five calibration repos the two "units" are largely the same object:

- riskmap's `coverage.ts` scores `` `${c.subject}\n\n${c.body}` `` for a sampled commit, taken
  from `git log --no-merges --format=…%s…%b` — the **same command, same two fields** stage 1
  uses. The study additionally strips the `(#123)` suffix and attribution trailers, and adds a
  `# `.
- All five calibration repos were admitted *because* the description survives the merge button.
  Their mainline commits **are** PR squash commits. So where a PR's squash body is its
  description, that description is in git, and the tool reads it.

Splitting by the table above: for the ~116 commit-concatenation records and the 30 empty ones,
commit-only and the study's record are the **same text** and the difference is exactly **0**.
For the ~104 description records, the commit-only text **is not in the corpus** and the
difference is **unmeasurable here** — not small, unmeasurable.

The premise "commit-only is a subset of a PR record" therefore does not describe the
calibration corpus. It describes repos that *don't* squash — where the tool scores individual
feature commits and, crucially, also generates its questions from **that one commit's diff**
rather than the PR's. Both sides of the ratio narrow together, so even the *sign* of the
difference is not knowable a priori, which is what the current hedge claims to know.

---

## 2. What was scored instead: a bound, not the contrast

Two arms, the **same** questions, independent scoring — the study's own stage-2 `decompose()`
and stage-4b single-text scorer, via a new `study unit-mismatch` command
(`study/src/unitmismatch.ts`):

- **full** — `record.md`, exactly the study's real-record arm.
- **subject** — the subject line alone, body removed. The only lossless split available: the
  first line of `record.md` *is* the subject.

Under the hedge's own subset premise, any commit-only variant of a PR sits between these two,
so **`full − subject` is an upper bound on the bias the hedge describes, and 0 is the lower
bound.** The bound is attained only where surviving commit messages carry nothing beyond their
subjects — which is the case the map's squash detector already marks *unavailable*.

Information separation held throughout: questions from `questions.json` (built from the diff
alone, `assertDerivedFromDiff` passing on all 250), the scorer behind a `record-only` reader
with `assertNoRawDiff` on every prompt. **No guard fired.**

### Sample actually scored, and drops

| | |
| --- | --- |
| PR directories in the corpus | 250 |
| questions generated (production `decompose()`, `openai:gpt-5.4`) | 796 |
| PRs scored, both arms, same questions | **250** |
| questions scored | **796** |
| PRs dropped | **0** |
| questions dropped (unparseable after retry) | **0** |
| scoring model | `openai:gpt-5.4-mini` |

Nothing was dropped, so no drop-related selection applies. 30 of the 250 records are already
title-only (empty body), which makes their two arms identical by construction; they are kept,
because dropping them would condition the sample on the outcome.

### Distribution of explicit rate, per PR

Share of that PR's mechanism questions answered explicitly (rubric 2). *Fresh draw — not the
published distribution.*

| explicit rate | full record | subject only |
| --- | --- | --- |
| exactly 0 | 120 (48.0%) | 239 (95.6%) |
| >0 and <50% | 45 (18.0%) | 11 (4.4%) |
| 50–<100% | 57 (22.8%) | 0 |
| exactly 100% | 28 (11.2%) | 0 |
| **mean / median** | **31.6% / 25.0%** | **1.4% / 0.0%** |

### The paired within-PR difference

| | value |
| --- | --- |
| mean difference (full − subject) | **+30.2 points** |
| 95% CI, cluster bootstrap over PRs (5,000 resamples) | **[25.9, 34.6]** |
| median difference | **+25.0 points** |
| quartiles of the difference | p25 = 0.0, p50 = 25.0, p75 = 66.7 |
| PRs where the two arms differ at all | **51.2%** (128 of 250) |
| PRs where full > subject | 50.8% (127) |
| PRs where subject > full | 0.4% (1) — scorer noise, −33.3 on one PR |

The bootstrap resamples **PRs**, not questions: each PR contributes 2–4 questions judged
against the same two texts, and treating them as independent would shrink the interval by
roughly √(cluster size).

### Where the bound lives

| cut | n | full | subject | mean diff | 95% CI | differ |
| --- | --- | --- | --- | --- | --- | --- |
| record tier: empty | 30 | 1.1 | 1.1 | **0.0** | [0.0, 0.0] | 0% |
| record tier: trivial | 47 | 4.1 | 1.4 | 2.7 | [−0.2, 6.0] | 12.8% |
| record tier: substantive | 173 | 44.4 | 1.4 | **42.9** | [37.8, 48.2] | 70.5% |
| agent-attested | 125 | 50.5 | 1.7 | 48.8 | [42.8, 54.9] | 76.8% |
| human-authored | 125 | 12.7 | 1.1 | 11.6 | [7.5, 15.9] | 25.6% |
| apache/airflow | 45 | 26.5 | 0.0 | 26.5 | [17.2, 36.3] | 46.7% |
| grafana/grafana | 124 | 31.5 | 1.5 | 30.0 | [23.9, 36.5] | 47.6% |
| langchain-ai/langchain | 14 | 31.0 | 2.4 | 28.6 | [11.9, 47.6] | 50.0% |
| prisma/prisma | 12 | 68.1 | 2.8 | 65.3 | [48.6, 81.2] | 100.0% |
| supabase/supabase | 55 | 28.2 | 1.8 | 26.4 | [17.7, 34.7] | 52.7% |

**The subject line carries essentially no mechanism: 1.4% explicit, and 95.6% of subjects
answer nothing at all.** Practically the whole measure lives in the body. The bound is
therefore close to the entire measurement — it *cannot* be read as a small correction — and it
varies by a factor of four across cuts the map cannot observe in a target repo (tier 0.0 to
42.9; repo 26.4 to 65.3).

Per-PR rows: `unit-mismatch-scores.csv` in this directory.

### Sanity check on the draw — not a comparison of figures

This draw's full-record arm lands close to the published independent-scoring numbers (31.6%
against 32.1% overall; 50.5 against 51.5 agent; 12.7 against 12.4 human; 44.4 against 44.2
substantive). That is reassurance that the fresh draw is not aberrant. **It is still a
different draw, and these are still not the published numbers.**

---

## 3. A second mismatch, larger and pointing the other way

While confirming what the tool feeds its scorer, one more difference surfaced, and this one
*is* measurable on the published corpus with no new model calls.

**`coverage.ts` only ever scores commits `classifyRecord()` grades `substantive`.** The
calibration distribution is every PR in the corpus, including 164 `empty` and 125 `trivial`
records that score at or near zero. So a number that could only have come from a substantive
record is being placed in a distribution half-composed of records the tool would never have
sampled.

Recomputing published percentiles against the substantive-only subset of the same published
data (`results/three-arm-scores.csv`, `realPct2`, no numbers modified):

| coverage | percentile vs all 1,000 | vs substantive-only (n=711) | shift |
| --- | --- | --- | --- |
| 0% | 25.1 | 15.9 | **−9.3** |
| 25% | 51.8 | 33.8 | **−18.1** |
| 33% | 60.0 | 44.3 | −15.6 |
| 50% | 68.1 | 55.1 | −13.0 |
| 67% | 76.0 | 66.3 | −9.7 |
| 75% | 84.1 | 77.6 | −6.5 |

Every reported percentile is **6 to 18 points too flattering** for this reason alone — the
opposite direction to the documented hedge, and of a size comparable to it. This one needs no
assumption about missing channels: it is a filter the tool applies and the calibration does
not.

For the worst case in the other direction, applying the +30.2-point bound as if it were a
correction moves a percentile by +3 to +31 points depending on where it starts (0% → 27.9
becomes 58.8; 50% → 72.5 becomes 90.4). **The two known biases are of similar magnitude and
opposite sign, and neither is a constant.**

### One provenance note, in passing

`riskmap/calibration/study-coverage.json` describes its measure as "independent scoring" but
sources `results/per-pr-scores.csv`, which `results/README.md` documents as the **paired** run.
The study measured the real arm as nearly insensitive to scoring mode (−0.006), so the numeric
consequence is small; the label is nonetheless not what the file contains. Noted, not acted on.

---

## 4. Recommendation

**No single percentile adjustment is defensible. The hedge should be replaced with a
conditional statement, not with a number.**

The reasons, in order of force:

1. **The bias is not one-signed.** The substantive-commit filter biases percentiles **high** by
   6–18 points, measurably. The missing-description channel biases them **low** by anywhere
   from 0 to ~30 points. Any single scalar would be netting two effects that do not co-vary and
   are not jointly estimable from either corpus.
2. **The low-side term is 0 for repos that look like the calibration corpus.** All five score
   PR records *because their descriptions enter git*, and the tool reads the same two git fields
   from the same command. Where a squash body is the description, the tool sees the description.
   Applying a subset correction there would be a correction for a difference that does not exist.
3. **For repos that don't squash, the corpus cannot speak at all.** The tool's unit there is a
   single commit's message scored against questions from that single commit's diff. Numerator
   and denominator both narrow; the direction is not knowable, and this corpus contains no such
   repo to measure it on.
4. **The bound is too wide and too heterogeneous to spend as a constant** — up to the whole
   measurement, varying 0 → 42.9 across record tiers and 26.4 → 65.3 across repos.

Concretely, what is worth changing:

- Fix the term that is measurable and unconditional: either compute percentiles against the
  **substantive-only** subset, matching the filter the tool already applies, or state the 6–18
  point inflation on the page. This is the largest known error in the current numbers and it
  needs no new data.
- Replace "commit-only is a subset, so percentiles are biased low" with the conditional the
  squash detector already computes: at high substantive-body share the tool is reading the same
  field the study read, and the subset gap is near zero; the gap only opens on repos whose
  descriptions never enter git, and those are already the ones the detector marks
  `unavailable` or `low-confidence`. The hedge and the detector are the same fact stated twice,
  and the detector is the honest version.
- If a magnitude must be quoted for the low side, quote it as the bound it is: *"bounded above
  by ~30 points of explicit rate — the whole measure — because a subject line alone answers
  1.4% of mechanism questions; not a correction, a limit."* With the fresh-draw caveat.

---

## Reproducing

```bash
cd study
npm run study -- questions          # production decompose(), diff only
npm run study -- unit-mismatch      # builds variant_subject.md, scores both arms
```

Writes `data/out/unit-mismatch-scores.csv` and `data/out/unit-mismatch-summary.json` (per-tier,
per-repo and per-provenance summaries, plus the scoring report). Section 3's tables are
recomputed from published CSVs in this directory and modify nothing.
