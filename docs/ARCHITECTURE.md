# Reckon Review — architecture & build spec (v1)

**Status:** build spec, 2026-07-18
**Reads with:** `DESIGN.md` (rationale). This file is the *how* — DB, event flow, GitHub
App setup, stack, config, deploy.

**v1 scope (locked):** a hosted GitHub App that gates PR merges on a human comprehension
pass. Comment-thread elicit → OpenAI grade → required check blocks merge until pass. Any
one reviewer's pass satisfies the gate. **No cold recall in v1** (passes are recorded so it
can be added later without a migration).

```
  IN v1                              OUT of v1 (deferred)
  ───────────────────────────────────────────────────────
  webhook app + Postgres            cold-recall cron / issues
  decompose + OpenAI grader         per-approver reconciliation
  required check that blocks merge   marketplace billing
  comment-thread rescue loop         BYO-key (startup credits cover it)
  classify() trivial auto-pass       multi-rigor per path (single rigor v1)
```

---

## 1. System shape

```
   GitHub ──webhooks──►  Reckon Review app  ──►  @reckon/core  ──►  OpenAI (grader)
     ▲                    (Probot/Node)          │
     │                         │                 ▼
     └──── Checks / Comments ──┘             Postgres (state)
             (installation token)
```

One always-on Node service. Three inbound webhook events, three outbound GitHub API
surfaces (check runs, PR comments, diff fetch), one grader call per attempt, one Postgres
for state. Stateless between requests except the DB.

---

## 2. The core unit — a "checkpoint"

One PR that gets gated = one `checkpoint` row. It moves through a small state machine:

```
                   pull_request.opened / ready_for_review
                              │
                       fetch diff
                              │
                    ┌─────────┴──────────┐
              classify()=trivial     non-trivial
                    │                     │
                    ▼                     ▼
             check = SUCCESS         decompose() → 2-4 decisions
             status=TRIVIAL          create check = PENDING (blocks merge)
             (merge allowed)         post elicit comment
                                     status=PENDING
                                          │
                              issue_comment.created (a reviewer replies)
                                          │
                                   core.submit → grade
                                    ┌─────┴─────┐
                                  FAIL         PASS
                                    │           │
                          rescue comment    check = SUCCESS
                          check stays        status=PASSED
                          PENDING            passed_by = reviewer
                          (loop)             (merge unblocked)
```

`pull_request.synchronize` (new push): re-fetch diff, re-`decompose`. If the decision set is
**unchanged**, carry the pass forward. If **changed**, reset to PENDING and re-elicit. (This
closes the "pass then push slop" hole without re-quizzing on a typo fix. Flagged decision D3
below.)

---

## 3. Database schema (Postgres)

Five tables. DDL is the source of truth; use Drizzle or plain `pg` + migrations.

```sql
-- GitHub App installations (org or user that installed Reckon)
CREATE TABLE installations (
  id             BIGINT PRIMARY KEY,          -- github installation id
  account_login  TEXT NOT NULL,
  account_type   TEXT NOT NULL,               -- 'Organization' | 'User'
  suspended_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Repos the app is active on
CREATE TABLE repos (
  id               BIGINT PRIMARY KEY,        -- github repo id
  installation_id  BIGINT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  full_name        TEXT NOT NULL,             -- 'org/repo'
  default_branch   TEXT NOT NULL DEFAULT 'main',
  config           JSONB NOT NULL DEFAULT '{}',  -- parsed .reckon.yml
  config_synced_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX repos_installation_idx ON repos(installation_id);

-- One gated PR = one checkpoint
CREATE TABLE checkpoints (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id        BIGINT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr_number      INTEGER NOT NULL,
  pr_node_id     TEXT NOT NULL,
  head_sha       TEXT NOT NULL,               -- commit the check attaches to
  check_run_id   BIGINT,                      -- github check run id
  decisions      JSONB NOT NULL DEFAULT '[]', -- decompose() output (the sub-problems)
  decisions_hash TEXT NOT NULL,               -- for the synchronize carry-forward test
  rigor          TEXT NOT NULL DEFAULT 'medium',
  status         TEXT NOT NULL DEFAULT 'pending', -- pending|passed|trivial|error
  passed_by      TEXT,                        -- github login who passed (audit)
  passed_by_id   BIGINT,
  passed_at      TIMESTAMPTZ,
  next_recall_due TIMESTAMPTZ,                -- reserved for future recall; always NULL in v1
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX checkpoints_pr_head_idx ON checkpoints(repo_id, pr_number, head_sha);

-- Every explanation attempt + its grade (conversation + audit trail)
CREATE TABLE attempts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkpoint_id  UUID NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  reviewer_login TEXT NOT NULL,
  reviewer_id    BIGINT NOT NULL,
  comment_id     BIGINT,                      -- the github comment this reply came from
  explanation    TEXT NOT NULL,
  assisted       BOOLEAN NOT NULL DEFAULT true, -- always true on github (diff on screen)
  grade_pass     BOOLEAN NOT NULL,
  ungraded       BOOLEAN NOT NULL DEFAULT false, -- grader failed open (LOUD)
  scores         JSONB,
  overlap        TEXT,                        -- low|medium|high|unknown
  hole           TEXT,                        -- rescue prompt returned on fail
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX attempts_checkpoint_idx ON attempts(checkpoint_id);
```

Notes:
- `decisions_hash` is what makes D3 (synchronize carry-forward) cheap: hash the decompose
  output; equal hash after a push → keep the pass.
- `next_recall_due` sits unused in v1 — reserved so adding recall later is code-only.
- No `users` table needed: reviewer identity is carried inline for audit; the gate only
  needs "someone passed."

---

## 4. GitHub App setup

**Register** (Settings → Developer settings → GitHub Apps → New, or org-level):

```
  Webhook URL      https://<host>/api/github/webhooks
  Webhook secret   <random; verifies X-Hub-Signature-256>
  Private key      generate → PEM (RS256 signing for app JWT)
```

**Repository permissions:**

```
  Pull requests    Read & write     (read diff metadata; the API surface)
  Issues           Read & write     (PR comments ARE issue comments)
  Checks           Read & write     (create/update the gating check run)
  Administration   Read & write     (create the branch ruleset that REQUIRES the check —
                                     this is what makes gating on-by-default)
  Contents         Read             (fetch diff + .reckon.yml)
  Metadata         Read             (mandatory)
```

**Subscribe to events:**

```
  pull_request           (opened, reopened, ready_for_review, synchronize)
  issue_comment          (created)          ← the reviewer's explanation
  installation           (created, deleted) ← lifecycle → installations table
  installation_repositories                 ← repos added/removed
```

**Auth model** (Probot does all of this; raw uses `@octokit/auth-app`):

```
  1. app authenticates as itself: JWT signed with PRIVATE_KEY (RS256, exp ≤10m)
  2. per installation: JWT → installation access token (1h), scoped to that repo
  3. act (comment / check / fetch) with the installation token
  4. inbound webhooks verified via HMAC-SHA256 against WEBHOOK_SECRET
```

**Branch protection (Reckon sets this by default — this is what actually blocks merge):**

```
  on installation.created / installation_repositories.added →
    onInstallation() → ensureReckonRuleset() creates a branch ruleset:
      target      ~DEFAULT_BRANCH
      enforcement active
      rule        required_status_checks → context "Reckon comprehension"

  Why rulesets, not classic branch protection: a ruleset can require a check by
  CONTEXT NAME before that check has ever reported, so the FIRST PR is gated. Classic
  protection only lets you pick from checks it has already seen (the old chicken-egg).

  Idempotent + best-effort per repo. No `administration: write` (older install, not
  re-consented) → the create 403s, is logged, and Reckon degrades to advisory.
  Off-switch for a consumer: delete the "Reckon comprehension (managed)" ruleset.

  Optionally pair with native GitHub "require ≥1 approving review" — the human-judgment half.
```

Reckon's check = "someone explained and passed." GitHub's required-approval = "someone
approved." Together: the code passed through a human who could explain it. With
1-pass-satisfies, we never reconcile *which* reviewer — any pass flips the check.

---

## 5. Stack & project layout

```
  runtime     Node 20 + TypeScript
  app fwk     Probot (default — wraps Octokit, handles JWT + webhook verify + routing)
              └ alternative: raw express + @octokit/webhooks + @octokit/auth-app  (D1)
  grader      openai SDK  → OpenAiGrader implements @reckon/core's Grader port
  db          Postgres via Drizzle (default) or plain pg + SQL migrations       (D2)
  core        @reckon/core  (workspace package or git dep on reckon-mcp's extraction)
  deploy      Docker container → any always-on host + any Postgres (DATABASE_URL) (D-host)
```

```
  reckon-pr/
    DESIGN.md
    ARCHITECTURE.md          ← this file
    package.json
    tsconfig.json
    Dockerfile
    .env.example
    migrations/              ← SQL (or drizzle/)
    src/
      index.ts               ← Probot entry; wires handlers
      config.ts              ← env + .reckon.yml load/parse/cache
      db/
        schema.ts            ← Drizzle schema (mirrors §3)
        client.ts            ← pool
        checkpoints.ts       ← queries: create/find/pass/carryForward
        attempts.ts          ← record()
      github/
        diff.ts              ← fetch + normalize PR diff (Contents/compare)
        check.ts             ← createCheck / setPending / setSuccess
        comment.ts           ← postElicit / reply / passNote
      handlers/
        pullRequest.ts       ← opened|ready|synchronize → decompose|carryForward
        issueComment.ts      ← reviewer reply → core.submit → grade → check
        installation.ts      ← lifecycle → installations/repos rows
      grader/
        openai.ts            ← OpenAiGrader (Chat Completions, JSON mode)
      core/                  ← @reckon/core (or node_modules dep)
```

---

## 6. The two hot paths (pseudocode)

**On PR opened / ready:**

```ts
async function onPullRequest(ctx) {
  const repo = await db.repos.upsertFromCtx(ctx);
  if (ctx.pr.draft) return;                          // wait for ready_for_review
  const cfg = await config.forRepo(repo);            // .reckon.yml
  if (!cfg.gates(ctx.pr.files)) return;              // path filters

  const diff = await github.diff.fetch(ctx);
  if (cfg.trivialAutopass && core.classify(diff).trivial) {
    return github.check.setSuccess(ctx, "trivial — no comprehension needed");
  }

  const decisions = await core.decompose(diff);      // 2-4 sub-problems
  const check = await github.check.setPending(ctx, "explain to merge");
  await github.comment.postElicit(ctx, core.planElicitPrompt(decisions));
  await db.checkpoints.create({ ...ctx, decisions, check, hash: hashOf(decisions), rigor: cfg.rigor });
}
```

**On reviewer comment (the grade):**

```ts
async function onIssueComment(ctx) {
  if (ctx.isBot || !ctx.isPullRequest) return;
  const cp = await db.checkpoints.findPending(ctx.repoId, ctx.prNumber);
  if (!cp) return;                                   // no open gate → ignore chatter
  if (!ctx.author.canReview) return;                 // must have review rights

  const g = await core.grade({                       // OpenAiGrader under the hood
    groundTruth: cp.decisions, explanation: ctx.body, rigor: cp.rigor, assisted: true,
  });
  await db.attempts.record({ cp, ctx, g });

  if (!g.pass) {
    return github.comment.reply(ctx, core.retryPrompt(g.hole, true)); // rescue, stays pending
  }
  await db.checkpoints.markPassed(cp, ctx.author);
  await github.check.setSuccess(ctx, `✓ ${ctx.author.login} explained it — merge unblocked`);
  await github.comment.reply(ctx, "✓ passed — comprehension logged.");
}
```

Grader stays reference-guided against `cp.decisions` (the decomposed diff), and the overlap
check folds in any AI-reviewer comments on the PR (CodeRabbit et al.) so a pasted summary
reads as restatement → fail. `ungraded` (grader fail-open) sets the check to *neutral*, not
success — never silently unblock on a grader outage.

---

## 7. `.reckon.yml` (in the consumer repo, default branch)

```yaml
reckon:
  rigor: medium              # medium (floor) | harsh
  trivial_autopass: true     # classify() skips dep-bumps, lockfiles, docs-only
  gate:
    paths:      ["src/**"]    # optional allowlist; omit = all
    skip_paths: ["docs/**", "**/*.md"]
  model: gpt-...             # grader model override (else env default)
```

Fetched via Contents API on PR open, cached in `repos.config`, re-synced when the default
branch changes it.

---

## 8. Env / secrets

```
  APP_ID=              # GitHub App id
  PRIVATE_KEY=         # PEM (RS256)
  WEBHOOK_SECRET=      # HMAC verify
  OPENAI_API_KEY=      # startup credits
  RECKON_GRADER_MODEL= # default grader model
  DATABASE_URL=        # any Postgres
  PORT=3000
```

---

## 9. Deploy & first-run

```
  1. build @reckon/core; reckon-pr depends on it
  2. run migrations against DATABASE_URL
  3. docker build → push to any always-on host (host-agnostic by design)
  4. set the GitHub App webhook URL to the deployed /api/github/webhooks
  5. install app on a TEST repo; add required check in branch protection
  6. open a PR → watch: check goes pending, bot comments, reply, check flips green
  7. re-run the battle harness on the OpenAI grader over REAL diffs (gate on efficacy)
```

---

## 10. Flagged decisions (defaults chosen; swap if you prefer)

```
  D1  app framework   Probot (default; least boilerplate) | raw express+octokit
  D2  db layer        Drizzle (typed; default) | plain pg + SQL
  D3  synchronize     carry pass forward if decisions_hash unchanged (default) |
      re-gating       always re-gate on any push (stricter, noisier)
  D-host  hosting     any container host + any Postgres via DATABASE_URL — no lock-in
```

D3 is the only one with a correctness angle (the "pass then push slop" hole). The default
closes it while not re-quizzing on trivial pushes; flip to always-re-gate if you want
maximum strictness.

---

## 11. Build order

```
  0  extract @reckon/core; reckon-mcp still green on its 11 tests
  1  Postgres schema + migrations + db/ queries
  2  Probot skeleton + installation lifecycle → installations/repos
  3  pullRequest handler: diff → classify → decompose → check + elicit
  4  issueComment handler: grade → check flip + rescue loop
  5  OpenAiGrader + RE-RUN battle harness on real diffs (efficacy gate)
  6  .reckon.yml config + trivial autopass + path filters
  7  synchronize carry-forward (D3)
  8  dogfood on the reckon repos; then beta installs
```

Step 5's efficacy re-run is the true go/no-go — everything before it is plumbing; a grader
that mis-scores is worse than no gate.
