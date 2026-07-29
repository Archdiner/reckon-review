# The git-history risk map

> ## RETIRED — the risk map is not maintained. The record map is.
>
> **What happened.** The risk map ranked regions on ownership: departed share, concentration,
> churn. Those dimensions were tested — not left unvalidated — by rebuilding the map as of a
> cutoff 18 months back on four repositories and regressing what happened next on the dimensions
> themselves rather than on the flagging rule. **At n=224 regions, neither ownership dimension has
> any association with any outcome**, and two of the point estimates run the wrong way.
>
> That result is stronger than it looks, and it is why this is a retirement rather than a to-do.
> A threshold is a coarsening of a continuous predictor: it discards information and cannot add
> any. So a continuous null does not merely fail to support *this* rule — **it rules out every
> threshold on these dimensions**, including the ones a future version would have tried. There is
> no version of this artifact that these numbers leave standing. See `out/regress/regression.md`.
>
> **What survives, and it is the better half.** One dimension was never in the refutation, because
> it could not be measured for free: **record coverage** — the share of mechanism questions about a
> change that the written record actually answers. It is the only dimension backed by a corpus
> (1,000 merged pull requests, scored), it is the one thing the study is *about*, and it needs no
> claim about people at all. It lives on as **the record map**:
>
> ```bash
> npm run riskmap -- recordmap clones/repo        # coverage only. No ownership, no departure.
> ```
>
> **What still reads as true in this file below the line.** The extraction, the exclusions, the
> mixed-depth region cut, the identity clustering, the squash gate, the calibration and the
> information-separation guards are all shared with the record map and are all still in use. The
> ownership dimensions, the two named findings, the flagging rule and the flag-level validation are
> the retired part. They are kept rather than deleted because a measured refutation is a result, and
> deleting it would leave the next person to rediscover it at the same cost.
>
> **The loose end is now closed, and it closed the same way.** Record coverage as a *predictor of
> future outcomes* was untested when the ownership dimensions were refuted (n=0 — the validation
> builder did not score coverage at the cutoff). `regress --coverage` scored it on **223 of 224**
> analysis regions across four repositories, and it predicts nothing in the claimed direction: no
> association with dormancy, replacement, post-cutoff contributors, fix rate or rework rate — and two
> outcomes come back the WRONG way with intervals excluding zero. Better-covered areas were rewritten
> *more* (+0.098 per SD, 95% CI [0.038, 0.160], churn-adjusted) and turned over more of their files
> (+0.096 [0.038, 0.155]). So **all four dimensions are now tested and none of them forecasts anything
> measurable in git.**
>
> **That is a result about prediction, not about measurement, and the distinction is the point.** What
> a record says is checkable by reading it, and the record map reports exactly that. Whether a written
> record forecasts what happens to a directory a year later is a separate claim; it was worth testing
> precisely because it is the claim a heatmap invites a reader to make; and it does not hold. Nothing
> in the record map asserts it, and nothing should be built that does.

A one-page artifact you can generate for any repository from a clone alone. No install, no app
permissions, no behaviour change from anyone on the team.

It answers one question: **which parts of this codebase are at risk because the people who
understood them are gone, thin on the ground, or never wrote anything down.**

```bash
cd riskmap && npm install
git clone --shallow-since="5 years ago" https://github.com/owner/repo clones/repo
npm run riskmap -- map clones/repo          # writes out/repo-risk-map.html
```

**Not `--filter=blob:none`**, which the build spec suggested. A blobless clone has no file
contents, and `git log --numstat` needs them, so git refetches every blob one at a time over the
network — a grafana run did not finish in ten minutes. `--shallow-since` fetches blobs but only
for the window, which took 82 seconds and made the whole map a 2-minute job.

That path needs no API key, no network beyond the clone, and no configuration. Record coverage
is the one dimension that needs a model, and it is opt-in:

```bash
export OPENAI_API_KEY=...                   # or ANTHROPIC_API_KEY, or both
npm run riskmap -- map clones/repo --coverage
```

---

## What it produces

One static HTML page, openable from an email attachment. The top ten flagged regions as a
table, one line of plain English per region explaining why it flagged, the same recommended
action on every row, and a methodology footer carrying the thresholds, the exclusions, the
window and the departure proxy.

There is no dashboard, no login, no filter and no drill-down. That is a decision, not a
backlog: interactivity is how this becomes a two-month project that never gets sent to anyone,
and an artifact nobody receives has no value.

## Design rules the code enforces

**Code is the primary object. People are an attribute of regions.** Never a list of people,
never a leaderboard. The moment it reads as a report on individuals it becomes an HR object.

**No individual is ever named in the output**, and this is structural rather than a convention.
`identity.ts` is the only module that ever sees a name or an address, and it returns a
truncated hash. Everything downstream — dimensions, ranking, rendering — is physically
incapable of printing a name because it was never given one.

**Every flagged region carries a next action**, identical on every row: *this region needs a
written explanation from someone who still works here.* Varying it would imply a diagnosis the
tool cannot make.

**Dimensions, not a composite score.** Nothing anywhere is summed or weighted. A single risk
number invites an argument about weights, hides the reason a region surfaced, and leaves a
disagreeing reader with nothing to point at.

**Ten regions, not four hundred cells.** The value is triage.

## The dimensions

Computed over a trailing 24-month window, keyed off HEAD's author date rather than wall clock
so the same clone yields the same map.

| Dimension | What it is |
| --- | --- |
| **Departed share** | Of the files here now, the share whose most recent change came from a *departed* contributor: no commit anywhere in the repo in 12 months **and** a substantial prior footprint (≥5 commits spanning ≥90 days). The headline. |
| **Concentration** | Share from the single largest contributor. With orphaned share, this is the bus-factor cell. |
| **Churn** | Commits and lines per month. A region nobody touches is lower risk than a hot one with the same ownership profile. |
| **Record coverage** | Share of mechanism questions about a change that the commit records actually answer, scored with the production question generator. Opt-in. |
| **Agent density** | Share of commits carrying an agent `Co-authored-by` trailer. Context, not quality. |
| **Last explanation** | The most recent commit whose message says anything beyond its own subject. |

**Two named findings, kept separate.** A region is **departed** when it is still moving, still
exists in the tree, and ≥50% of its files were last changed by a departed contributor. It is
**concentrated** when it is still moving, still exists, and ≥50% of its changes came from one
person. Liveness and existence are preconditions for both — a deleted directory has nothing left
to understand, and dead code is not a risk anyone needs to act on.

They are different conversations. Bus factor is chronic and every engineering leader can already
name theirs; departure is acute, dated, and usually has an incident attached. Blending them lets
the artifact overclaim: grafana's only flagged region has a departed share of **zero** and is
flagged purely on concentration.

**How often each fires, measured on four repositories** — the number that sizes any outreach or
validation plan:

| finding | per repo | repos needed for 30 such regions |
| --- | --- | --- |
| concentrated | 1.75 | ~18 |
| departed | **0.25** | **~120** |

Hit rate is 2 of 4 repos, so roughly 20 repositories scanned per 10 sendable artifacts — but
nearly all of those are concentration findings. n=4 repos, and the departed rate rests on a
single observed region, so treat both as order-of-magnitude.

### Three rules the spec got wrong, found by running it

**"At least three of four" flags nothing.** `orphaned` and `hot` are anti-correlated by
construction — a region under active development has active contributors — so demanding both is
close to demanding a contradiction. On grafana it flagged zero regions while `pkg/framework` sat
at 0.85 orphaned and 0.80 concentrated with four contributors. Churn and thin documentation
*amplify* an ownership problem; on their own they describe a busy or a terse region, which is not
what this artifact is about.

**A fixed churn threshold does not survive contact with a second repository.** 2 commits/month
means something completely different on a repo with 200 commits a year and one with 20,000: on
grafana it marked four fifths of the codebase hot. The operative threshold is the **median region
churn of the repository being mapped**, computed at run time and printed in the output.

**A commit-SHARE orphan measure cannot express the target at any window.** Recent commits by
active people sit in the same denominator, so activity dilutes orphaning and the two are
anti-correlated by construction: the busy-and-orphaned cell was empty on grafana at 24, 36 and 60
months, and with the orphan and churn windows decoupled. The headline is now **last-touch file
share** — of the files here now, how many were last written by someone gone — which a live region
can score high on. With that measure 24 months is sufficient and the window is back to 24.

## Calibration, and a correction to the spec

Raw coverage numbers are meaningless to a reader; nobody has an intuition for whether 0.34 is
good. So coverage is reported as a position against the study's corpus: 1,000 merged pull
requests from Grafana, Airflow, Supabase, LangChain and Prisma, scored with the same generator
and the same rubric.

**The build spec asked for the line "this region sits in the bottom decile". That sentence
cannot be said honestly against this corpus.** 55.7% of the 1,000 PRs score exactly zero — and
38.4% of the substantive-only comparison set the percentiles actually use — so the bottom deciles
are all 0.0 and there is no bottom decile to sit in. This is the same bimodality the study insists
on when it refuses to lead with means.

So the tool reports **midrank percentiles** and says *"lower than or tied with N% of 711 merged
pull requests"*, naming the size of the tie. It never says "decile" for a value inside the zero
mass.

One consequence is stated rather than hidden: a zero-coverage region's midrank percentile is
**19.2** against the comparison set, so the `undocumented` threshold sits at **22** rather than a
round 25 — below 19.2 the test could never fire on a region whose commits explained nothing at
all.

**Regions of different sizes are compared without normalising**, and that is licensed by
measurement rather than assumed: the study found record coverage flat across a tenfold range of
change size — under 3 points of movement, against 25-26 points for a measure that does respond
to size.

**The unit mismatch, measured — and the earlier version of this paragraph was wrong in premise
and in sign.** It used to say: the corpus scores pull-request records (description plus commit
messages) while this tool scores commit messages only, so a commit-only record is a subset and
these percentiles are biased **low**. Both halves were false, and measuring it is what showed it.

*The premise.* The study builds its record from `%s` and `%b` of `git log --no-merges` — the
subject and body of one squash commit. This tool builds its record from `${subject}\n\n${body}`:
**the same two fields of the same command.** All five corpus repositories were admitted precisely
because descriptions survive their merge button, so where a squash body holds the description, this
tool reads it. There is no missing channel to correct for.

*The sign.* The real bias runs the other way, from a source the old paragraph never mentioned. This
tool scores only commits graded **substantive**, while the 1,000-PR distribution also contains 164
empty and 125 trivial records that drag it down. Comparing a substantive-only measurement against a
distribution including them made every percentile **8 to 17 points too flattering** — opposite sign,
comparable magnitude, and no assumption about missing channels required. Percentiles are now taken
against the substantive-only distribution (n=711); the unrestricted one stays in the calibration
file so the restriction is checkable rather than asserted.

*What is still genuinely unknown.* For a repository that does **not** squash, this tool reads one
commit's message and generates questions from one commit's diff, so numerator and denominator both
narrow and the net direction is not knowable a priori. That is a per-repository conditional the
squash detector already computes, and it belongs there rather than in a blanket hedge.

## The holes, in the order they will bite you

**Squash merges — the failure that would discredit this fastest**, because the reader knows
their own merge settings. Some repositories squash every PR to its title, so a record dimension
computed from commit messages measures the merge button rather than any author. The tool samples
the most recent 200 commits and measures the share carrying a body beyond the subject: below
10% the dimension is marked **unavailable** and contributes to no flag; below 25% it is shown as
**weak evidence**. Those thresholds come from the study, which rejected three repositories on
exactly this test.

**Generated, vendored and lockfile paths.** Excluded, using the study's patterns rather than a
reimplementation, so the two artifacts cannot disagree about what counts as machine-maintained.

**Migrations and fixtures.** High churn, low meaning. Marked and demoted below the top ten
rather than deleted — a migrations directory no active contributor has touched is still worth
knowing about, it just should not win on churn alone.

**Initial imports and vendor drops.** One commit touching 40,000 files would dominate every
metric forever and make its author look like the owner of everything. Commits above 300 files
are excluded from churn and authorship, and counted in the output.

**Renames.** Handled by working at directory level. `git log --follow` handles one path at a
time and guesses; over ten thousand files the guesses compound into a history that is
confidently wrong.

**Email aliasing.** The same person commits as three addresses. Normalised on the local part and
the display name, transitively. Note the direction of the residual error: over-merging
understates contributor count and therefore *overstates* concentration, which flags a region for
review — a cheap error. Under-merging invents a bus factor and sends a false alarm to a
customer, which is not.

**Bots.** Dependabot, renovate, release and CI accounts are excluded by author pattern. Left in,
churn is fiction.

**Departure inference.** *No commits in 12 months is a proxy, not a fact.* People go on leave,
change teams, work on other repositories, or commit under an identity the merge missed. That is
why activity is a **repo-wide** question — someone who moved from `billing/` to `search/` has
not stopped being available to explain `billing/` — why everything is aggregated to a region,
why nobody is named, and why the output says *inactivity* and never *departure*.

**Monorepos — and, it turns out, every large repository.** A single global depth does not work.
On grafana the choice is between 17 regions at depth 1 and 114 at depth 2; nothing lands in the
20-60 band, and the closest option puts 15,137 commits in one row called `public`. Real trees are
lopsided, so regions are cut at **mixed depth**: start at the top level and repeatedly split the
largest region that has at least two substantial children, stopping when the count is in band
*and* no single region holds more than 15% of the repository. Grafana comes out with
`pkg/services` and `public/app/features` as their own regions while `hack` stays whole.
Overridable with `--depth`.

## Validation

The map is not shipped on plausibility.

```bash
npm run riskmap -- validate clones/repo-a clones/repo-b --months-back 18
```

Rebuilds the map as of a date at least twelve months in the past using **only** commits before
it, then measures what happened in each region afterwards: fix/revert rate, rework rate (a file
re-touched within 30 days), and fix latency. Flagged regions are compared against unflagged ones
as distributions with cluster-bootstrap confidence intervals over regions — resampling commits
would shrink every interval by roughly the square root of the cluster size and manufacture
significance.

The comparison is also stratified by churn, because churn is the obvious confound: the map flags
partly on churn, and a busier region has more opportunities to contain a fix commit.

**A null result is the point of running it.** If flagged regions do not show worse outcomes, the
map does not predict anything measurable in git, and that is worth knowing before it is attached
to ten cold emails. The report prints a null as plainly as it prints a hit.

### What the real runs showed: the map's predictive claim is NOT supported

Four repositories — grafana, airflow, supabase, langchain — rebuilt as of 18 months back, 194
regions with post-cutoff activity, 8 of them flagged.

| outcome | flagged | not flagged | difference (flagged − not) | 95% CI |
| --- | --- | --- | --- | --- |
| fix / revert rate (median) | 0.000 | 0.000 | **−0.007** | [−0.014, −0.001] |
| rework rate (median) | 0.321 | 0.616 | −0.167 | [−0.444, 0.103] |

**The fix-rate interval excludes zero in the WRONG direction: flagged regions did *better*.**
Rework crosses zero. Inside the above-median-churn stratum — the only one with a non-empty
flagged arm — both point the same wrong way (−0.006 and −0.275). This is evidence against the
flagging rule, and the report says so in those words rather than reporting "a difference".

Two structural findings sit behind the numbers and matter more than the numbers do:

**An activity floor preferentially deletes the treatment arm.** The first harness required 5
post-cutoff commits before a region counted. That removed every flagged region on grafana and
reported a difference of exactly zero with a zero-width interval — a null that was an artifact of
the filter. Dormancy is what the map flags, so any floor selects against exactly the regions
under test. The floor is now 1, and regions with no post-cutoff activity are counted and reported
(20 flagged, 67 not).

**The corpus does not test the orphan claim.** Of the 8 live flagged regions, only 3 have
orphaned share ≥ 0.5, and those have 1–4 post-cutoff commits. Every flagged region with real
volume is *concentration*-driven, with orphaned share 0.05–0.10. So these runs test
"concentrated + hot", not "the people who understood this are gone". `--months-back 30` makes it
worse, not better: 30 months back the repos were younger and nearly everyone was still active.

The one thing that replicates is dormancy, not defects: 71% of flagged regions received zero
commits in the following year against 26% of unflagged ones. That is close to a tautology — the
map flags regions whose contributors stopped, and they then get no commits — and it is not the
claim the outreach would want.

**Verdict: unsupported, and the orphan-specific claim is still untestable on this corpus.**
Testing it needs repositories where orphan-flagged regions stay live. That is a corpus problem,
not a code problem, and it is unfinished.

What it cannot establish, whatever the result: flagging is not random assignment, so this is an
association and not an effect. Outcomes come from commit messages, which is the same channel the
record dimension measures — a team that never writes "revert" looks healthy by construction. And
public repositories are not private codebases.

## Information separation

Record coverage has one result worth defending and two ways to void it: letting the commit
message reach the question generator, or letting the diff reach the scorer. Both are asserted,
and a tripped guard **aborts the run** rather than warning — a run that continued past a leak
would produce numbers indistinguishable from clean ones.

The containment check is on distinctive 8-word runs rather than on any overlap, because a
commit that adds the prose it describes shares text with its own diff legitimately. The study
made exactly that mistake once; this is its correction, inherited.

## Pipeline

| Step | Module | Needs a model |
| --- | --- | --- |
| 1 extraction | `gitlog.ts` | no |
| 2 exclusions, bots, aliasing, size cap | `identity.ts`, `filters.ts` | no |
| 3 region rollup | `regions.ts` | no |
| 4 dimensions | `dimensions.ts` | no |
| 5 squash detection | `squash.ts` | no |
| 6 record coverage | `coverage.ts` | **yes** |
| 7 calibration and ranking | `calibration.ts`, `dimensions.ts` | no |
| 8 HTML | `render.ts` | no |
| 9 retrospective validation | `validate.ts` | no |

Steps 1-5, 7 and 8 run on a clone and nothing else. That is the default path, and it is
deliberate: the artifact has to be worth sending before anyone spends a model call on it.

## Isolation

`riskmap/` is self-contained and one-directional. Nothing in the product references it, and it
references nothing outside itself. The four modules it reuses from the study are vendored
verbatim with a drift check that **fails** on any difference — see `src/vendor/PROVENANCE.md` —
and the calibration distribution is derived from the study's published per-PR scores with the
source commit recorded, rebuildable with `npm run riskmap -- calibrate`.

```bash
git subtree split -P riskmap -b riskmap-standalone   # lifts cleanly into its own repo
```

That property is what makes the offer in the outreach honest: you can hand a customer the
script and let them run it on a private repository themselves, without handing over the study
or asking for any access.
