# reckon-pr  ·  *(product name: **Vouch**)*

**The comprehension gate for GitHub pull requests.** A GitHub App that blocks a PR merge
until a human can explain — in their own words — the *mechanism* of what the PR does. Works
for **any** PR regardless of who wrote it (Claude, Cursor, Copilot, a human). It's the
counterweight to AI reviewers: they check the *code* is good; Vouch checks a *human
understands it* before it ships.

> The hosted/cloud half of [Reckon](../reckon). Reuses `@reckon/core`'s grader + decompose
> behind the `LlmBackend` port (here: OpenAI `gpt-5.4-mini`), and persists state in Supabase.

---

## How it works

```
  PR opened / pushed  → fetch diff → (trivial? auto-pass) → decompose into decisions
                        → create a MERGE-BLOCKING check + post an "explain to merge" comment
  reviewer replies    → grade the explanation (isolated, cross-vendor)
                          pass  → flip the check to green (merge unblocks) + mark passed
                          fail  → post the single hole as a re-explanation prompt (stays blocked)
                          outage→ neutral check + loud nudge (never silently pass)
  new push (D3)       → re-decompose; decisions unchanged since a pass → carry it forward;
                        changed → re-gate on the new head (closes "pass then push slop")
```

Any **one** reviewer's passing explanation satisfies the gate. Branch protection requiring
the `Reckon — comprehension` check is what actually blocks the merge.

---

## Architecture

```
  @reckon/core (shared brain)     decompose · grade/gradePlan · rubric · elicit prompts
        │  LlmBackend port
        ▼
  OpenAiBackend (gpt-5.4-mini)    the grader — cross-vendor by design (don't self-judge)
  SupabaseStore                   installations · repos · checkpoints · attempts
  handlers + Probot app           the webhook glue
```

Key files: `src/app.ts` (Probot entry), `src/handlers.ts` (PR + comment logic),
`src/grader/openai.ts`, `src/store/supabase.ts`, `src/github.ts`, `src/util.ts` (classify),
`schema.sql` (the DB), `ARCHITECTURE.md` / `DESIGN.md` (the why).

---

## Setup

### 1. Supabase (the database)
1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor → paste `schema.sql` → Run** (creates the 4 tables).
3. Settings → API → copy the **Project URL** and the **`secret` (service_role) key**.
   The service key bypasses RLS — correct for a trusted server; no policies needed.

### 2. OpenAI
Get an API key. The grader defaults to `gpt-5.4-mini` (validated: 0 false-pass on the
efficacy battery — see below). Override with `RECKON_GRADER_MODEL`.

### 3. Register the GitHub App
[github.com/settings/apps/new](https://github.com/settings/apps/new):

| Setting | Value |
|---|---|
| Webhook URL | your public endpoint (or a smee URL for local dev, step 5) |
| Webhook secret | a random string |
| Private key | Generate one → download the `.pem` |
| **Repository permissions** | Pull requests: **R/W** · Issues: **R/W** · Checks: **R/W** · Contents: **Read** · Metadata: **Read** |
| **Subscribe to events** | Pull request · Issue comment |

### 4. Environment (`.env`)
```
APP_ID=            # from the App's settings page
PRIVATE_KEY=       # contents of the .pem (or use PRIVATE_KEY_PATH)
WEBHOOK_SECRET=    # the secret you set
OPENAI_API_KEY=
SUPABASE_URL=      # the Project URL (https://<ref>.supabase.co)
SUPABASE_SECRET_KEY=
# optional: RECKON_GRADER_MODEL=gpt-5.4-mini
```

### 5. Run it locally (no deploy needed)
```bash
npm install
npm run build
# Probot forwards GitHub webhooks to your machine via a smee.io channel:
WEBHOOK_PROXY_URL=https://smee.io/<your-channel> npm start
```
Point the App's Webhook URL at the same smee channel. Install the App on a test repo, open a
PR, and the check + comment appear against your local process.

### 6. Go live
Host the container anywhere (`npm start` = `probot run ./dist/app.js`), point the App's
Webhook URL at it, then in the repo: **Settings → Branches → require the
`Reckon — comprehension` status check** (+ require ≥1 approving review). That's the merge block.

### 7. Dogfood
Install the App on **this repo** and open PRs here. As OWNER your own comments clear the
reviewer gate, so you can drive both sides solo.

---

## Scripts / verification

| Command | What it does |
|---|---|
| `npm run build` | type-check + compile |
| `npm start` | run the Probot app |
| `npm run roundtrip` | live Supabase + grader round-trip (needs `.env`) |
| `tsx src/handler-test.ts` | full PR gate flow with a fake Octokit (real store + grader) |
| `tsx src/efficacy.ts` | the grader efficacy battery on the configured model |

**Grader efficacy (`gpt-5.4-mini`):** 15/16 on the 8-scenario × 2-rigor battery, **0
false-pass** (no slop through the gate). Full multi-case human-label calibration (Cohen's κ)
is still the bar before high-scale trust.

---

## Status

Built + verified: core/store/grader integration (live round-trip), both webhook handlers
(opened + synchronize/D3), classify, the full pending→rescue→pass flow (handler test).
**Remaining:** register the GitHub App and run it against a live PR. Config file
(`.reckon.yml` path filters / per-repo rigor) is not wired yet — v1 gates via the built-in
classifier and a single rigor.
