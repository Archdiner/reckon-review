# How much of a change survives in the record

A study pipeline. It measures, for merged pull requests, how much of the *mechanism* of a
change is recoverable from the record it leaves behind — the PR description plus the commit
messages — and whether that record contains anything a model could not have written from the
diff alone.

Everything here is reproducible: one command per stage, every intermediate written to disk,
prompts in source, per-PR scores published as CSV.

---

## Status: the pipeline is complete and the corpus is collected. No scores have been produced.

This environment has no model credentials and cannot reach an inference API, so stages 2, 3
and 4 have never run against a real model. **There are no findings in this repository, and
nothing here should be cited as one.** What exists is:

- the full pipeline, typechecked, with its leakage guards under test;
- the collected corpus (see `data/out/collect-report.json` after running stage 1);
- an end-to-end dry run on a deterministic offline backend, proving the plumbing and the
  guards work, whose output is stamped `MOCK RUN — THESE ARE NOT FINDINGS`.

To produce actual numbers, set a key and run stages 2-4:

```bash
export ANTHROPIC_API_KEY=...      # generation (stages 2, 3)
export OPENAI_API_KEY=...         # scoring (stage 4), a cheaper model on a different vendor
npm run study -- questions && npm run study -- synthetic && npm run study -- score
npm run study -- analyze
```

Two further environment limits shaped the design and must be carried into any writeup:

- **The GitHub API is unreachable**, so the record is reconstructed from git instead. This
  works only for repositories that preserve the PR description at merge, and that constraint
  drove repo selection — see "Why these repositories" below.
- **Hugging Face is unreachable**, so the AIDev dataset could not be used and provenance is
  recovered from git metadata instead. This label is weaker than AIDev's in a specific,
  reportable way — see "What the agent label means".

---

## The three questions

**A. The gap.** Generate mechanism questions from the code change alone, then check whether
the written record answers them. Reported as mean score and as the share of questions
answered explicitly.

**B. The reproducibility control.** Have a model write a PR description from the diff alone,
with no access to the real one, and score it with the same rubric against the same questions.

This is the one that matters. If the synthetic description scores as well as the real one,
the real one contained nothing a human had to supply — it is fully recoverable from the
artifact. The claim is not "descriptions are bad". Descriptions are probably fine. The claim
is that descriptions have become *reproducible*, so their completeness no longer tells you
whether a person understood the change.

**C. The agent split.** Agent-authored versus human-authored, matched on language and diff
size.

---

## Pipeline

| Stage | Command | Reads | Writes |
| --- | --- | --- | --- |
| 1 collect | `study collect` | git clones | `meta.json`, `diff.patch`, `record.md` |
| 2 questions | `study questions` | `diff.patch` **only** | `questions.json` |
| 3 synthetic | `study synthetic` | `diff.patch` **only** | `synthetic.md` |
| 4 score | `study score` | `record.md`, `synthetic.md` **only** | `scores.json`, `blind.json` |
| 5 match | (used by analyze) | `meta.json` | matched pairs |
| 6 analyze | `study analyze` | `scores.json` | `report.md`, CSVs |
| — validate | `study handlabel-export` / `-compare` | | `worksheet.jsonl`, `human-validation.md` |

Stage 2 calls Reckon's **production** `decompose()` from `@reckon/core`, unmodified. The
study measures the world with the instrument the product already ships, so a result here is a
claim about Reckon's own question generator rather than about a research prompt nothing else
uses. Large diffs go through the same `diffDigest` production uses, so every changed file is
represented rather than the first 8000 characters.

## Information separation

The study has one result worth defending and one way to void it: letting the description
reach the question generator, or letting the diff reach the scorer. Three mechanisms enforce
the separation, and the first is the one that actually matters.

1. **Structural.** The diff and the record live in separate files behind `PrReader`, which
   is scoped per stage. A diff-only stage calling `readRecord()` throws. There is no struct
   anywhere that carries both.
2. **Containment.** Stage 2 and 3 prompts are asserted to be a subset of the diff, so
   anything arriving from another source fails the run.
3. **No raw patch in the scorer.** Stage 4 prompts are rejected if they contain diff syntax.

A tripped guard aborts the run. It never downgrades to a warning, because a run that
continued past a leak would produce numbers indistinguishable from clean ones.

`npx tsx src/guard.test.ts` pins both directions — that the guard still fires on a real leak,
and that it stays silent on the legitimate cases that made earlier versions misfire.

### A correction worth reading

The first version of the containment check tested stage-2 prompts for overlap with
`record.md` and aborted on a match. On the pilot corpus it fired twice and **neither was
leakage**: once on a file path present in both the diff header and the description, once on a
documentation PR whose diff *adds* the prose its description summarises.

The check was not just noisy, it was incapable of detecting what it claimed to. Stage 2 builds
its prompt by digesting `diff.patch`; every token in it already came from the diff, so overlap
with the record can only mean the two genuinely share content. It could never indicate the
description leaking in, because no code path could put it there.

So it was replaced by the containment assertion above, and the overlap it was accidentally
measuring is now recorded per PR as `recordDiffSharedShingles`. That number is interesting on
its own terms: a PR whose diff already contains its description's sentences is one where the
record is recoverable by copying rather than by understanding — the study's thesis in its most
literal form. The analysis can be recomputed with those PRs excluded.

## Blinding

The scorer sees two candidate texts as A and B, in an order derived from a seeded hash of the
PR id, and is never told which is real. The mapping is written to `blind.json` *after*
scoring, by a code path the prompt builder does not touch.

Agent attribution trailers (`Co-authored-by: Claude`, `🤖 Generated with…`) are stripped from
the record at collection time. Two independent reasons, both mandatory: they would tell the
scorer which arm the PR is in, turning the agent-vs-human contrast partly into a measurement
of the scorer's prior about agents; and they carry no mechanism, so they are noise against the
rubric anyway. Only attribution lines are removed — prose is never touched, including prose
that mentions an agent, since that is content the author chose to write.

Human labellers work under the same blinding, with the same A/B assignment.

## The rubric

Per question, per candidate text:

- **0 — absent.** Nothing in the text bears on this question.
- **1 — partial.** The text gestures at it; a reader would have a hint but could not
  reconstruct the mechanism.
- **2 — explicit.** Stated clearly enough to act on without reading the code.

Both the mean and the share scoring 2 are reported. The percentage is the more honest
headline.

## Why these repositories

The record is reconstructed from git, which is only sound where the merge convention
*preserves* the PR description. Repos are admitted on their **convention**, never on the
richness of any individual PR: admission requires ≥25% of recent merges to carry a
non-trivial body.

| Repo | Body density | Verdict |
| --- | --- | --- |
| prisma/prisma | 95% | admitted |
| supabase/supabase | 85% | admitted |
| apache/airflow | 47% | admitted |
| langchain-ai/langchain | 42% | admitted |
| grafana/grafana | 41% | admitted |
| withastro/astro | 17% | rejected — below threshold |
| home-assistant/core | 0% | rejected — squashes with title only |
| n8n-io/n8n | 0% | rejected — squashes with title only |
| django/django, kubernetes/kubernetes | n/a | rejected — description never enters git |

Sampling the 0% repos would not measure "authors documented nothing", it would measure "the
merge button discarded what they wrote", and would manufacture a dramatic result out of a
repository setting. Nothing sits near the threshold: admitted repos measured 41-95%, rejected
ones 0%.

**Within** an admitted repo, an empty description is real data and is kept. Filtering on body
length would condition the sample on the outcome being measured.

Note that `record.md` is the record *as it survives in git*, which for a squash-merged PR is
one commit message rather than the individual commits. That is arguably the most faithful
reading of "what survives", but it is not identical to what the GitHub UI shows, and a writeup
should say so.

## What the agent label means

AIDev was unreachable, so provenance comes from git. It is weaker than AIDev's label and the
difference is reportable:

- `bot-author` — the commit author **is** an agent account (`copilot-swe-agent`,
  `open-swe[bot]`, `cursor[bot]`, `devin-ai-integration`). Genuine agent authorship.
- `agent-trailer` — a `Co-authored-by:` line naming an agent. Attests **assistance**; a human
  may have driven, reviewed and rewritten the change.
- `agent-footer` — a "Generated with Claude Code" style footer. Same caveat.

Every PR records which fired and the literal matched string, and `analyze` reruns the contrast
on `bot-author` alone. **If the contrast holds pooled but vanishes there, the pooled result is
about agent-assisted PRs, not agent-authored ones, and must be described that way.**

Direction of bias: trailer-attested PRs are the ones where a human was engaged enough to keep
the attribution, so this labelling likely *understates* any agent-vs-human difference.

## Exclusions

File level — lockfiles, vendored trees, generated code, snapshots, minified bundles are
removed from the diff and do not count toward changed lines. PR level — dependency bumps,
dependency-manifest-only changes, formatting-only changes, docs-only changes, and anything
under 20 changed lines are dropped. All drops are counted by reason in
`data/out/collect-report.json`.

The `dependency-manifest-only` rule exists because reading the pilot by hand caught what the
title-pattern rule could not: an Airflow PR titled "Remove obsolete pandas specification for
pre-python 3.9" that edits nothing but version constraints across thirteen `provider.yaml`
files. Only the file set marks it as a dependency change. Running 50 PRs end to end and
reading every output is the step that finds this class of bug, and it is worth the afternoon.

## Statistics

Uncertainty is computed by **cluster bootstrap over PRs**, not over questions. Each PR yields
2-4 questions scored against the same two texts, so those scores are strongly correlated
within a PR; treating ~1800 questions as ~1800 independent observations would shrink every
interval by roughly √(cluster size) and manufacture significance. Real-versus-synthetic is
paired by construction, which removes PR-level difficulty entirely.

**On reading a null result.** The headline outcome is an *absence* of difference, and absence
of difference is not equivalence — it can equally mean the study lacked power. The report
prints the interval, and the "record is reproducible from the diff" reading requires it to be
**tight** around zero. `[-0.4, +0.4]` straddles zero and says nothing. The report states this
inline so it cannot be dropped on the way to a headline.

## Validation is not optional

`study handlabel-export` draws 50 PRs into a blinded worksheet; `study handlabel-compare`
reports exact agreement, within-one agreement, quadratic weighted kappa, and a full dump of
the disagreements.

Lead with kappa. On a 3-point scale with a heavy 0 class, raw agreement flatters any labeller
who guesses the mode. Without this step the study is one prompt grading another prompt — the
first criticism it will get, and a fair one.

## Threats to validity

State these before anyone raises them:

- Questions come from one generator with one prompt; a different generator would ask
  different questions.
- Questions generated from a diff over-weight what is locally visible and under-weight
  architectural context.
- Public open-source repos are not representative of private codebases, and their review
  culture is stronger.
- Agent-labelled PRs are a biased sample — teams that let agents open PRs are unusual teams.
- Repos are admitted on merge convention, which correlates with engineering practice; the
  corpus may skew toward better-documented projects than average.
- Only prisma's history within the window is short (from 2025-10), so it contributes a
  narrower calendar slice than the others.
- Scoring is paired A/B by default, which invites contrast effects. `--score-mode independent`
  removes them at roughly double the cost; running a subset both ways shows the choice did not
  create the result.
- **The record is not the only channel.** Real teams have Slack, standups and shared context
  that never enters the repo. This is the most serious objection to the whole premise and
  should be stated plainly — then noted that none of those channels survive turnover either,
  which is exactly the point.

## Cost

Roughly 4 model calls per PR: 1 question generation, 1 synthetic description, and one scoring
call per question (2-4). At 1000 PRs that is ~1000 generation calls and ~3000 scoring calls.
Use the cheaper model for scoring and spot-check that it agrees with the expensive one.

**Run 50 end to end and read every output by hand before scaling.** It already paid for
itself twice here — the manifest-only exclusion bug and the guard's false-positive design
error were both found that way, and both would have silently distorted the headline.
