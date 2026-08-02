# Reckon Review — architecture

**Status:** current (reflects the deployed system) · **Last updated:** 2026-08-02
**What this is:** the *how* — event flow, subsystems, schema, GitHub App, deploy. Rationale
lives in the README (positioning) and inline code comments. Companion docs:
`CODEBASE-GRAPH.md` (the graph feature), `KNOWLEDGE-MAP.md` (the two-axis taxonomy, freshness
and the report), and `RECORD-SURFACE-PLAN.md` (the eventual hosted dashboard).

---

## 1. System shape

```
   GitHub ──webhooks──►  Reckon Review (Probot/Node on Fly)  ──►  @reckon/core  ──►  OpenAI
     ▲                        │        │                              (decompose + grade)
     │                        │        └── repo tarball @ PR head (in-memory, for the graph)
     └── checks / comments ───┘        │
          (installation token)         ▼
                                  Supabase (Postgres) — durable state
```

One always-on Node service (Probot). Webhooks in; check runs + PR comments out; `@reckon/core`
does decompose + grade against OpenAI; Supabase holds state. The webhook is ACK'd immediately
and work runs in the **background** (decompose/grade/graph take seconds; holding the connection
would trip GitHub's ~10s timeout). A background failure is logged, not retried — a re-push
re-triggers.

---

## 2. Events → handlers (`src/app.ts` → `src/handlers.ts`)

```
  pull_request.opened / ready_for_review     → onPullRequestOpened   → open a gate
  pull_request.synchronize                   → onPullRequestSynchronize → re-gate / carry forward
  issue_comment.created                      → onIssueComment        → grade a reply
  installation.created                       → onInstallation        → auto-configure gating ruleset
  installation_repositories.added            → onInstallation        → (same, per added repo)
  installation.deleted                       → onInstallationDeleted  → purge the account's data
  installation_repositories.removed          → onInstallationReposRemoved → purge those repos
```

---

## 3. The gate pipeline

**Open a gate** — ONE path (`runGate`) shared by `opened` and `synchronize`. These were two
~90% identical copies; every change had to be made twice, and any miss meant a re-push silently
behaved differently from a first open.

```
  same head as the last recorded outcome? ───────────────► duplicate delivery, bail
  fetch files + diff → derive areas (the subsystem spine)
    → classify(): trivial (docs/lockfiles/tiny) ────────────► SUCCESS check + 'trivial' row
    → POLICY A: all changed files peripheral by path ───────► SUCCESS check + 'peripheral' row
       (styles/assets/tests/config; any .ts/.js logic = core → gates)
    → daily cost cap hit ──────────────────────────────────► NEUTRAL check + 'capped' row
    → structuralContext(): tarball → codebase graph → criticality + who-references-what
    → decompose( diffDigest(diff) + structural context ) → 2-4 clustered decisions
    → POLICY B: any changed file is a hub (fan-in >= 8) → rigor = 'harsh', else 'medium'
    → decisions unchanged since a pass? ────────────────────► carry forward onto the new head
    → PENDING check (blocks merge) + elicit comment + persist checkpoint
```

**Every exit writes a row**, including the skips (which cost no model call). A skipped PR used to
leave no trace, which made the most basic usage question unanswerable: of the PRs Reckon saw, how
many did it gate, and why not the rest. The skip rows are also what drives freshness decay, since a
skipped PR still moved the code.

**Grade a reply** (`onIssueComment`): a reviewer (OWNER/MEMBER/COLLABORATOR) reply ≥40 chars →
grade the **cumulative** explanation (all prior replies + this one) against the checkpoint's
decisions →

```
  PASS  → flip check SUCCESS · mark passed · closeout deposit · write durable record
  FAIL  → rescue comment naming the single hole · check stays PENDING (loop)
  UNGRADED (grader outage) → NEUTRAL check (never silently unblock)
```

**Synchronize carry-forward:** re-decompose on a new push; if `decisions_hash` is unchanged
since a passing explanation, carry the pass onto the new head (don't re-quiz a typo fix).
Changed decisions → re-gate. Closes the "pass then push slop" hole.

---

## 4. Subsystems

```
  diff-digest        src/diff-digest.ts — large PRs: spend the decompose token budget across
  (large-PR)         EVERY file (path + sampled hunks) instead of head-truncating to 8000 chars,
                     so topics span the whole PR. Falls back to a file-list; discloses overflow.

  codebase graph     src/graph/* — ephemeral, per-PR. fetch.ts pulls the repo tarball at head
  (criticality +     (in memory, bounded, never stored); extractor.ts (TS-compiler backend, TS/JS
   interactions)     only — swappable interface, tree-sitter/SCIP are later backends); repo-map.ts
                     builds a name-based def/ref graph, personalized PageRank, criticality tiers
                     (core/peripheral/trivial via path + fan-in), blast-radius neighborhood, and a
                     budget-packed structural context. context.ts is the best-effort, timeout-
                     guarded entry point. eval.ts is the objective harness (precision/recall/
                     coverage/efficiency). Advisory: name-based edges are a lower bound.
                     area-graph.ts rolls the SAME graph up from files to subsystems and that
                     rollup IS persisted (checkpoints.area_graph): the architecture diagram the
                     knowledge map is drawn on. The file-level graph and the source stay
                     ephemeral; only the tens-of-nodes summary survives.

  durable record     users + demonstrations tables, keyed by github_id, NOT FK'd to installations
                     → survives uninstall. On a pass, promote the passer + append one demonstration
                     per topic (concept + verdict + note + repo/PR provenance). Best-effort; the
                     gate is unaffected if it fails. Deletion is explicit: deleteUserRecord().

  gate-by-default    onInstallation → ensureReckonRuleset(): a repo ruleset requiring the "Reckon
                     comprehension" check on ~DEFAULT_BRANCH. Uses the Rulesets API (gates the FIRST
                     PR, unlike classic protection). Needs Administration:write; 403 → advisory.

  purge              installation.deleted / repos.removed → cascade-delete the account/repo's
                     checkpoints + attempts (the durable record persists; delete on request).

  knowledge map      src/knowledge/* — the two axes a demonstration is tagged on at write time.
  (areas/domains/    areas.ts: WHERE, a repo subsystem derived deterministically from changed
   freshness)        paths (renamed per-repo at read time). domains.ts: WHAT KIND, a closed
                     16-term vocabulary tagged by the closeout call. freshness.ts: decay by age
                     AND by drift (substantive changes landed in that area since). See
                     KNOWLEDGE-MAP.md.

  report             src/report/* — offline, read-only. Pulls the whole database and renders one
  (visualization)    self-contained HTML file: collection health, usage funnel, the ARCHITECTURE
                     DIAGRAM (from the persisted area graph, coloured by comprehension), the area
                     map, a person x area matrix, domain profiles. layout.ts is a deterministic
                     force layout (no Math.random, so the same codebase draws the same);
                     links.ts turns stored provenance into GitHub URLs so every score, every
                     demonstration and every finding opens the PR behind it. `npm run report`,
                     or `npm run report:demo`. Never writes.
```

Everything off the merge path (closeout, durable record, graph) is **best-effort**: any failure
is logged and swallowed so it can never block or delay a merge.

---

## 5. Database (Supabase Postgres — `db/schema.sql` is the source of truth)

```
  installations   the org/user that installed          ─┐ cascade on
  repos           active repos (+ parsed config)        ─┤ uninstall /
  checkpoints     EVERY PR outcome: decisions, rigor, closeout, status  ─┤ repo-removal
                  (pending|passed|trivial|peripheral|capped|error) +   ─┤
                  files, areas, hub/core counts, graph timing, author, ─┤
                  area_graph (the subsystem rollup: the diagram)        ─┤
  attempts        every explanation + its grade         ─┘

  users           cross-surface identity (github_id)    ─┐ DURABLE — not FK'd to
  demonstrations  per-topic understanding + area/domains─┤ installations; the personal
  mcp_events      dev-time events from reckon-mcp        ─┘ record outlives uninstall
```

Two retention tiers, and which table a person's identity lands in follows from them. `users` holds
people who ACTUALLY ENGAGED (replied to a gate with an explanation, pass or fail), and is durable.
A PR author whose diff was merely scanned did not choose to interact, so their login stays on
`checkpoints.author_login`, with the install-scoped data that purges on uninstall.

Join key across surfaces: the **github numeric id** (`attempts.reviewer_id`,
`checkpoints.passed_by_id`, `users.github_id`, `demonstrations.github_id`, `mcp_events.github_id`).

---

## 6. GitHub App

```
  Repository permissions              Subscribed events
  ──────────────────────────────      ────────────────────────────────
  Pull requests   Read & write        pull_request (opened, reopened,
  Issues          Read & write          ready_for_review, synchronize)
  Checks          Read & write        issue_comment (created)
  Administration  Read & write  ←new  installation (created, deleted)
  Contents        Read                installation_repositories (added, removed)
  Metadata        Read
```

Auth (Probot handles it): app JWT (RS256, from PRIVATE_KEY) → per-installation token (1h) →
act. Inbound webhooks verified via HMAC-SHA256 against WEBHOOK_SECRET.

Note: `Administration: write` + the Installation event are the toggle that makes gating on by
default; until an install re-consents, `ensureReckonRuleset` 403s and Reckon stays advisory.

---

## 7. Stack & layout

```
  runtime   Node + TypeScript (typescript is a RUNTIME dep — the graph extractor uses it)
  fwk       Probot · grader: openai SDK · store: @supabase/supabase-js · untar: tar-stream
  core      @reckon/core (vendored tgz) — decompose + gradePlan
  deploy    Docker → Fly (fly.toml, app "reckon-pr"); GitHub Actions deploys on push to main

  src/
    app.ts                 Probot entry; wires events → handlers
    handlers.ts            all webhook handlers + the gate pipeline
    config.ts              env config
    github.ts              octokit wrappers (checks, comments, diff, ruleset)
    diff-digest.ts         large-PR digest
    format.ts              PR comment copy (elicit / rescue / pass), no em dashes
    closeout.ts            the pass "deposit" (per-topic read)
    util.ts                classify() + helpers
    graph/                 extractor · repo-map · fetch · context · eval
    knowledge/             areas · domains · freshness (the map's taxonomy + decay)
    report/                query · model · render · cli · demo (the offline HTML report)
    grader/openai.ts       OpenAI backend for @reckon/core
    store/supabase.ts      all persistence
    handler-test.ts        live integration test (real Supabase + OpenAI)
```

---

## 8. Env & deploy

```
  SUPABASE_URL, SUPABASE_SECRET_KEY   Supabase (service_role — bypasses RLS; trusted server)
  OPENAI_API_KEY, RECKON_GRADER_MODEL grader (default gpt-5.4-mini)
  APP_ID, PRIVATE_KEY_PATH, WEBHOOK_SECRET   GitHub App identity + webhook verify
  RECKON_DAILY_PER_INSTALL, RECKON_DAILY_GLOBAL   beta cost caps (new gates / 24h)
```

Deploy: push to `main` → GitHub Actions (`.github/workflows/fly-deploy.yml`) → `flyctl deploy`.
Schema changes are applied to Supabase manually (SQL editor). Each one ships as an idempotent
delta under `db/migrations/` (paste and run; safe to re-run), with `db/schema.sql` remaining the
source of truth for the full shape. The app degrades gracefully if a new table isn't applied yet (e.g. the durable-record write is best-effort). Writes that use a
late-added COLUMN retry without it and log, so a deploy landing before its migration degrades to
the old column set rather than failing on the merge path. `npm run report` names any column that
is still missing, which is the only way that silent fallback is visible.

**Deploy gotcha (learned the hard way):** a successful deploy ≠ a healthy boot. Any new runtime
import must be a production dependency (dev deps are omitted in the image). Verify the app is
`Listening` in `flyctl logs`, not just that the deploy step went green.
