# Record length, change size, and what each one predicts

All figures are the share of mechanism questions answered EXPLICITLY (score 2), from
independent scoring.

## The record does not cover more when the change is bigger

| arm | 20-49 | 50-149 | 150-499 | 500+ | range |
| --- | --- | --- | --- | --- | --- |
| agent — real record | 52.6 | 50.3 | 53.1 | 50.5 | **2.8** |
| agent — synthetic | 63.2 | 65.1 | 61.1 | 38.7 | **26.4** |
| human — real record | 10.6 | 12.5 | 13.3 | 13.4 | **2.7** |
| human — synthetic | 60.3 | 54.7 | 57.3 | 34.8 | **25.5** |

The real record is flat across a tenfold range of change size — under 3 points of
movement in either arm. The synthetic arm moves 25-26 points over the same range,
which is what a measure that responds to change size looks like.

And it is not that people write no more for bigger changes. They write substantially
more:

| median record length | 20-49 | 50-149 | 150-499 | 500+ |
| --- | --- | --- | --- | --- |
| agent | 656 | 859 | 1423 | 3279 |
| human | 122 | 135 | 235 | 291 |

So the record GROWS with the change — five-fold across the range for agent-attested
PRs — while its COVERAGE of the change stays flat. More gets written and the same
proportion of the mechanism survives, because a bigger change has proportionally more
mechanism to explain.

Stated the other way round: **provenance predicts record coverage by roughly 37 points
at every change size. Change size predicts almost nothing.** Whatever determines how
much of a change gets explained, it is not how much of the system the change touches.

## Is the length effect just diff size in disguise? No.

Split at the MEDIAN record length within each diff-size bucket, so "long" means long
relative to peers of the same change size.

| diff size | median rec | short: real / synth / gap | long: real / synth / gap | long − short |
| --- | --- | --- | --- | --- |
| 20-49 | 208ch | 2.2 / 59.2 / -57.1 | 51.0 / 63.5 / -12.5 | **+44.6** |
| 50-149 | 407ch | 6.4 / 52.3 / -45.9 | 52.6 / 66.4 / -13.8 | **+32.1** |
| 150-499 | 747ch | 12.0 / 56.5 / -44.4 | 57.1 / 62.2 / -5.0 | **+39.4** |
| 500+ | 1414ch | 10.6 / 37.1 / -26.5 | 61.5 / 37.4 / 24.2 | **+50.6** |

The long half beats the short half by 32-51 points at every fixed change size. The
record-length effect is not diff size wearing a disguise.

## Where the curves cross, reported continuously

No threshold is imposed. Deciles of record length, with the median change size of each
decile shown so the confound stays visible.

| decile | record chars | n | real | synthetic | gap | median diff lines |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 18–55 | 100 | 0.0 | 46.2 | -46.2 | 104 |
| 2 | 55–98 | 100 | 1.0 | 50.2 | -49.2 | 102 |
| 3 | 99–193 | 100 | 4.2 | 59.0 | -54.8 | 61 |
| 4 | 194–358 | 100 | 14.6 | 53.2 | -38.5 | 115 |
| 5 | 358–535 | 100 | 23.6 | 57.6 | -34.1 | 169 |
| 6 | 536–808 | 100 | 39.7 | 61.6 | -21.9 | 120 |
| 7 | 814–1206 | 100 | 44.7 | 59.6 | -14.9 | 184 |
| 8 | 1218–2037 | 100 | 58.2 | 56.3 | 1.9 | 208 |
| 9 | 2043–3619 | 100 | 58.6 | 53.7 | 4.9 | 284 |
| 10 | 3693–56283 | 100 | 70.6 | 40.4 | 30.2 | 1411 |

The curves cross at roughly **1218 characters** of record. Below that the
synthetic description answers more mechanism questions than the record; above it the
record is at least as good, and pulls away sharply in the top decile.

The top decile also has the largest changes by a wide margin, so length and size are
entangled there. The 2x2 below separates them.

## Long record and large diff: one finding or two?

Neither. The inversion is an INTERACTION and needs both.

| | n | real | synthetic | gap |
| --- | --- | --- | --- | --- |
| long record + large diff | 92 | 69.1 | 34.7 | **34.4** |
| long record + small diff | 34 | 73.4 | 68.8 | **4.6** |
| short record + large diff | 167 | 18.0 | 38.7 | **-20.7** |
| short record + small diff | 707 | 28.3 | 59.4 | **-31.1** |

Long-record PRs: 126. Large-diff PRs: 259. Both: 92 (31.4% Jaccard; 73.0% of long-record PRs are also large-diff).

They overlap substantially but are not the same set, and the inversion belongs to the
cell where both hold. A long record on a small change is roughly a tie; a large change
with a short record stays firmly negative.

## Reproducibility reverses on large agent-attested changes

| provenance | size | real | synthetic | gap |
| --- | --- | --- | --- | --- |
| agent | 20-49 | 52.6 | 63.2 | -10.5 |
| agent | 50-149 | 50.3 | 65.1 | -14.8 |
| agent | 150-499 | 53.1 | 61.1 | -8.0 |
| agent | 500+ | 50.5 | 38.7 | **11.9** |
| human | 20-49 | 10.6 | 60.3 | -49.6 |
| human | 50-149 | 12.5 | 54.7 | -42.2 |
| human | 150-499 | 13.3 | 57.3 | -43.9 |
| human | 500+ | 13.4 | 34.8 | -21.4 |

On agent-attested changes of 500+ lines the real record BEATS the synthetic. That is
the reproducibility claim reversing, not merely weakening, and it is the honest
boundary of the finding: the model reproduces records of small and medium changes, and
fails to on the largest ones. The human arm never reverses, because its records stay
near-empty at every size.

## Selection, not causation

Everything above is correlational and must not be read otherwise.

People who write 5,000-character records are writing about changes that warranted the
effort, in teams whose culture rewards it, on work they understood well enough to
explain. None of that is established by this data, and none of it supports the claim
that COMPELLING length would produce information. A mandated 3,000-character minimum
would most likely produce 3,000 characters.

This matters for anyone tempted to cite this study in favour of a tool that asks for
more explanation, including the tool this study ships next to. The causal version of
this correlation is a bet. It is a reasonable bet, and it is not a result.

