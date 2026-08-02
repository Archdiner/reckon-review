# The knowledge map

**Status:** built (collection + report shipped; no hosted surface yet) · **Last updated:** 2026-08-02
**What this is:** how a pile of per-PR demonstrations becomes a map of who understands what, which
parts of a codebase are demonstrably explained, and how stale that is. Companion docs:
`ARCHITECTURE.md` (the gate), `RECORD-SURFACE-PLAN.md` (the eventual hosted dashboard).

---

## 1. The problem with the raw data

`demonstrations.concept` is free text, minted per PR by `decompose`. Two people who explained the
same subsystem six weeks apart produce two unrelated slugs. Grouping by concept therefore yields a
list of one-offs, never a map, and no amount of UI fixes that. Worse, a demonstration is a fact
about a moment: counting them straight shows a team fluent in subsystems that have since been
rewritten by someone else.

So the map needs three things the raw data did not have: a stable spine to group onto, a portable
category to compare across repos, and a decay model.

---

## 2. Two axes

A demonstration is tagged on both, at write time, because neither input survives to read time (the
changed paths live on a checkpoint that cascade-purges on uninstall; the explanation is never
stored at all). A durable record has to carry its own categorization.

```
  AXIS 1 — AREA (where)                    src/knowledge/areas.ts
    one repo's subsystem, at the level of a box in an architecture diagram, not a file.
    derived deterministically from changed paths (no model call, so it can be recorded on
    every event including skips). renamed per-repo at READ time via .reckon.yml:
      areas: { graph: "Codebase graph", handlers: "Gate pipeline" }
    renaming a box is a config edit, never a backfill.
    → answers "which parts of THIS codebase does the team understand". a team question.

  AXIS 2 — DOMAIN (what kind)              src/knowledge/domains.ts
    a portable category of engineering understanding: concurrency-and-async, data-modeling,
    security, caching, ... a CLOSED vocabulary of 16. lossy on purpose: free text never
    aggregates, and lossy is what makes it groupable.
    tagged by the closeout model (already reading the explanation, so zero extra calls),
    falling back to a keyword classifier. neither may invent a tag: anything off the enum is
    dropped, and no match yields NO tag rather than a wrong one.
    → answers "what kinds of understanding does this PERSON carry, anywhere". portable, and
      the part of the record that still means something after they change jobs.
```

One demonstration lands on exactly one area (the dominant subsystem of the change, by changed-file
count). Explaining a change that happened to touch six directories is not evidence of understanding
all six.

---

## 3. Freshness: decay by drift, not by timer

```
  freshness = ageDecay x driftDecay
    ageDecay   = 0.5 ^ (daysSince / 120)
    driftDecay = 0.5 ^ (substantiveChangesInThatAreaSince / 6)
```

The second factor is the real idea. A wall-clock expiry is wrong in both directions: it ages out a
correct explanation of a file nobody has touched since, and it keeps full credit for an area that
was rewritten twice last Tuesday. **Understanding decays because the code moved**, and every one of
those moves is a webhook we already receive, so drift costs nothing to measure.

This is why checkpoints record their `areas` even when the gate is skipped: a skipped PR still moves
the code. Trivial and peripheral skips are excluded from the drift count (they touched nothing
load-bearing by definition), or every README typo would erode the map.

```
  strength   strong 1.0 | solid 0.7 | thin 0.4 | unverdicted 0.55
  confidence = strength x freshness
  person's confidence in an area = MAX over their demonstrations there
```

Max, not mean or sum: mean punishes someone for having also explained a thin corner of the same
area, and sum lets ten shallow passes outrank one deep one. The question is "is there a live, strong
demonstration to lean on", which is a max.

```
  AREA STATUS (drives the whole map, worst first)
    unexplained    changed here, never explained by anyone            ← the real gap
    stale          explained before, but time passed or code moved
    single-point   exactly one person currently holds it              ← bus factor 1
    covered        two or more people currently hold it
```

"Currently holds it" means confidence >= 0.5, the freshness floor.

---

## 4. Seeing it

```
  npm run report              → reckon-report.html   (reads SUPABASE_URL / SUPABASE_SECRET_KEY)
  npm run report -- --json    → also dumps the model as JSON
  npm run report:demo         → renders a synthetic snapshot, no database needed
```

One self-contained HTML file: inline CSS, no CDN, no chart library, opens from a `file://` path.
Read-only against the database, so it is safe to point at production. Exits non-zero on a critical
finding, so it can be wired into a scheduled job later.

```
  src/report/
    query.ts    read layer. pages past supabase-js's 1000-row cap (a naive select truncates
                silently and every number downstream is quietly wrong). tolerates unmigrated
                columns and unreadable tables; both become findings rather than crashes.
    model.ts    pure aggregation: funnel, knowledge map, domain profiles, health findings.
    render.ts   the HTML. sequential single-hue blue for magnitude, a reserved status palette
                for state, every status is icon + label + colour, every chart has a table view.
    demo.ts     synthetic fixture: every area status, a drift-decayed demonstration, findings
                firing. how the layout gets reviewed before there is real data to fill it.
```

Sections: **collection health**, what is in the database, **usage funnel** (PRs seen → gated →
answered → passed, with skip reasons), **the area map**, **who understands what** (person x area),
**domains per person**.

---

## 5. Collection health, and why it is derived

Background handler failures are logged to the process and nowhere else, and everything off the merge
path is deliberately best-effort and swallowed. So a dropped write leaves no error row anywhere. The
only way to find one after the fact is to look for its **shadow** in the data that did land:

```
  a gate flipped to passed with no attempt row      → the explanation was graded, then lost
  an attempt graded PASS on a gate never passed     → the pass path threw partway (a wedged gate)
  a passed gate with no demonstrations              → the durable-record write was dropped
  a demonstration whose github_id has no user row   → upsertUser failed, the join has no anchor
  a substantive checkpoint with no areas            → written before area tagging, invisible on the map
  every checkpoint is a gate, none are skips        → skipped PRs are not being recorded
  an installation with no repos                     → the install webhook did not persist its list
  a gate open a week with no reply                  → not a data bug: the gate is being routed around
```

Each finding carries a fix, because a finding with no fix is a complaint rather than a diagnosis.

---

## 6. What the map still cannot answer

- **Cross-repo areas.** An area key is scoped to one repo. `graph` in two repos are two areas, which
  is correct, but there is no notion yet of "the same subsystem across a fork".
- **Reading is not understanding.** The map only knows what someone was made to explain at a gate.
  Someone who has read a subsystem carefully and never touched it in a PR is invisible on it.
- **Backfill is partly impossible.** `area` derives from changed paths, so any checkpoint that
  recorded its files can be recomputed. `domains` derives from the explanation, which is never
  stored, so pre-existing demonstrations can only be keyword-classified from concept and summary.
- **The dev-time half is empty** unless the reckon-mcp host is deployed and forwarding. Nothing in
  this repo writes `mcp_events`; the report says so rather than showing a silent zero.
