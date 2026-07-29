# Vendored from the product

These are **byte-identical copies** of files owned by the parent `reckon-review` project.
They live here so `study/` is self-contained and can be lifted into its own repository
without carrying the product with it.

| File | Copied from | Why the study needs it |
| --- | --- | --- |
| `diff-digest.ts` | `src/diff-digest.ts` | Stages 2 and 3 must compress large diffs exactly the way production does, or questions for a big PR get generated from its opening files and systematically miss the tail. |
| `../../vendor/reckon-core-0.5.0.tgz` | `vendor/reckon-core-0.5.0.tgz` | Stage 2 calls the production `decompose()` unmodified. |

## Why copies rather than relative imports

The study's central methodological claim is that it measures the world **with the instrument
Reckon already ships** — not with a bespoke research prompt that nothing else uses. That claim
depends on these files matching production.

Reaching across the repo with `../../src/...` guarantees the match but welds the study to the
product's directory layout. Copying makes the study portable but invites silent drift: the
product's digest changes, the study keeps measuring the old one, and the "same instrument"
claim quietly becomes false with nothing to signal it.

So the copies are verbatim and `vendor.test.ts` enforces it. Inside the monorepo the test
compares each copy against its original and **fails loudly** on any difference. Outside it —
in an extracted standalone repo where the product source is absent — the test reports the
files as unverifiable and passes, so the pipeline still runs.

Drift is therefore a build failure where it can be detected, and a documented limitation where
it cannot.

## Updating a copy

Re-copy the file, run `npx tsx src/vendor.test.ts` to confirm the hashes match, and say in the
commit which product change prompted it. Do not edit these files in place — an edit here is
indistinguishable from drift, and defeats the check.
