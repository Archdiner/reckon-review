# Reckon Review — architecture

**Status:** current (reflects the deployed system) · **Last updated:** 2026-07-25
**What this is:** the *how* — event flow, subsystems, schema, GitHub App, deploy. Rationale
lives in the README (positioning) and inline code comments. Two companion planning docs:
`CODEBASE-GRAPH.md` (the graph feature) and `RECORD-SURFACE-PLAN.md` (the dashboard).

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

**Open a gate** (`onPullRequestOpened`, and the re-gate branch of `onPullRequestSynchronize`):

```
  fetch files + diff
    → classify(): trivial (docs/lockfiles/tiny) ────────────► SUCCESS check, done
    → POLICY A: all changed files peripheral by path ───────► SUCCESS check, done
       (styles/assets/tests/config; any .ts/.js logic = core → gates)
    → daily cost cap hit ──────────────────────────────────► NEUTRAL check, done
    → structuralContext(): tarball → codebase graph → criticality + who-references-what
    → decompose( diffDigest(diff) + structural context ) → 2-4 clustered decisions
    → POLICY B: any changed file is a hub (fan-in >= 8) → rigor = 'harsh', else 'medium'
    → PENDING check (blocks merge) + elicit comment + persist checkpoint
```

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

  durable record     users + demonstrations tables, keyed by github_id, NOT FK'd to installations
                     → survives uninstall. On a pass, promote the passer + append one demonstration
                     per topic (concept + verdict + note + repo/PR provenance). Best-effort; the
                     gate is unaffected if it fails. Deletion is explicit: deleteUserRecord().

  gate-by-default    onInstallation → ensureReckonRuleset(): a repo ruleset requiring the "Reckon
                     comprehension" check on ~DEFAULT_BRANCH. Uses the Rulesets API (gates the FIRST
                     PR, unlike classic protection). Needs Administration:write; 403 → advisory.

  purge              installation.deleted / repos.removed → cascade-delete the account/repo's
                     checkpoints + attempts (the durable record persists; delete on request).
```

Everything off the merge path (closeout, durable record, graph) is **best-effort**: any failure
is logged and swallowed so it can never block or delay a merge.

---

## 5. Database (Supabase Postgres — `db/schema.sql` is the source of truth)

```
  installations   the org/user that installed          ─┐ cascade on
  repos           active repos (+ parsed config)        ─┤ uninstall /
  checkpoints     one gated PR (decisions, rigor, closeout, status)  ─┤ repo-removal
  attempts        every explanation + its grade         ─┘

  users           cross-surface identity (github_id)    ─┐ DURABLE — not FK'd to
  demonstrations  per-topic demonstrated understanding  ─┤ installations; the personal
  mcp_events      dev-time events from reckon-mcp        ─┘ record outlives uninstall
```

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
Schema changes are applied to Supabase manually (SQL editor); the app degrades gracefully if a
new table isn't applied yet (e.g. the durable-record write is best-effort).

**Deploy gotcha (learned the hard way):** a successful deploy ≠ a healthy boot. Any new runtime
import must be a production dependency (dev deps are omitted in the image). Verify the app is
`Listening` in `flyctl logs`, not just that the deploy step went green.
