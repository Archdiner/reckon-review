# Record coverage across repositories

13 scored, 0 refused by the body-density gate, 1 not measured.

Pooled: **34.8% of 12,339 mechanism questions** are answered explicitly by the commits that made the change.

| repository | coverage | questions | areas scored | usable cells | areas not scored | body density |
| --- | --- | --- | --- | --- | --- | --- |
| `prisma/prisma` | **60.5%** | 948 | 20 | 20 | 11 | 100% |
| `appwrite/appwrite` | **51.6%** | 915 | 20 | 19 | 49 | 57% |
| `tailwindlabs/tailwindcss` | **40.6%** | 925 | 20 | 20 | 10 | 85% |
| `denoland/deno` | **39.8%** | 968 | 20 | 20 | 49 | 61% |
| `apache/airflow` | **38.4%** | 924 | 20 | 20 | 39 | 58% |
| `langchain-ai/langchain` | **33.4%** | 947 | 20 | 20 | 25 | 69% |
| `vercel/next.js` | **32.6%** | 944 | 20 | 20 | 45 | 83% |
| `strapi/strapi` | **32.0%** | 975 | 20 | 20 | 37 | 62% |
| `facebook/react` | **31.6%** | 947 | 20 | 20 | 34 | 73% |
| `grafana/grafana` | **29.3%** | 980 | 20 | 20 | 44 | 53% |
| `supabase/supabase` | **24.4%** | 967 | 20 | 20 | 49 | 91% |
| `calcom/cal.com` | **22.5%** | 997 | 20 | 20 | 31 | 56% |
| `directus/directus` | **17.0%** | 902 | 20 | 20 | 20 | 62% |

Between-repository spread: 17.0% to 60.5%. That range is the reason a single-repository number could not be generalised, and the reason this sweep exists.

## Is a per-area map worth building, or would one number per repository do?

Over 259 usable area estimates in 13 repositories, **66% of the true variance sits BETWEEN repositories** and 34% WITHIN them.

| component | variance | as SD |
| --- | --- | --- |
| between repositories | 0.01270 | 0.113 |
| within repositories, raw | 0.01076 | 0.104 |
| — of which sampling noise | 0.00430 | 0.066 |
| within repositories, corrected | 0.00646 | 0.080 |

Each area estimate carries binomial sampling error, so the raw within-repository spread is real spread plus noise. The expected sampling variance is subtracted, which is the standard correction; the uncorrected share would read 54% between rather than 66%, and both are printed so the size of the correction is visible.

Read it as the answer to a design question rather than a finding about software: the larger the within-repository share, the more a project-level number averages away what a maintainer would act on, and the more a per-area map earns its keep. Only usable cells count — an estimate too thin to colour has no business in a variance decomposition.

### What depth would make area-to-area differences readable

True within-repository spread is 8.0 points of standard deviation. For an area's own sampling error to fall to half of that — the point at which the ordering of areas starts to carry signal rather than noise — an area needs about **141 questions**, which at the observed 3.2 questions per commit is about **45 commits per area**.

This sweep sampled a median of 48 questions per area, so the depth ratio is roughly 2.9x. The half-an-SD criterion is a stated convention rather than a test, and it is the number to argue with if you disagree with the conclusion.

The consequence is a budget statement, not a defect: at the current depth the REPOSITORY is the unit this measurement resolves, and a per-area page is drawing a mixture of signal and sampling error. Spending the same budget on fewer, larger units is the change that would make an area-level ordering trustworthy — not a better decomposition of the same spend.

## Not measured

- `withastro/astro` — Command failed: git log -1 --date=iso-strict --format=%H%x1f%ad

## What this is

Questions are generated from the diff alone by the production generator; a second model scores the commit record against them and never sees the code. A tripped separation guard aborts the run. "Explicit" means the record answers the question outright, not that a reader could infer it.

Each repository contributes its largest areas at full sampling depth rather than every area thinly: at 5 sampled commits per area, 82% of cells fail the interval rule and are greyed, so a thin-everywhere sweep would have produced a page of grey. The count of unscored areas is in the table above and in each per-repository JSON.
