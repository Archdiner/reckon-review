# Example output

Real output from a real run, not a mock. Regenerate with:

```bash
git clone --shallow-since="5 years ago" https://github.com/grafana/grafana clones/grafana
npm run riskmap -- map clones/grafana
npm run riskmap -- validate clones/grafana --months-back 18
```

| File | What it is |
| --- | --- |
| `grafana-grafana-risk-map.html` | The artifact. Open it in a browser; it is self-contained, has no scripts and makes no network requests. |
| `grafana-grafana-risk-map.top.json` | The flagged regions as data. The full run also writes every region; only the top is kept here because the rest is regenerable. |
| `grafana-validation.md` | The retrospective validation, reporting an empty comparison. |

## What this run found

Two regions out of 68 cleared the thresholds: `pkg/framework` (85% of commits from contributors
now inactive, 80% from one of them, four contributors total) and `pkg/coremodel` (67% and 63%).
Both are genuinely superseded Grafana subsystems, which is the outcome a maintainer would
recognise — and the reason it is worth showing an example on a repository nobody involved here
controls.

**And read `grafana-validation.md` before quoting any of it.** All four regions flagged at
T = 18 months back received zero commits in the following year, so the retrospective comparison
has an empty arm and reports "not computed". That result is close to mechanical: a region flagged
for having contributors who stopped committing then receiving no commits is nearly the same
statement made twice. It is weak evidence that the ownership signal finds dormant code, and it is
not evidence that flagged regions go worse when someone touches them.
