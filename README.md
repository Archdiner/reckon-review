# Vouch — explain what you merge

**Vouch is a GitHub App that blocks a pull request from merging until a human can explain,
in their own words, the *mechanism* of what it changes.** It works on any PR, no matter who
(or what) wrote it — Claude, Cursor, Copilot, a human. AI reviewers check the *code* is
good; Vouch checks that a *human understands it* before it ships.

> Vouch is **hosted for you** — nothing to run, no server, no API keys to manage.
> Free during the beta.

---

## Install it (about 30 seconds)

1. **Install Vouch** on your repos → [github.com/apps/reckon-pr](https://github.com/apps/reckon-pr/installations/new)
   (or: your repo → Settings → GitHub Apps → Configure)
2. **Require the check** so it actually blocks merges: repo → Settings → Branches → Branch
   protection → require the **`Reckon comprehension`** status check (and, if you like,
   ≥1 approving review).
3. Done. Open a PR and Vouch takes it from there.

---

## What it feels like

```
  PR opened        Vouch posts a merge-blocking check + a comment:
                   "explain the mechanism of what this changes"
  you reply        in your own words - why it works, what breaks if done differently
  Vouch grades it  an isolated model checks your explanation (not a summary of the diff)
     pass          -> the check goes green, merge unblocked
     not yet       -> it points at the one gap; you take another pass
  push more code   -> it re-checks; unchanged decisions carry your pass forward
```

Any **one** reviewer's passing explanation clears the gate. Trivial PRs (docs, lockfiles,
tiny changes) pass automatically.

---

## Privacy — what it can and can't see

```
  reads    the PR's diff + the explanation comments people write
  writes   a status check + comments on the PR
  never    reads code outside the PR, stores your source, or touches anything else
```

## FAQ

- **Cost?** Free during the beta — we cover the grading.
- **Who has to explain it?** Any one reviewer with write access. One good explanation clears it.
- **Does it run my tests / interfere with CI?** No. It's a separate status check that sits
  alongside your CI; it runs no code.
- **Turn it off?** Uninstall the App, or drop the required check from branch protection.

## Beta

Vouch is early. If the grader ever seems wrong or the flow feels off, that's exactly the
feedback we want — open an issue.

---

<details>
<summary>Run your own instance (advanced / contributing)</summary>

Vouch is hosted, so you don't need this. But the code is open. To self-host: it's a Probot
app (`src/app.ts`) reusing `@reckon/core`'s grader/decompose, with an OpenAI backend and a
Supabase store. You'll need a GitHub App registration, a Supabase project (`schema.sql`), an
OpenAI key, and a host (see `Dockerfile` / `fly.toml`). `ARCHITECTURE.md` has the details.

</details>
