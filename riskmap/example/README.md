# Example output

Real output from a real run, not a mock. Regenerate with:

```bash
git clone --shallow-since="5 years ago" https://github.com/grafana/grafana clones/grafana
npm run riskmap -- map clones/grafana
npm run riskmap -- validate clones/grafana clones/airflow clones/supabase clones/langchain --months-back 18
```

| File | What it is |
| --- | --- |
| `grafana-grafana-risk-map.html` | The artifact. Open it in a browser; it is self-contained, has no scripts and makes no network requests. |
| `grafana-grafana-risk-map.top.json` | The flagged regions as data. The full run also writes every region; only the top is kept here because the rest is regenerable. |
| `pooled-validation.md` | The retrospective validation across four repositories. Read it before quoting anything else here. |

## What this run found

Two regions out of 68 cleared the thresholds: `pkg/framework` (85% of commits from contributors
now inactive, 80% from one of them, four contributors total) and `pkg/coremodel` (67% and 63%).
Both are genuinely superseded Grafana subsystems, which is the outcome a maintainer would
recognise — and the reason it is worth showing an example on a repository nobody involved here
controls.

**And read `pooled-validation.md` before quoting any of it.** Across four repositories and 194
regions with post-cutoff activity, the fix-rate difference is −0.007 with a 95% CI of
[−0.014, −0.001] — excluding zero in the *wrong* direction, meaning flagged regions did better
than unflagged ones. Rework crosses zero. **The map's predictive claim is not supported by this
evidence**, and the report says so in those words.

What does replicate is dormancy rather than defects: 71% of flagged regions received no commits
in the following year against 26% of unflagged ones. That is near-tautological — the map flags
regions whose contributors stopped committing, and they then get no commits.

The orphan claim specifically remains untested: every flagged region with real post-cutoff volume
is concentration-driven, with orphaned share 0.05–0.10. This corpus tests "concentrated + hot",
not "the people who understood this are gone".
