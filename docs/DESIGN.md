# Reckon Review — the comprehension gate for GitHub pull requests

**Status:** design draft, 2026-07-18
**Sister to:** `reckon-mcp` (the Claude Code comprehension loop)
**One line:** Reckon Review moves the comprehension checkpoint to where modern AI teams
actually ship — the pull request — and blocks the merge until a human can explain, in
their own words, the *mechanism* of what the agent built.

---

## 1. Why this repo exists (the pivot)

`reckon-mcp` fires its checkpoint *before build*, inside a Claude Code session, over the
hook rail (`ExitPlanMode`). That rail only exists in the terminal.

But most PR review does **not** happen in a terminal. It happens in the GitHub web UI, the
mobile app, on a phone. In the loop/PR paradigm — agents build whole features and open
PRs, humans review and merge — the durable human job collapses onto the **merge**. The
human may write zero lines; their entire contribution is the review + merge decision.

So the comprehension checkpoint has to move with it:

```
  reckon-mcp   checkpoint BEFORE build      terminal, hook rail, claude -p
  reckon-pr    checkpoint BEFORE merge      GitHub PR, webhook rail, API grader
```

Same loop, new home. The merge is the new checkpoint.

**A payoff falls out of the move:** `reckon-mcp`'s #1 open problem is latency (40–90s, the
human waits on a blocking spinner). On GitHub the loop is **async** — you comment, the bot
replies in ~40s, you get a notification. GitHub's async nature dissolves the latency
problem.

---

## 2. Positioning — Reckon Review vs AI reviewers (CodeRabbit, Greptile, Copilot)

They are **opposite vectors on the same pipeline**, and they stack:

```
  CodeRabbit:  AI ──► human    does the understanding FOR you.  OFFLOADS comprehension.
  Reckon Review:   human ──► AI     forces YOU to produce it.        INSOURCES comprehension.

  agent writes ─► CodeRabbit: "is the CODE good?"   (bugs, style — machine-graded)
               ─► Reckon Review:  "does the HUMAN get it?" (comprehension-graded)
               ─► merge
```

A PR can be fully CodeRabbit-approved and understood by **no human on the team.** That is
exactly Reckon Review's failure mode. So the better AI reviewers get, the more they raise code
quality *and lower human understanding at the same time* — they make it easier to merge
code nobody grasped ("the AI said it's fine, click merge"). Reckon Review is the counterweight.
It does not compete with AI reviewers; it makes them safe.

---

## 3. Architecture — one brain, two thin clients

The comprehension loop is already client-agnostic in `reckon-mcp`: `loop.ts` takes ground
truth as an *input*, the grader is pure text-in/verdict-out, storage is injected. The only
Claude-Code-specific wire is the grader *backend* (`claude -p`). Reckon Review is the second
client — which is what finally justifies extracting the shared core (with one client the
seam was speculative; with two it is earned).

```
        ┌──────────────────  @reckon/core  ──────────────────┐
        │  loop · grade(PORT) · rubric · elicit · decompose · │
        │  storage(PORT) · recall scheduling                  │
        └─────────────────────────────────────────────────────┘
             ▲                                     ▲
     reckon-mcp (this stays)              reckon-pr (this repo)
     ClaudeCliGrader                      OpenAiGrader
     SqliteStore                          PostgresStore
     hook trigger / terminal              webhook trigger / PR comments
```

Two ports are all that vary:

```
  interface Grader  { grade(input): Promise<GradeResult> }
  interface Storage { add / get / update / dueForRecall(...) }
```

Everything else — elicit prompts, decompose, the 7-dim rubric, overlap detection, recall
scheduling — is shared, untouched, and battle-tested.

---

## 4. What it feels like in practice — one PR, end to end

```
  agent opens PR #412 "add retry to webhook sender"
        │
        ▼
  ① Reckon check appears:  ● Reckon — comprehension pending   (merge blocked)
     bot comments, grounded in THIS diff (decompose over the PR):
     ┌───────────────────────────────────────────────────────────┐
     │ 🧠 Before you approve — explain the mechanism, not the diff:│
     │    Why exponential backoff here, and what breaks if you    │
     │    used a fixed 1s retry instead?                          │
     │    Reply in this thread with your explanation.             │
     └───────────────────────────────────────────────────────────┘
        │
        ▼
  ② reviewer replies in-thread: "a fixed interval syncs all failing
     senders into a thundering herd; backoff spreads retries so a
     downed consumer isn't re-hammered in lockstep…"
        │
        ▼   issue_comment webhook → @reckon/core.submit → OpenAiGrader
        │
   ┌────┴─────── fail ──────────────────────┐
   ▼                                         ▼
  ③ bot: "close — but WHY does the herd      ✓ grade passes
     matter for THIS consumer? one more      → check goes green
     pass"  (rescue, in-thread, natural)     → reviewer's APPROVE now counts
        │                                     → merge unblocks
        └──► re-explain ──► back to grader
        ▼
  ④ 3 weeks later — Reckon opens an issue @reviewer:
     "Cold recall: the retry-backoff call in #412. Re-explain,
      no peeking." → answer in the issue → temporal moat, github-native
```

The **comment thread carries the conversation** (elicit → explain → rescue → re-explain);
the **approval is the identity-bound event** the check keys off once the thread reaches a
pass. Same `@reckon/core`, new rail.

---

## 5. Decisions locked (2026-07-18)

```
  ● PRIMARY SURFACE   github-raw (web/mobile PR review), not the terminal.
                      agent-merge (in a CC session) is the easy subset and
                      can reuse reckon-mcp as-is; github-raw is the main event.

  ● APP over ACTION   a hosted GitHub App (owns the check, the comment loop,
                      and the recall cron centrally). chosen for UX: one
                      install, cleanest "block until good response." price:
                      we own an always-on webhook + a database. (Action was
                      the alternative — zero infra for us, rougher UX, recall
                      needs a per-repo scheduled workflow. rejected on UX.)

  ● GRADER = OPENAI   model-agnostic core; OpenAI impl. cross-vendor judging
                      (Claude writes, GPT grades) STRENGTHENS "don't self-judge."
                      inference paid from existing startup OpenAI credits →
                      "who pays" resolved as you-eat-it, no BYO-key needed for beta.

  ● TYPE SURFACE      conversation in the PR comment thread; the approving
                      review is the gate event. rescue loop lives in-thread
                      (natural — same as how humans/CodeRabbit converse).

  ● OVERLAP CHECK     fold AI-reviewer comments (CodeRabbit et al.) into the
                      SAME overlap check as the diff. no distinct assist tier.
                      high overlap with a pre-chewed AI summary = restatement = fail.

  ● ALWAYS-ASSISTED   the diff is always on screen on GitHub, so every answer is
                      inherently assisted. that's fine — reading source and
                      explaining it IS comprehension. the overlap gate keeps it
                      honest (source you interpreted ✓ / conclusion you pasted ✗).
```

---

## 6. The grader (model-agnostic, OpenAI-backed)

The grader takes `(groundTruth, explanation, rigor, assisted)` and returns JSON scores over
the 7-dim rubric. It is pure text → verdict. Porting from `claude -p` to OpenAI is a backend
swap:

```
  reckon-mcp   spawn('claude', ['-p', '--model', 'haiku', ...])  stdin=user, stdout=json
  reckon-pr    openai.chat.completions.create({ model, response_format: json, ... })
```

- **Cross-vendor is a feature.** Claude-authored code graded by GPT can't be rubber-stamped
  by self-preference. The isolation the design doc wanted is stronger here for free.
- **Re-validate before trusting the gate.** 94% efficacy / 0 false-pass was measured on
  Haiku + plans. Re-run the battle harness on the OpenAI grader over real PR **diffs**
  (not plans) and recalibrate the rubric to human agreement (Cohen's κ) before it blocks a
  single merge. Non-optional per the LLM-judge research.
- Model choice: start with a strong reasoning model for calibration, then find the cheapest
  one that holds κ — grading is the per-PR cost driver.

---

## 7. Identity binding (who must understand)

GitHub's merge button is guarded by one global boolean: "are required checks green?" — it
is **actor-blind**. The only per-person primitive is the **review**. So comprehension binds
to the *approving review*, not the merge click:

```
  merge action  → global check, anyone can click once green         LEAKY
  approving rev → tied to one identity; the check counts an approval
                  only once that reviewer passed the comprehension thread
```

The A-reviews-B-merges gap is real but the wrong thing to defend: in the loop world the
merge is increasingly automated (auto-merge on green, merge queues, bots). Gating the click
is theater; gating the **review** — the actual act of human judgment — is the point. We
guarantee the code passed through one human who could explain it.

*(Open edge, §10: a required check is still PR-global. Enforcing "the specific approver is
the one who passed" needs the app to reconcile the passing reviewer against the approving
reviewer. Detail to nail in Phase 2.)*

---

## 8. Build roadmap

```
  PHASE 0 · extract the core
    • pull loop/rubric/elicit/decompose/recall into @reckon/core
    • Grader → interface (ClaudeCliGrader | OpenAiGrader)
    • Storage → interface (SqliteStore | PostgresStore)
    • reckon-mcp swaps to consume @reckon/core (proves the seam holds)

  PHASE 1 · app skeleton
    • register GitHub App — perms: PR read, checks write, issues write,
      contents read;  webhooks: pull_request, pull_request_review, issue_comment
    • webhook server (Probot or raw Octokit) on a host (Fly / Railway / Workers)
    • Postgres keyed by (repo, pr, reviewer)
    • OpenAiGrader wired to startup credits

  PHASE 2 · wire the loop
    • PR opened → fetch diff → decompose → post pending check + elicit comment
    • comment reply → core.submit → grade
        pass → flip check green; reconcile passing reviewer ↔ approving review
        fail → rescue reply in-thread, check stays pending
    • pass → write next_recall_due to Postgres

  PHASE 3 · gate + filter
    • branch protection requires the "Reckon" check (this is what blocks merge)
    • classify() on the diff → trivial PRs (dep bumps) auto-pass, no essay

  PHASE 4 · recall (the moat, github-native)
    • cron worker: due item → open issue @reviewer with recallPrompt
    • issue reply → grade cold → reschedule

  PHASE 5 · ship
    • dogfood on the reckon repos themselves first
    • .reckon.yml config (rigor, path filters, model)
    • Marketplace listing + install flow → beta with friendly AI teams
```

---

## 9. Risks specific to leaving the terminal

```
  1. INFRA + STATE   we now own an always-on webhook service + a real DB.
                     reckon-mcp had neither. biggest jump in the whole move.
  2. EFFICACY DRIFT  new grader (OpenAI, not Haiku) + new input (diffs, not
                     plans). MUST re-run the battle harness before it gates.
  3. IDENTITY EDGE   required check is PR-global; "the approver is the one who
                     passed" needs explicit reconciliation (§7).
  4. RESCUE THREADING the thread is natural, but multi-round rescue + re-grade
                     needs clean state per (pr, reviewer) so stale attempts
                     don't count. prototype the thread state machine early.
```

---

## 10. Open decisions

**Resolved 2026-07-18:**
- **Multi-reviewer PRs → one pass satisfies the gate.** Any one reviewer's comprehension
  pass flips the check. No per-approver reconciliation in v1.
- **No cold recall in PR mode for v1.** Passes are recorded (`checkpoints`) so recall can be
  added later without a migration, but v1 ships no recall cron/issues.

**Still open:**
- **Rigor per repo vs per path:** v1 is single-rigor via `.reckon.yml`; per-path (harsh on
  `src/auth/**`) is a later refinement.
- **Marketplace billing:** deferred — startup OpenAI credits cover beta. Revisit for GA.
- **See `ARCHITECTURE.md` §10** for the implementation-level flagged decisions (framework,
  db layer, synchronize re-gating).

---

## 11. Repo layout (proposed)

```
  reckon-pr/
    DESIGN.md            ← this file
    packages/
      core/              ← @reckon/core (shared; or a git dep on reckon-mcp's extraction)
    src/
      app.ts             ← Probot/Octokit webhook entry
      handlers/
        pull_request.ts  ← open → decompose → post check + elicit
        review.ts        ← approval → reconcile identity
        comment.ts       ← explain/rescue thread → grade
        recall.ts        ← cron → issue → grade cold
      grader/
        openai.ts        ← OpenAiGrader (implements core's Grader port)
      store/
        postgres.ts      ← PostgresStore (implements core's Storage port)
    battle/              ← efficacy harness re-run on OpenAI + real diffs
```
