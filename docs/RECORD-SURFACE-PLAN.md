# Reckon Record — Surface Build Plan

**Status:** planned, not started · **Last updated:** 2026-07-25
**Covers:** marketing/landing page, login/auth, the personal record dashboard (skill graph),
and self-serve deletion. This is the **moat** surface — where the durable demonstrations we
already collect become something a user can see, and where "delete on request" becomes "delete
it yourself."

---

## What already exists (the backend is ~half-built)

```
  users            durable, keyed by github_id (numeric). populated on every passed gate.
  demonstrations   durable, keyed by github_id: one row per topic a person demonstrated
                   (concept slug + strong/solid/thin verdict + note + repo/PR provenance).
  store methods    upsertUser · recordDemonstrations · deleteUserRecord(github_id)
  join key         github_id — the same numeric id an OAuth "Sign in with GitHub" yields
```

The surface is mostly a **read layer over data that's already accruing**, plus one write
(deletion). The skill graph's raw material exists today; only the clustering + UI are new.

---

## Components

```
  1. MARKETING / LANDING (/)      product pitch + "Install" CTA. static. no auth.
                                   → the HN destination. shippable ALONE, first.
  2. AUTH (/login)                "Sign in with GitHub" → resolve the numeric github_id.
                                   that id is the whole join; no new identity system.
  3. RECORD DASHBOARD (/record)   the user's demonstrations, grouped into skill sections,
                                   each verdict + PR link, over time. THE skill graph.
  4. SETTINGS / PRIVACY (/settings)  "Delete my record" → deleteUserRecord(github_id).
                                   makes the honest data story self-serve.
```

---

## Proposed architecture (decisions flagged ▶)

```
  ▶ WHERE IT LIVES     a SEPARATE Next.js app on Vercel, NOT bolted onto the Fly Probot
                       webhook server. different concerns (user-facing web vs webhooks),
                       different scaling, and the Probot app has no business serving a UI.
                       shares the same Supabase project.
                       (alt: add routes to Fly — rejected: awkward, couples the two.)

  ▶ AUTH               Supabase Auth's built-in GitHub OAuth provider. Runs the OAuth flow,
                       manages sessions, lives in the SAME Supabase project as the data, no
                       third-party auth service. Exposes the GitHub numeric id (via the
                       provider identity / user_metadata) → joins demonstrations.github_id.
                       (this is the "GitHub OAuth + Supabase" path; no Clerk.)

  ▶ DATA ACCESS        Next.js API routes reading Supabase with the service key, scoped in
                       code to the authed github_id. simplest correct start.
                       (alt: direct Supabase client + RLS keyed to a Clerk JWT — cleaner
                       long-term, more wiring. start with API routes.)

  ▶ SKILL GRAPH DEPTH  MVP = demonstrations grouped by raw concept slug, with verdict +
                       PR links (ships the value immediately over existing data).
                       FULL = embedding-cluster the slugs into skill-graph sections, each
                       expandable to the raw-slug demonstrations (your earlier vision).
                       sequence MVP first; clustering is a processing layer added later.
```

Stack in one line (to confirm): **Next.js on Vercel · Supabase Auth (GitHub OAuth) · Supabase
read/API · deletion via the existing `deleteUserRecord`.**

---

## Sequencing

```
  PHASE 1 — LAUNCH-READY (no auth, cheapest, do first)
    • marketing/landing page + Install CTA
    • → this is the only piece the HN launch actually needs. ship it standalone.

  PHASE 2 — THE RECORD (makes the durable data real + deletion self-serve)
    • Supabase Auth (GitHub OAuth) → resolve github_id
    • /record: demonstrations grouped by concept, verdict badges, PR links, timeline
    • /settings: self-serve "delete my record"
    • → turns "I'll delete on request" into "delete it yourself", and gives returning
      users a reason to come back. needs real usage first to not be an empty room.

  PHASE 3 — THE SKILL GRAPH (the differentiated view)
    • embedding-cluster concept slugs into skill sections
    • graph/section UI, click a section → the raw-slug demonstrations behind it
    • cross-surface: fold in mcp_events (dev-time) alongside demonstrations (merge-time)
      for one comprehension picture per person — the schema already joins on github_id.
```

---

## Data & privacy implications

```
  ● AUTHZ IS THE WHOLE GAME    a user must see ONLY their own record. every query filters by
                               the authed github_id. a leak here = exposing someone's
                               demonstrated-understanding history. treat as the #1 review item.
  ● SELF-SERVE DELETE          upgrades the data story: "your record persists across repos and
                               outlives uninstall — and you can delete it yourself anytime."
                               update README + the HN data line to say "self-serve" once shipped.
  ● MARKETING COPY             must match the two-tier retention already in the README (per-repo
                               gate data purges on uninstall; the personal record persists til
                               you delete it). one source of truth for the privacy language.
  ● NO NEW DATA COLLECTED      the surface only READS what the gate already stores + DELETES on
                               request. it does not widen the data footprint.
```

---

## Decisions to confirm before build

1. **Stack** — Next.js/Vercel + Supabase Auth (GitHub OAuth) + Supabase, separate app? ✓ (decided)
2. **Phase 1 alone for launch** — ship just the marketing page now, defer auth/record. ✓ (decided)
3. **Skill graph** — MVP (grouped list) first, or build the embedding graph directly? Embeddings
   give better *grouping* (merge synonymous slugs), not accuracy/perf, and need data volume to
   validate — with ~1 user's data the clusters won't mean much yet. (open)
4. **Domain / branding** for the web app. (open)

Open question: what's missing from this plan — anything you'd want the record to show that
the current `demonstrations` schema can't answer yet? (that would feed back into what the gate
records.)
