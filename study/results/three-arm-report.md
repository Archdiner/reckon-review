# Three-arm analysis — is the gap content, or form?

All three arms scored INDEPENDENTLY: each text alone in its own call, same rubric,
same question, no A/B contrast and no ordering. The arms are therefore judged
identically, which is what makes them comparable.

The paraphrase arm is the real record restated in the model's own voice with no
information added. It has the synthetic's form and the record's content, so it
isolates the confound that the question and the synthetic description were produced
by the same model from the same diff by the same reasoning.

## Methods result: the rubric is insensitive to surface form

This is a validation of the instrument, and it stands independently of any finding.

The paraphrase arm is the real record carrying the model's headings, bullets, code
formatting and vocabulary, with no information added. It scores the same as the raw
record. A scorer that rewarded polish, fluency or familiar structure would have moved;
this one did not.

That closes the most common objection to an LLM-judged study — "your grader is just
rewarding text that looks like model output" — with a measurement rather than an
assurance. The grader is responding to content, because holding content fixed and
changing everything else produced no change in score.

## The two findings this corpus supports

They are separate claims with separate evidence, and they end in the same place.

**1. Absence.** Where humans write the record unaided, often there is no record. Look
for this as mass at score 0 on the real arm of the human cut.

**2. Reproducibility.** Where the record IS full, a model reproduces it from the diff
alone. Look for this as the real and synthetic arms having the same SHAPE in the agent
cut — not as a mean difference near zero, which could arise many ways.

Neither claim needs anyone to have written badly. Together they say the written record
is not evidence that a human understood the change: where it is absent there is nothing
to read, and where it is present it is recoverable from the artifact.

The agent cut is the stronger of the two, and its selection story is the explanation
rather than a nuisance to be waved off. A `Co-authored-by` trailer marks a PR from a
team that uses agents, and those records were plausibly model-drafted from the diff in
the first place. That is precisely why they are reproducible: the cut where records are
fullest is the cut where they are most recoverable. State it before a reader finds it.

### Agent-attested — the REPRODUCIBILITY finding  (n=500 PRs, 1605 questions)

Share of questions at each score. The distribution is the result; the mean is a
summary that misleads when the scores are bimodal, which on the real arm they are.

| arm | 0 absent | 1 partial | 2 explicit | mean |
| --- | --- | --- | --- | --- |
| real record | 30.5% | 17.9% | 51.5% | 1.21 |
| paraphrased record (form control) | 32.7% | 19.3% | 48.0% | 1.16 |
| synthetic (from diff) | 19.3% | 26.1% | 54.6% | 1.37 |

real - synthetic: **-0.16**  95% CI [-0.22, -0.10]
real - paraphrase: **0.05**  95% CI [0.02, 0.09]

**Form share: -33.5%** 95% CI [-54.5, -12.9] — the portion of the
real-to-synthetic distance recovered by reformatting the record alone, adding no information.
High means the measured gap is largely about the shape of the text rather than its content.

### Human-authored — the ABSENCE finding  (n=500 PRs, 1577 questions)

Share of questions at each score. The distribution is the result; the mean is a
summary that misleads when the scores are bimodal, which on the real arm they are.

| arm | 0 absent | 1 partial | 2 explicit | mean |
| --- | --- | --- | --- | --- |
| real record | 68.9% | 18.6% | 12.4% | 0.43 |
| paraphrased record (form control) | 67.9% | 20.7% | 11.4% | 0.43 |
| synthetic (from diff) | 21.6% | 25.7% | 52.7% | 1.32 |

real - synthetic: **-0.88**  95% CI [-0.94, -0.83]
real - paraphrase: **-0.00**  95% CI [-0.03, 0.02]

**Form share: 0.1%** 95% CI [-2.8, 2.9] — the portion of the
real-to-synthetic distance recovered by reformatting the record alone, adding no information.
High means the measured gap is largely about the shape of the text rather than its content.

### All PRs  (n=1000 PRs, 3182 questions)

Share of questions at each score. The distribution is the result; the mean is a
summary that misleads when the scores are bimodal, which on the real arm they are.

| arm | 0 absent | 1 partial | 2 explicit | mean |
| --- | --- | --- | --- | --- |
| real record | 49.6% | 18.3% | 32.1% | 0.82 |
| paraphrased record (form control) | 50.2% | 20.0% | 29.9% | 0.80 |
| synthetic (from diff) | 20.4% | 25.9% | 53.7% | 1.34 |

real - synthetic: **-0.52**  95% CI [-0.57, -0.47]
real - paraphrase: **0.03**  95% CI [0.01, 0.05]

**Form share: -5.0%** 95% CI [-9.0, -1.2] — the portion of the
real-to-synthetic distance recovered by reformatting the record alone, adding no information.
High means the measured gap is largely about the shape of the text rather than its content.

### Substantive records only (author wrote something beyond the title)  (n=711 PRs, 2285 questions)

Share of questions at each score. The distribution is the result; the mean is a
summary that misleads when the scores are bimodal, which on the real arm they are.

| arm | 0 absent | 1 partial | 2 explicit | mean |
| --- | --- | --- | --- | --- |
| real record | 35.4% | 20.4% | 44.2% | 1.09 |
| paraphrased record (form control) | 37.8% | 21.1% | 41.1% | 1.04 |
| synthetic (from diff) | 19.5% | 26.3% | 54.2% | 1.36 |

real - synthetic: **-0.27**  95% CI [-0.32, -0.22]
real - paraphrase: **0.05**  95% CI [0.03, 0.08]

**Form share: -19.6%** 95% CI [-29.5, -9.4] — the portion of the
real-to-synthetic distance recovered by reformatting the record alone, adding no information.
High means the measured gap is largely about the shape of the text rather than its content.

### Trivial records (body restates the title or is process chatter)  (n=125 PRs, 383 questions)

Share of questions at each score. The distribution is the result; the mean is a
summary that misleads when the scores are bimodal, which on the real arm they are.

| arm | 0 absent | 1 partial | 2 explicit | mean |
| --- | --- | --- | --- | --- |
| real record | 80.7% | 17.2% | 2.1% | 0.22 |
| paraphrased record (form control) | 77.8% | 20.1% | 2.1% | 0.24 |
| synthetic (from diff) | 21.9% | 21.4% | 56.7% | 1.35 |

real - synthetic: **-1.14**  95% CI [-1.24, -1.03]
real - paraphrase: **-0.03**  95% CI [-0.07, 0.01]

**Form share: 2.5%** 95% CI [-1.1, 6.3] — the portion of the
real-to-synthetic distance recovered by reformatting the record alone, adding no information.
High means the measured gap is largely about the shape of the text rather than its content.

### Empty records (title alone)  (n=164 PRs, 514 questions)

Share of questions at each score. The distribution is the result; the mean is a
summary that misleads when the scores are bimodal, which on the real arm they are.

| arm | 0 absent | 1 partial | 2 explicit | mean |
| --- | --- | --- | --- | --- |
| real record | 89.3% | 9.9% | 0.8% | 0.11 |
| paraphrased record (form control) | 84.6% | 14.8% | 0.6% | 0.16 |
| synthetic (from diff) | 23.3% | 27.6% | 49.0% | 1.26 |

real - synthetic: **-1.15**  95% CI [-1.23, -1.07]
real - paraphrase: **-0.05**  95% CI [-0.08, -0.02]

**Form share: 4.0%** 95% CI [1.3, 6.9] — the portion of the
real-to-synthetic distance recovered by reformatting the record alone, adding no information.
High means the measured gap is largely about the shape of the text rather than its content.

### Agent-attested, substantive records only  (n=478 PRs, 1537 questions)

Share of questions at each score. The distribution is the result; the mean is a
summary that misleads when the scores are bimodal, which on the real arm they are.

| arm | 0 absent | 1 partial | 2 explicit | mean |
| --- | --- | --- | --- | --- |
| real record | 28.3% | 18.0% | 53.7% | 1.26 |
| paraphrased record (form control) | 30.8% | 19.0% | 50.2% | 1.20 |
| synthetic (from diff) | 19.5% | 26.3% | 54.3% | 1.37 |

real - synthetic: **-0.11**  95% CI [-0.16, -0.05]
real - paraphrase: **0.06**  95% CI [0.02, 0.09]

**Form share: -53.8%** 95% CI [-86.1, -22.1] — the portion of the
real-to-synthetic distance recovered by reformatting the record alone, adding no information.
High means the measured gap is largely about the shape of the text rather than its content.

## Text length by arm

| arm | median chars |
| --- | --- |
| real record | 536 |
| paraphrased record | 488 |
| synthetic | 1229 |

The paraphrase should track the record in length. If it has drifted toward the
synthetic it stopped being a form control and started adding information, which
would make it a second synthetic arm and void the comparison.

