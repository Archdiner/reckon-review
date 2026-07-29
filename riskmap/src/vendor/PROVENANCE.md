# Vendored files

Verbatim copies. `npm test` compares each against its original byte-for-byte and **fails** on
any difference, so these cannot drift into a private fork that silently disagrees with the
thing it claims to reuse.

In an extracted standalone checkout the originals are absent and the check reports them
unverifiable rather than failing — the same convention `study/src/vendor` uses.

| File | Original | Why it is here |
| --- | --- | --- |
| `exclusions.ts` | `study/src/exclusions.ts` | The generated/vendored/lockfile path patterns. The build spec says "you have the patterns from the study"; reimplementing them would let the map and the study disagree about what counts as machine-maintained code, and the first person to notice would be a customer. |
| `triviality.ts` | `study/src/triviality.ts` | `classifyRecord()`, which decides whether a commit message says anything beyond its subject. Drives "last substantive explanation" and squash-convention detection. |
| `backends.ts` | `study/src/backends.ts` | The `LlmBackend` implementations, so record coverage is scored by the same models through the same port as the study it is calibrated against. |
| `../../vendor/reckon-core-0.5.0.tgz` | `study/vendor/reckon-core-0.5.0.tgz` | Production `decompose()` and `diffDigest`. Record coverage must be produced by the instrument the product ships, or the percentile against the study corpus is comparing two different measurements. |

## Why copies rather than an import

`riskmap/` is sent to people. The build spec's fourteenth section rules out anything that
"requires installing anything to produce the first output", and section 14 offers the customer
the script so they can run it on a private repo themselves. A relative import into `study/`
would mean handing over the study to hand over the tool.

```bash
git subtree split -P riskmap -b riskmap-standalone   # lifts cleanly into its own repo
```

## What is NOT vendored

The calibration distribution. `calibration/study-coverage.json` is *derived* from
`study/results/per-pr-scores.csv` rather than copied, and it records the source commit and row
count so a reader can rebuild it. See `src/calibration.ts`.
