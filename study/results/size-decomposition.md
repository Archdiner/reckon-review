# Decomposing the agent-vs-human contrast

Both terms of the difference move, so both are reported. Figures are the share of
mechanism questions answered EXPLICITLY (score 2).

## Within size bucket

| size | real agent | real human | real diff | synth agent | synth human | synth diff |
| --- | --- | --- | --- | --- | --- | --- |
| 20-49 | 48.2 | 6.6 | **41.7** | 68.0 | 74.2 | -6.2 |
| 50-149 | 44.2 | 8.9 | **35.3** | 66.5 | 67.6 | -1.2 |
| 150-499 | 45.9 | 8.5 | **37.4** | 57.8 | 64.6 | -6.8 |
| 500+ | 46.0 | 10.6 | **35.4** | 33.9 | 42.5 | -8.6 |

Mean within-bucket real-arm difference: **37.5 points**
Mean within-bucket synthetic-arm difference: **-5.7 points**

The real-arm difference is stable across every size bucket. The synthetic-arm
difference is small and shrinks once size is held fixed, which is what identifies it
as a size-composition effect rather than a property of who wrote the change.

## The synthetic writer degrades with diff size

| size | synthetic explicit % | real explicit % |
| --- | --- | --- |
| 20-49 | 71.9 | 21.8 |
| 50-149 | 67.1 | 24.8 |
| 150-499 | 61.0 | 28.3 |
| 500+ | 37.1 | 32.9 |

A bigger diff gives the synthetic writer more mechanism to cover from a fixed digest
budget, so it misses more. The real record does not degrade the same way — it barely
moves with size at all, within either arm.

This is also the honest limit on the reproducibility claim: the synthetic arm is
strongest exactly where changes are small, and small changes are where mechanism is
least likely to matter.

