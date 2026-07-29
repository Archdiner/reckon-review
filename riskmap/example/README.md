# Example output

Real output from real runs, not mocks. Every file here was produced by a command in this package
against public repositories.

## The current artifacts

| File | What it is |
| --- | --- |
| `record-poster.svg` | **The poster.** Every measurement on one canvas: 1,000 scored pull requests across three arms, the person/agent split, the record-tier census, the subject-line ablation, the body-density gate over 24 repositories, record length against coverage, and grafana's 64 directory areas. Costs no model calls — it reads the published result files. |
| `grafana-record-map.html` | **The record map** for grafana/grafana: 64 directory areas coloured by the share of mechanism questions their commits answer. Self-contained, no scripts, no network requests. |
| `grafana-record-map.svg` | The chart alone, for embedding. |
| `grafana-record-map.json` | The same run as data, carrying the Wilson interval and the scored-commit count behind every cell. |
| `0-hero.svg`, `0-hero-dots.svg`, `0-hero-swarm.svg` | Single-measurement visuals: one mark per scored question, and the per-area distribution as a swarm. |

```bash
git clone --shallow-since="5 years ago" https://github.com/grafana/grafana clones/grafana
npm run riskmap -- recordmap clones/grafana      # the record map. Needs a model key.
npm run riskmap -- poster                        # the poster. Needs nothing.
```

**What the record map found on grafana.** 25.1% of 2,931 mechanism questions are answered
explicitly by the commits that made the changes, over 900 sampled commits. Areas run from 2.0%
(`pkg/apiserver`) to 61.2% (`pkg/operators`). Three of the 64 are greyed rather than coloured
because their interval is too wide to read, and the rule that greyed them is printed on the page.

## Retired: the risk map

| File | What it is |
| --- | --- |
| `grafana-grafana-risk-map.html` | The risk-map artifact, kept as the record of what was built and what it claimed. |
| `grafana-grafana-risk-map.top.json` | Its flagged regions as data. |
| `regression.md` | **The evidence that retired it.** 224 regions across four repositories, with outcomes regressed on the dimensions themselves rather than on the flagging rule. |
| `pooled-validation.md` | The earlier flag-level validation, whose fix-rate interval excluded zero in the *wrong* direction — flagged regions did better. |

**Read `regression.md` before quoting anything from the risk-map files.** Neither ownership
dimension — departed share or concentration — has any association with any measured outcome at
n=224, and two of the point estimates run the wrong way. Because a threshold is a coarsening of a
continuous predictor, that rules out *every* threshold on those dimensions rather than only the one
that was tried. The risk map is not maintained. The record map is. See the banner at the top of
`../README.md`.

What replicated in the flag-level run was dormancy rather than defects: flagged regions received no
commits in the following year far more often than unflagged ones. That is near-tautological — the map
flags regions whose contributors stopped committing, and they then get no commits — and it is not the
claim any outreach would want to make.

One dimension is absent from that refutation rather than cleared by it: **record coverage**, which
needs a model to score and so was n=0 in that run. `regress --coverage` scores it as of the cutoff,
which is the run now being filled in.
