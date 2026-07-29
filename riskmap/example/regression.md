# Regressing the outcomes on the dimensions

The retrospective test in `validation.md` compares regions the map FLAGGED against regions it did not. On this corpus that flag fires on **5 of 293** regions, so every interval in it rests on a treatment arm of 5. The flagging rule has also been rewritten twice, which makes it a moving target rather than a fixed hypothesis.

This document does not test the flag. It regresses the same outcomes on the **dimensions** as continuous predictors, over every region in the map at T. Same question, same data already on disk, two orders of magnitude more of it.

**The logical point that makes it worth doing.** A threshold is a coarsening of a continuous predictor: it discards information and cannot add any. So if a dimension has no continuous association with an outcome, **no threshold on that dimension can predict that outcome either** — including thresholds nobody has written yet. A continuous null is therefore stronger than a flag-level null and survives the next rewrite of the rule.

Built as of 18 months before each repository's HEAD, using only commits before that date; outcomes measured over the following 12 months.

Repositories: grafana/grafana (T=2025-01-27), apache/airflow (T=2025-01-27), supabase/supabase (T=2025-01-27), langchain-ai/langchain (T=2025-01-27)

## 1. Sample sizes, and what was dropped at each step

| repository | T | regions at T | flagged | still extant at T |
| --- | --- | --- | --- | --- |
| grafana/grafana | 2025-01-27 | 73 | 0 | 71 |
| apache/airflow | 2025-01-27 | 72 | 1 | 66 |
| supabase/supabase | 2025-01-27 | 72 | 3 | 36 |
| langchain-ai/langchain | 2025-01-27 | 76 | 1 | 51 |
| **all** | | **293** | **5** | **224** |

| step | regions | dropped here |
| --- | --- | --- |
| every region in the map at T | 293 | — |
| extantness at T determinable | 293 | 0 |
| **extant at T — the analysis sample** | **224** | 69 |

**Why the extant restriction, stated before the results.** 69 of the 293 regions had no non-excluded file left in their directory at T. A deleted directory cannot be rewritten, cannot receive a commit and cannot acquire a contributor: every outcome on it is arithmetic about absent code. Leaving them in would let "this directory does not exist" do the predictive work and would be reported as the dimensions predicting dormancy. Extantness at T is a function of history strictly before T, measured at the same instant the dimensions are, so restricting on it is covariate adjustment and not the collider `validate.ts` documents.

Of the analysis sample, 5 regions are flagged by the current rule. The flag is not used below except in that count.

Per-predictor availability on the analysis sample — no value is ever imputed:

| predictor | regions with a value | missing |
| --- | --- | --- |
| orphanedShare | 224 | 0 |
| concentration | 224 | 0 |
| recordCoverage | 0 | 224 |
| commitsPerMonth | 224 | 0 |
| contributors | 224 | 0 |
| extant | 224 | 0 |

- `recordCoverage` — Needs a model to score. Null on any run without --coverage; never imputed.
- `commitsPerMonth` — Also the adjustment variable. Its churn-adjusted row is uninformative BY CONSTRUCTION — banding on churn deciles removes almost all of its own variation — and is printed only so the table is not silently missing a cell.
- `extant` — A gate rather than a risk dimension, and constant inside the analysis sample. Estimated on the unrestricted sample and reported separately.

Any row below built from fewer than 20 regions is labelled **UNDERPOWERED** in place of being read.

## 2. The confound, and how it is adjusted for

**Churn at T is the critical confound.** The flag requires a region to clear a churn threshold while an unflagged live region only has to be non-zero, so every activity-correlated outcome inherits that difference. The same asymmetry runs through the continuous predictors: concentration is mechanically higher in a quiet region, because one contributor is a larger share of fewer commits, and orphaned share is mechanically higher where nothing recent has overwritten the old last-touches.

Adjustment is by **churn decile band**: the association is estimated inside each band and pooled across bands, which is the fixed-effects estimator. A median split would throw away nine tenths of the ordering, and a fitted linear term in churn would assume a functional form that a right-skewed quantity spanning three orders of magnitude does not have. Every within-band estimate is printed with its pooled estimate so a reader can see whether the sign is stable or whether one band is doing all the talking.

| band | n | churn at T (commits/month) | repositories |
| --- | --- | --- | --- |
| d1 | 23 | 0.63 – 1.21 | grafana/grafana 7, apache/airflow 7, langchain-ai/langchain 5, supabase/supabase 4 |
| d2 | 22 | 1.25 – 1.96 | apache/airflow 8, langchain-ai/langchain 7, supabase/supabase 5, grafana/grafana 2 |
| d3 | 23 | 2.08 – 2.92 | grafana/grafana 10, apache/airflow 5, supabase/supabase 4, langchain-ai/langchain 4 |
| d4 | 22 | 2.96 – 4.25 | grafana/grafana 8, langchain-ai/langchain 6, apache/airflow 5, supabase/supabase 3 |
| d5 | 22 | 4.25 – 5.17 | apache/airflow 8, grafana/grafana 6, langchain-ai/langchain 6, supabase/supabase 2 |
| d6 | 23 | 5.21 – 7.46 | grafana/grafana 9, apache/airflow 6, supabase/supabase 4, langchain-ai/langchain 4 |
| d7 | 22 | 7.51 – 9.55 | apache/airflow 8, grafana/grafana 7, langchain-ai/langchain 4, supabase/supabase 3 |
| d8 | 23 | 9.58 – 14.76 | grafana/grafana 7, langchain-ai/langchain 7, apache/airflow 6, supabase/supabase 3 |
| d9 | 22 | 15.68 – 30.19 | apache/airflow 10, grafana/grafana 7, langchain-ai/langchain 3, supabase/supabase 2 |
| d10 | 22 | 30.57 – 137.69 | grafana/grafana 8, supabase/supabase 6, langchain-ai/langchain 5, apache/airflow 3 |

Bands are cut on POOLED churn across repositories, so they partly absorb repository differences as well — a low band is disproportionately one repository. That is stated rather than hidden: it makes the adjustment stronger than a within-repository one and it means the adjusted estimates lean on comparisons between regions of similar absolute activity, wherever they live.

## 3. How entangled the predictors are

**analysis sample — regions extant at T** (n=224). Pairwise-complete Pearson; — means one series is constant or empty.

| | orphanedShare | concentration | recordCoverage | commitsPerMonth | contributors | extant |
| --- | --- | --- | --- | --- | --- | --- |
| **orphanedShare** | 1.000 | -0.010 | — | 0.013 | 0.023 | — |
| **concentration** | -0.010 | 1.000 | — | -0.205 | -0.336 | — |
| **recordCoverage** | — | — | — | — | — | — |
| **commitsPerMonth** | 0.013 | -0.205 | — | 1.000 | 0.743 | — |
| **contributors** | 0.023 | -0.336 | — | 0.743 | 1.000 | — |
| **extant** | — | — | — | — | — | — |

**unrestricted — every region at T with a known extantness** (n=293). Pairwise-complete Pearson; — means one series is constant or empty.

| | orphanedShare | concentration | recordCoverage | commitsPerMonth | contributors | extant |
| --- | --- | --- | --- | --- | --- | --- |
| **orphanedShare** | 1.000 | 0.113 | — | -0.005 | 0.036 | -0.263 |
| **concentration** | 0.113 | 1.000 | — | -0.198 | -0.334 | -0.104 |
| **recordCoverage** | — | — | — | — | — | — |
| **commitsPerMonth** | -0.005 | -0.198 | — | 1.000 | 0.752 | 0.029 |
| **contributors** | 0.036 | -0.334 | — | 0.752 | 1.000 | -0.031 |
| **extant** | -0.263 | -0.104 | — | 0.029 | -0.031 | 1.000 |

## 4. Results, one section per outcome

Every section states which direction is worse **before** the numbers. A wrong-direction result is never described as confirming anything: the verdict text is generated from the product of the outcome's harm direction and the predictor's claimed direction, and the "as predicted" branch is unreachable when the observed sign disagrees.

### dormancy — zero commits in the follow-up window

**Direction of harm, fixed before estimation: HIGHER is worse.**

Mean of the outcome on the estimation sample: **0.013** (n=224).

Estimates are the change in the outcome per **1 SD of the predictor** — for a 0/1 outcome that is a change in probability, from a linear probability model, which is fitted here because it needs no link function, no iterative solver and no dependency, and because at these rates the linear and logistic answers agree on sign and on whether the interval covers zero, which is all that is being read off. 95% cluster-bootstrap CI over regions.

| predictor | n | map claims | unadjusted | 95% CI | churn-adjusted | 95% CI | verdict (adjusted) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| orphanedShare | 224 | slope > 0 | -0.004 | [-0.010, 0.000] | -0.004 | [-0.011, 0.000] | NO ASSOCIATION — CI crosses zero (point estimate leans the WRONG direction) |
| concentration | 224 | slope > 0 | 0.001 | [-0.007, 0.009] | -0.002 | [-0.017, 0.010] | NO ASSOCIATION — CI crosses zero (point estimate leans the WRONG direction) |
| recordCoverage | 0 | slope < 0 | — | — | — | — | not estimable — no region carries both the predictor and the outcome |
| commitsPerMonth | 224 | slope > 0 | -0.005 | [-0.013, 0.001] | 0.001 | [-0.000, 0.007] | NO ASSOCIATION — CI crosses zero (point estimate leans the predicted direction) |
| contributors | 224 | slope < 0 | -0.004 | [-0.012, 0.003] | 0.001 | [-0.001, 0.005] | NO ASSOCIATION — CI crosses zero (point estimate leans the WRONG direction) |

<details><summary>Within-band estimates (churn deciles) — is the sign stable?</summary>

Cell: the per-SD estimate inside that band alone, with the band's n. — means the band held fewer than two regions or no variation in the predictor.

| predictor | d1 | d2 | d3 | d4 | d5 | d6 | d7 | d8 | d9 | d10 | bands with the predicted sign |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| orphanedShare | -0.008 (n=23) | -0.027 (n=22) | 0.000 (n=23) | 0.000 (n=22) | — (n=22) | 0.000 (n=23) | 0.000 (n=22) | -0.031 (n=23) | 0.000 (n=22) | 0.000 (n=22) | 0 of 9 |
| concentration | -0.049 (n=23) | 0.001 (n=22) | 0.000 (n=23) | 0.000 (n=22) | 0.000 (n=22) | 0.000 (n=23) | 0.000 (n=22) | 0.157 (n=23) | 0.000 (n=22) | 0.000 (n=22) | 2 of 10 |
| commitsPerMonth | -1.585 (n=23) | 0.985 (n=22) | 0.000 (n=23) | 0.000 (n=22) | 0.000 (n=22) | 0.000 (n=23) | 0.000 (n=22) | 0.451 (n=23) | 0.000 (n=22) | 0.000 (n=22) | 2 of 10 |
| contributors | 0.929 (n=23) | -0.081 (n=22) | 0.000 (n=23) | 0.000 (n=22) | 0.000 (n=22) | 0.000 (n=23) | 0.000 (n=22) | 0.039 (n=23) | 0.000 (n=22) | 0.000 (n=22) | 1 of 10 |

</details>

### wholesale rewrite — region classified rewritten

**Direction of harm, fixed before estimation: HIGHER is worse.**

Mean of the outcome on the estimation sample: **0.536** (n=224).

Estimates are the change in the outcome per **1 SD of the predictor** — for a 0/1 outcome that is a change in probability, from a linear probability model, which is fitted here because it needs no link function, no iterative solver and no dependency, and because at these rates the linear and logistic answers agree on sign and on whether the interval covers zero, which is all that is being read off. 95% cluster-bootstrap CI over regions.

| predictor | n | map claims | unadjusted | 95% CI | churn-adjusted | 95% CI | verdict (adjusted) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| orphanedShare | 224 | slope > 0 | -0.007 | [-0.078, 0.052] | 0.009 | [-0.064, 0.074] | NO ASSOCIATION — CI crosses zero (point estimate leans the predicted direction) |
| concentration | 224 | slope > 0 | -0.035 | [-0.099, 0.031] | -0.064 | [-0.129, 0.004] | NO ASSOCIATION — CI crosses zero (point estimate leans the WRONG direction) |
| recordCoverage | 0 | slope < 0 | — | — | — | — | not estimable — no region carries both the predictor and the outcome |
| commitsPerMonth | 224 | slope > 0 | -0.114 | [-0.165, -0.059] | 0.012 | [-0.039, 0.117] | NO ASSOCIATION — CI crosses zero (point estimate leans the predicted direction) |
| contributors | 224 | slope < 0 | -0.020 | [-0.108, 0.037] | 0.152 | [0.065, 0.217] | WRONG DIRECTION — CI excludes zero, OPPOSITE to the map's claim |

<details><summary>Within-band estimates (churn deciles) — is the sign stable?</summary>

Cell: the per-SD estimate inside that band alone, with the band's n. — means the band held fewer than two regions or no variation in the predictor.

| predictor | d1 | d2 | d3 | d4 | d5 | d6 | d7 | d8 | d9 | d10 | bands with the predicted sign |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| orphanedShare | 0.060 (n=23) | 0.162 (n=22) | 0.078 (n=23) | -0.320 (n=22) | — (n=22) | -0.085 (n=23) | -0.412 (n=22) | -0.322 (n=23) | -0.062 (n=22) | 0.206 (n=22) | 4 of 9 |
| concentration | -0.100 (n=23) | -0.081 (n=22) | -0.226 (n=23) | 0.094 (n=22) | -0.240 (n=22) | -0.042 (n=23) | -0.040 (n=22) | -0.192 (n=23) | 0.047 (n=22) | -0.095 (n=22) | 2 of 10 |
| commitsPerMonth | 27.358 (n=23) | 4.890 (n=22) | -2.999 (n=23) | 4.427 (n=22) | -6.282 (n=22) | 2.653 (n=23) | 3.640 (n=22) | -0.306 (n=23) | -0.893 (n=22) | 0.032 (n=22) | 6 of 10 |
| contributors | 3.941 (n=23) | 2.873 (n=22) | 0.978 (n=23) | -0.109 (n=22) | 1.219 (n=22) | 1.131 (n=23) | 0.287 (n=22) | 0.204 (n=23) | 0.241 (n=22) | 0.131 (n=22) | 1 of 10 |

</details>

### turnover — files at T deleted or moved out of the region

**Direction of harm, fixed before estimation: HIGHER is worse.**

Mean of the outcome on the estimation sample: **0.531** (n=224).

Estimates are the change in the outcome per **1 SD of the predictor** — for a 0/1 outcome that is a change in probability, from a linear probability model, which is fitted here because it needs no link function, no iterative solver and no dependency, and because at these rates the linear and logistic answers agree on sign and on whether the interval covers zero, which is all that is being read off. 95% cluster-bootstrap CI over regions.

| predictor | n | map claims | unadjusted | 95% CI | churn-adjusted | 95% CI | verdict (adjusted) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| orphanedShare | 224 | slope > 0 | -0.040 | [-0.094, 0.020] | -0.023 | [-0.077, 0.035] | NO ASSOCIATION — CI crosses zero (point estimate leans the WRONG direction) |
| concentration | 224 | slope > 0 | -0.055 | [-0.114, 0.008] | -0.084 | [-0.143, -0.025] | WRONG DIRECTION — CI excludes zero, OPPOSITE to the map's claim |
| recordCoverage | 0 | slope < 0 | — | — | — | — | not estimable — no region carries both the predictor and the outcome |
| commitsPerMonth | 224 | slope > 0 | -0.094 | [-0.139, -0.045] | 0.024 | [-0.026, 0.118] | NO ASSOCIATION — CI crosses zero (point estimate leans the predicted direction) |
| contributors | 224 | slope < 0 | -0.009 | [-0.091, 0.042] | 0.143 | [0.071, 0.201] | WRONG DIRECTION — CI excludes zero, OPPOSITE to the map's claim |

<details><summary>Within-band estimates (churn deciles) — is the sign stable?</summary>

Cell: the per-SD estimate inside that band alone, with the band's n. — means the band held fewer than two regions or no variation in the predictor.

| predictor | d1 | d2 | d3 | d4 | d5 | d6 | d7 | d8 | d9 | d10 | bands with the predicted sign |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| orphanedShare | 0.065 (n=23) | 0.142 (n=22) | -0.002 (n=23) | -0.306 (n=22) | — (n=22) | -0.079 (n=23) | -2.058 (n=22) | -0.342 (n=23) | -0.002 (n=22) | 0.165 (n=22) | 3 of 9 |
| concentration | -0.113 (n=23) | -0.063 (n=22) | -0.187 (n=23) | 0.059 (n=22) | -0.266 (n=22) | -0.020 (n=23) | -0.032 (n=22) | -0.091 (n=23) | -0.142 (n=22) | -0.089 (n=22) | 1 of 10 |
| commitsPerMonth | 20.499 (n=23) | 6.919 (n=22) | -0.699 (n=23) | 6.807 (n=22) | -5.928 (n=22) | 1.392 (n=23) | 1.628 (n=22) | -0.500 (n=23) | -0.660 (n=22) | 0.040 (n=22) | 6 of 10 |
| contributors | 3.866 (n=23) | 2.702 (n=22) | 0.491 (n=23) | 0.348 (n=22) | 1.255 (n=22) | 0.694 (n=23) | 0.209 (n=22) | 0.152 (n=23) | 0.355 (n=22) | 0.121 (n=22) | 0 of 10 |

</details>

### replacement — post-T deleted lines / lines at T

**Direction of harm, fixed before estimation: HIGHER is worse.**

Mean of the outcome on the estimation sample: **1.057** (n=224).

Estimates are the change in the outcome per **1 SD of the predictor** — for a 0/1 outcome that is a change in probability, from a linear probability model, which is fitted here because it needs no link function, no iterative solver and no dependency, and because at these rates the linear and logistic answers agree on sign and on whether the interval covers zero, which is all that is being read off. 95% cluster-bootstrap CI over regions.

| predictor | n | map claims | unadjusted | 95% CI | churn-adjusted | 95% CI | verdict (adjusted) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| orphanedShare | 224 | slope > 0 | -0.244 | [-0.676, -0.017] | -0.167 | [-0.605, 0.001] | NO ASSOCIATION — CI crosses zero (point estimate leans the WRONG direction) |
| concentration | 224 | slope > 0 | 0.231 | [-0.068, 0.658] | -0.130 | [-0.996, 0.407] | NO ASSOCIATION — CI crosses zero (point estimate leans the WRONG direction) |
| recordCoverage | 0 | slope < 0 | — | — | — | — | not estimable — no region carries both the predictor and the outcome |
| commitsPerMonth | 224 | slope > 0 | -0.222 | [-0.949, 0.258] | -0.042 | [-0.362, 0.257] | NO ASSOCIATION — CI crosses zero (point estimate leans the WRONG direction) |
| contributors | 224 | slope < 0 | -0.179 | [-0.744, 0.207] | 0.089 | [-0.154, 0.671] | NO ASSOCIATION — CI crosses zero (point estimate leans the WRONG direction) |

<details><summary>Within-band estimates (churn deciles) — is the sign stable?</summary>

Cell: the per-SD estimate inside that band alone, with the band's n. — means the band held fewer than two regions or no variation in the predictor.

| predictor | d1 | d2 | d3 | d4 | d5 | d6 | d7 | d8 | d9 | d10 | bands with the predicted sign |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| orphanedShare | -0.029 (n=23) | -3.988 (n=22) | 0.025 (n=23) | -0.108 (n=22) | — (n=22) | -0.029 (n=23) | 25.748 (n=22) | -0.122 (n=23) | -0.311 (n=22) | -0.772 (n=22) | 2 of 9 |
| concentration | 0.100 (n=23) | -2.568 (n=22) | -0.018 (n=23) | -0.077 (n=22) | 0.111 (n=22) | 0.262 (n=23) | 0.061 (n=22) | 0.669 (n=23) | 0.985 (n=22) | 0.431 (n=22) | 7 of 10 |
| commitsPerMonth | 36.412 (n=23) | 633.847 (n=22) | 1.241 (n=23) | -7.040 (n=22) | -4.669 (n=22) | 3.876 (n=23) | 10.158 (n=22) | 4.541 (n=23) | -3.551 (n=22) | -0.013 (n=22) | 6 of 10 |
| contributors | -1.731 (n=23) | 220.981 (n=22) | 0.203 (n=23) | 0.160 (n=22) | -0.673 (n=22) | -0.086 (n=23) | -0.467 (n=22) | -0.571 (n=23) | -0.048 (n=22) | -0.056 (n=22) | 7 of 10 |

</details>

### distinct contributors post-T

**Direction of harm, fixed before estimation: LOWER is worse.**

Mean of the outcome on the estimation sample: **31.545** (n=224).

Estimates are the change in the outcome per **1 SD of the predictor** — for a 0/1 outcome that is a change in probability, from a linear probability model, which is fitted here because it needs no link function, no iterative solver and no dependency, and because at these rates the linear and logistic answers agree on sign and on whether the interval covers zero, which is all that is being read off. 95% cluster-bootstrap CI over regions.

| predictor | n | map claims | unadjusted | 95% CI | churn-adjusted | 95% CI | verdict (adjusted) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| orphanedShare | 224 | slope < 0 | 0.104 | [-3.663, 4.771] | -0.486 | [-4.126, 2.858] | NO ASSOCIATION — CI crosses zero (point estimate leans the predicted direction) |
| concentration | 224 | slope < 0 | -10.266 | [-16.655, -3.902] | -5.019 | [-11.027, 1.037] | NO ASSOCIATION — CI crosses zero (point estimate leans the predicted direction) |
| recordCoverage | 0 | slope > 0 | — | — | — | — | not estimable — no region carries both the predictor and the outcome |
| commitsPerMonth | 224 | slope < 0 | 34.675 | [25.050, 44.508] | 25.436 | [11.268, 38.854] | WRONG DIRECTION — CI excludes zero, OPPOSITE to the map's claim |
| contributors | 224 | slope > 0 | 29.091 | [19.080, 41.931] | 11.531 | [0.901, 29.452] | AS PREDICTED — CI excludes zero in the claimed direction |

<details><summary>Within-band estimates (churn deciles) — is the sign stable?</summary>

Cell: the per-SD estimate inside that band alone, with the band's n. — means the band held fewer than two regions or no variation in the predictor.

| predictor | d1 | d2 | d3 | d4 | d5 | d6 | d7 | d8 | d9 | d10 | bands with the predicted sign |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| orphanedShare | -0.204 (n=23) | -6.896 (n=22) | 0.651 (n=23) | 3.653 (n=22) | — (n=22) | -1.310 (n=23) | 263.851 (n=22) | 10.851 (n=23) | -1.255 (n=22) | -52.899 (n=22) | 5 of 9 |
| concentration | 0.886 (n=23) | -4.810 (n=22) | -1.658 (n=23) | -3.648 (n=22) | 6.937 (n=22) | 1.085 (n=23) | -3.244 (n=22) | -0.660 (n=23) | -16.715 (n=22) | -12.058 (n=22) | 7 of 10 |
| commitsPerMonth | 38.879 (n=23) | 671.414 (n=22) | -0.769 (n=23) | 137.659 (n=22) | 111.525 (n=22) | 105.473 (n=23) | 170.388 (n=22) | 71.256 (n=23) | 44.528 (n=22) | 24.609 (n=22) | 1 of 10 |
| contributors | -24.887 (n=23) | 209.946 (n=22) | 22.331 (n=23) | 43.930 (n=22) | -24.761 (n=22) | 26.437 (n=23) | -3.928 (n=22) | -3.173 (n=23) | 58.818 (n=22) | 10.435 (n=22) | 6 of 10 |

</details>

### fix / revert rate over post-T commits

**Direction of harm, fixed before estimation: HIGHER is worse.**
_A rate over post-T commits, so undefined for a dormant region. Not zero — undefined._

Mean of the outcome on the estimation sample: **0.010** (n=221, 3 regions dropped for a missing outcome).

Estimates are the change in the outcome per **1 SD of the predictor** — for a 0/1 outcome that is a change in probability, from a linear probability model, which is fitted here because it needs no link function, no iterative solver and no dependency, and because at these rates the linear and logistic answers agree on sign and on whether the interval covers zero, which is all that is being read off. 95% cluster-bootstrap CI over regions.

| predictor | n | map claims | unadjusted | 95% CI | churn-adjusted | 95% CI | verdict (adjusted) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| orphanedShare | 221 | slope > 0 | -0.001 | [-0.003, 0.001] | -0.001 | [-0.005, 0.001] | NO ASSOCIATION — CI crosses zero (point estimate leans the WRONG direction) |
| concentration | 221 | slope > 0 | -0.001 | [-0.002, 0.002] | -0.001 | [-0.005, 0.001] | NO ASSOCIATION — CI crosses zero (point estimate leans the WRONG direction) |
| recordCoverage | 0 | slope < 0 | — | — | — | — | not estimable — no region carries both the predictor and the outcome |
| commitsPerMonth | 221 | slope > 0 | -0.001 | [-0.004, 0.002] | 0.001 | [-0.001, 0.002] | NO ASSOCIATION — CI crosses zero (point estimate leans the predicted direction) |
| contributors | 221 | slope < 0 | -0.002 | [-0.005, 0.001] | -0.001 | [-0.003, -0.000] | AS PREDICTED — CI excludes zero in the claimed direction |

<details><summary>Within-band estimates (churn deciles) — is the sign stable?</summary>

Cell: the per-SD estimate inside that band alone, with the band's n. — means the band held fewer than two regions or no variation in the predictor.

| predictor | d1 | d2 | d3 | d4 | d5 | d6 | d7 | d8 | d9 | d10 | bands with the predicted sign |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| orphanedShare | -0.005 (n=22) | -0.001 (n=21) | -0.001 (n=23) | 0.018 (n=22) | — (n=22) | -0.002 (n=23) | -0.058 (n=22) | 0.001 (n=22) | -0.000 (n=22) | 0.000 (n=22) | 3 of 9 |
| concentration | -0.013 (n=22) | -0.000 (n=21) | -0.001 (n=23) | -0.001 (n=22) | 0.004 (n=22) | -0.002 (n=23) | 0.001 (n=22) | 0.015 (n=22) | 0.001 (n=22) | -0.001 (n=22) | 4 of 10 |
| commitsPerMonth | 4.429 (n=22) | 0.111 (n=21) | -0.001 (n=23) | -0.219 (n=22) | -0.304 (n=22) | -0.091 (n=23) | -0.160 (n=22) | 0.045 (n=22) | 0.003 (n=22) | 0.001 (n=22) | 5 of 10 |
| contributors | 0.314 (n=22) | 0.017 (n=21) | -0.014 (n=23) | -0.016 (n=22) | -0.008 (n=22) | -0.019 (n=23) | -0.011 (n=22) | -0.018 (n=22) | -0.004 (n=22) | -0.001 (n=22) | 8 of 10 |

</details>

### rework rate — post-T commits re-touching a file touched within 30 days

**Direction of harm, fixed before estimation: HIGHER is worse.**
_Same denominator problem as the fix rate; dormant regions are dropped, not zeroed._

Mean of the outcome on the estimation sample: **0.556** (n=221, 3 regions dropped for a missing outcome).

Estimates are the change in the outcome per **1 SD of the predictor** — for a 0/1 outcome that is a change in probability, from a linear probability model, which is fitted here because it needs no link function, no iterative solver and no dependency, and because at these rates the linear and logistic answers agree on sign and on whether the interval covers zero, which is all that is being read off. 95% cluster-bootstrap CI over regions.

| predictor | n | map claims | unadjusted | 95% CI | churn-adjusted | 95% CI | verdict (adjusted) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| orphanedShare | 221 | slope > 0 | -0.039 | [-0.077, 0.007] | -0.040 | [-0.079, -0.001] | WRONG DIRECTION — CI excludes zero, OPPOSITE to the map's claim |
| concentration | 221 | slope > 0 | -0.037 | [-0.075, -0.002] | 0.007 | [-0.030, 0.045] | NO ASSOCIATION — CI crosses zero (point estimate leans the predicted direction) |
| recordCoverage | 0 | slope < 0 | — | — | — | — | not estimable — no region carries both the predictor and the outcome |
| commitsPerMonth | 221 | slope > 0 | 0.070 | [0.046, 0.095] | 0.018 | [-0.027, 0.054] | NO ASSOCIATION — CI crosses zero (point estimate leans the predicted direction) |
| contributors | 221 | slope < 0 | 0.040 | [0.011, 0.088] | -0.040 | [-0.074, 0.002] | NO ASSOCIATION — CI crosses zero (point estimate leans the predicted direction) |

<details><summary>Within-band estimates (churn deciles) — is the sign stable?</summary>

Cell: the per-SD estimate inside that band alone, with the band's n. — means the band held fewer than two regions or no variation in the predictor.

| predictor | d1 | d2 | d3 | d4 | d5 | d6 | d7 | d8 | d9 | d10 | bands with the predicted sign |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| orphanedShare | 0.018 (n=22) | -0.262 (n=21) | -0.056 (n=23) | -0.032 (n=22) | — (n=22) | -0.009 (n=23) | 0.830 (n=22) | -0.065 (n=22) | -0.027 (n=22) | -0.056 (n=22) | 2 of 9 |
| concentration | 0.089 (n=22) | 0.045 (n=21) | -0.100 (n=23) | -0.018 (n=22) | 0.100 (n=22) | 0.048 (n=23) | -0.087 (n=22) | 0.104 (n=22) | 0.011 (n=22) | 0.039 (n=22) | 7 of 10 |
| commitsPerMonth | -1.717 (n=22) | 10.641 (n=21) | 0.789 (n=23) | 0.678 (n=22) | -5.950 (n=22) | 0.997 (n=23) | -0.447 (n=22) | 0.244 (n=22) | -0.134 (n=22) | 0.021 (n=22) | 6 of 10 |
| contributors | -2.707 (n=22) | 0.639 (n=21) | 0.890 (n=23) | 0.046 (n=22) | -0.594 (n=22) | -0.548 (n=23) | 0.034 (n=22) | -0.420 (n=22) | -0.016 (n=22) | -0.032 (n=22) | 6 of 10 |

</details>

## 5. `extant` at T, on the unrestricted sample

Extantness is constant inside the analysis sample by construction, so it cannot be estimated there. It is reported here over every region at T with a determinable extantness (n=293), and it carries **no directional claim**: the map does not say an existing directory is worse than a deleted one, it says a deleted one cannot be at risk. It is a gate, not a risk dimension.

| outcome | n | unadjusted | 95% CI | churn-adjusted | 95% CI |
| --- | --- | --- | --- | --- | --- |
| dormant | 293 | -0.419 | [-0.448, -0.385] | -0.419 | [-0.448, -0.384] |
| rewritten | 224 | — | — | — | — |
| turnover | 224 | — | — | — | — |
| replacement | 224 | — | — | — | — |
| contributorsPostT | 293 | 13.408 | [10.690, 16.761] | 12.293 | [9.236, 16.099] |
| fixRate | 221 | — | — | — | — |
| reworkRate | 221 | — | — | — | — |

## 6. The blunt verdict, one line per dimension

### `orphanedShare`

**Predicts in the WRONG direction — evidence against the claim, not for it:** reworkRate (-0.040 per SD, [-0.079, -0.001]).
No association with: dormant, rewritten, turnover, replacement, contributorsPostT, fixRate.

### `concentration`

**Predicts in the WRONG direction — evidence against the claim, not for it:** turnover (-0.084 per SD, [-0.143, -0.025]).
No association with: dormant, rewritten, replacement, contributorsPostT, fixRate, reworkRate.

### `recordCoverage`

**Not tested.** No region carries a value for this predictor on this run (224 missing of 224). Nothing about it — positive or negative — follows from this document.

### `commitsPerMonth`

**Predicts in the WRONG direction — evidence against the claim, not for it:** contributorsPostT (25.436 per SD, [11.268, 38.854]).
No association with: dormant, rewritten, turnover, replacement, fixRate, reworkRate.

### `contributors`

**Predicts, in the claimed direction:** contributorsPostT (11.531 per SD, [0.901, 29.452]); fixRate (-0.001 per SD, [-0.003, -0.000]).
**Predicts in the WRONG direction — evidence against the claim, not for it:** rewritten (0.152 per SD, [0.065, 0.217]); turnover (0.143 per SD, [0.071, 0.201]).
No association with: dormant, replacement, reworkRate.

## 7. Notes

- RECORD COVERAGE WAS NOT SCORED ON THIS RUN, so it has no rows and no coefficient. It is reported as n=0 rather than imputed: a mean-filled predictor would have zero variance, a coefficient of exactly nothing, and a table row indistinguishable from a tested null. Scoring it needs a model key and `regress --coverage`, which builds the map as of T with the coverage stage enabled.

## 8. What this cannot establish

- Regions are not randomly assigned their dimension values, so every number here is an association. Banding on churn removes one confound and names it; it does nothing about the ones nobody has named.
- Regions inside a repository share authors, a release cycle and a build system. The cluster bootstrap over regions handles that for variance and cannot handle it for confounding.
- Fix rate and rework rate are derived from commit messages, which is the same channel the record dimension measures. A team that never writes "revert" looks healthy by construction.
- A per-SD estimate is a linear summary. A dimension that only bites in its top few per cent would show a small linear slope, and this document would call that a null. The within-band columns are the check on that: a real threshold effect concentrated in one part of the range would show up as one band disagreeing loudly with the rest.
- Public repositories are not private codebases, and no individual is identifiable here.

