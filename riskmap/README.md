# The git-history risk map

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

Computed over a trailing 60-month window (see below), keyed off HEAD's author date rather than wall clock
so the same clone yields the same map.

| Dimension | What it is |
| --- | --- |
| **Orphaned share** | Share of the region's commits made by contributors with no commit *anywhere in the repository* in 12 months. The headline. |
| **Concentration** | Share from the single largest contributor. With orphaned share, this is the bus-factor cell. |
| **Churn** | Commits and lines per month. A region nobody touches is lower risk than a hot one with the same ownership profile. |
| **Record coverage** | Share of mechanism questions about a change that the commit records actually answer, scored with the production question generator. Opt-in. |
| **Agent density** | Share of commits carrying an agent `Co-authored-by` trailer. Context, not quality. |
| **Last explanation** | The most recent commit whose message says anything beyond its own subject. |

A region is listed when it clears at least **two of the available tests, one of which must be an
ownership test** (orphaned or concentrated). The thresholds are printed in the output, because a
reader who disagrees with them should be able to see what they were — and arguing about where
the line sits is a conversation about their codebase, which is the conversation this exists to
start.

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

**A 24-month window cannot see the thing being measured.** Orphaning is multi-year: a two-year
window can only ever contain two years of contributors, nearly all still active. Measured both
ways on grafana — at 24 months the maximum orphaned share across 44 regions is **0.14** and the
median 0.035, so nothing can flag; at 84 months the maximum is **0.88**. The default is now 60
months.

## Calibration, and a correction to the spec

Raw coverage numbers are meaningless to a reader; nobody has an intuition for whether 0.34 is
good. So coverage is reported as a position against the study's corpus: 1,000 merged pull
requests from Grafana, Airflow, Supabase, LangChain and Prisma, scored with the same generator
and the same rubric.

**The build spec asked for the line "this region sits in the bottom decile". That sentence
cannot be said honestly against this corpus.** 55.7% of the 1,000 PRs score exactly zero, so
deciles 1 through 5 are all 0.0 and there is no bottom decile to sit in. This is the same
bimodality the study insists on when it refuses to lead with means.

So the tool reports **midrank percentiles** and says *"lower than or tied with N% of 1,000
merged pull requests"*, naming the size of the tie. It never says "decile" for a value inside
the zero mass.

One consequence is stated rather than hidden: a zero-coverage region's midrank percentile is
27.85, so the `undocumented` threshold sits at 30 rather than a round 25 — below 27.85 the test
could never fire on a region whose commits explained nothing at all.

**Regions of different sizes are compared without normalising**, and that is licensed by
measurement rather than assumed: the study found record coverage flat across a tenfold range of
change size — under 3 points of movement, against 25-26 points for a measure that does respond
to size.

**One mismatch worth knowing.** The corpus scores pull-request records (description plus commit
messages); this tool scores commit messages only, because a clone is its whole dependency and
descriptions are not in it. A commit-only record is a *subset*, so these percentiles are biased
**low**. A region that looks fine is fine a fortiori; a region that looks bad may partly be the
missing channel.

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

### What the first real run showed, and why it is not a hit

On grafana at T = 18 months back, **all four flagged regions received zero commits in the
following twelve months.** The comparison has an empty arm, and the report says "not computed"
rather than showing a difference of zero.

That is close to mechanical rather than predictive, and the harness says so in its own output:
the map flags a region for having contributors who stopped committing, and such a region then
receiving no commits is nearly the same statement twice. It is weak evidence that the ownership
signal finds genuinely dormant code. It is **not** evidence that flagged regions go worse when
someone does touch them — which is the claim the outreach would want, and this run does not
support it.

It also exposed a design flaw worth naming: the first version required 5 post-T commits before a
region counted, which deleted every flagged region and reported a difference of exactly zero with
a zero-width interval — a null that was an artifact of the filter. **Any activity floor
preferentially deletes the treatment arm**, because dormancy is what the map flags. The floor is
now 1, and regions with no post-T activity are counted and reported rather than dropped.

Testing the real claim needs repositories where flagged regions are still being modified. That is
a corpus problem, not a code problem, and it is unfinished.

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
