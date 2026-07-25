# Codebase Graph — Research & Build Plan

**Status:** research complete, build not started · **Last updated:** 2026-07-25
**Context:** giving Reckon a structural understanding of the codebase so it can (1) gate by
*criticality* not size (lever ②), and (2) ask "how does this change interact with the rest of
the system?" This is the feature that turns Reckon from a seatbelt into something deep.

---

## Decisions committed

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Build first** (tree-sitter repo map, ~80% recall, free), not buy | Self-contained, no service dependency, good enough to start. |
| D2 | **Roadmap toward buy** (Sourcegraph SCIP / GitHub code-nav) | Precise xrefs + types are *objectively better*; the build is a bridge, not the destination. |
| D3 | **PR-gate graph is EPHEMERAL, per-PR** | Avoids the persistent-index staleness/cost/rebuild nightmare at multi-repo scale. |
| D4 | **Reckon will read beyond the diff** | Required to see a change's neighborhood. **Changes the "never reads code outside the PR" claim** (see Open Dependencies). |
| D5 | Impact output is **advisory, never authoritative** | Sound impact analysis doesn't exist for dynamic/cross-service code (§3). Matches Reckon's nature: a comprehension prompt, not a compiler gate. |

---

## TL;DR — the reframe

The field spent 2023 building big persistent code graphs/indexes and 2024–2026 **walking away
from them**. The consensus is now **agentic search first**, with structural/graph tools reserved
for one job — **relational "what does this touch" questions** — where they win decisively. That
one job is Reckon's entire need. So the goal is *not* "build a Sourcegraph." It's a narrow,
mostly-ephemeral structural layer, framed as advisory.

---

## 1 · Landscape: representations (what works / what doesn't)

```
  PRODUCTION-GRADE                          WHAT IT GIVES / COSTS
  ─────────────────────────────────────────────────────────────────────────────
  tree-sitter          syntax tree, INCREMENTAL, ~24 official + 100s community
                       grammars. NO types/semantics ← the load-bearing limit
                       everything downstream works around. (Aider, Zed, GitHub)
  SCIP (Sourcegraph)   precise symbol/xref + types. indexers are THIN WRAPPERS
                       around existing type-checkers (scip-python→Pyright,
                       scip-ruby→Sorbet). LSIF is RETIRED; SCIP is the standard.
  Stack Graphs (GitHub) file-ISOLATED name resolution → cheap incremental. but
                       Python GA 2023, TS GA 2024 only — "language-agnostic" on
                       paper, narrow in shipped reality.
  Glean (Meta) / Kythe monorepo-scale, build-system-coupled. not what a
                       multi-repo app replicates.
  dependency graphs    madge / dependency-cruiser / pydeps — module-level, cheap,
                       mature, non-semantic.
  ─────────────────────────────────────────────────────────────────────────────
  RESEARCH / NICHE
  CPG (Joern)          AST+CFG+PDG unified. won IEEE Test-of-Time 2024, but it's a
                       SECURITY/vuln tool, not general nav. stays in that lane.
  sound call graphs    PyCG etc. — academic; break on reflection/dynamic dispatch.
  cross-language/FFI   open research problem (CHARON, PolyCruise). no mainstream infra.
```

**Universal pattern:** the incremental unit is the compile/build unit or the isolated file —
*never* the git diff. And **nobody ships a sound call graph for a dynamic language** — reflection,
monkeypatching, and dynamic dispatch break static analysis. That's structural, not a tooling gap.

---

## 2 · How LLMs actually get codebase understanding now (2024 → 2026 shift)

```
   2023: "embed everything"  ──►  2025-26: agentic search default, 3 tools by job
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  LEXICAL (grep/ripgrep/BM25)   the default. Claude Code, Sourcegraph Amp,  │
   │                                Windsurf dropped vectors ENTIRELY for this  │
   │  SEMANTIC (embeddings)         a COMPLEMENT, not a base. Cursor keeps it,   │
   │                                trained its OWN model. +12.5% on top of grep │
   │  STRUCTURAL (graph/LSP)        for RELATIONAL questions only: who-calls,    │
   │                                blast radius. wins 3–50× on token efficiency │
   └──────────────────────────────────────────────────────────────────────────┘
```

| finding | number | source |
|---|---|---|
| agentic grep-first vs full RAG | **94.5%** of RAG faithfulness, zero vector store | Amazon, AAAI'26 |
| semantic search *on top of* grep | **+12.5%** avg accuracy | Cursor Context Bench |
| graph/LSP vs grep+read, token cost | **3–50× less** (Consul 319K LOC blast radius: 17.7MB → 841KB) | Gortex |
| graph nav on HIDDEN-dependency tasks | **99.4%** vs 76.2% vanilla vs 78.2% BM25 | CodeCompass '26 |
| but agents ignore the graph tool | **58% of trials made zero tool calls** unless steered | CodeCompass '26 |

Takeaways for Reckon:
- **Embeddings-RAG is being abandoned by name** (Claude Code, Sourcegraph). Failure modes:
  staleness (an index can't tell fresh from stale), renamed/deleted-symbol drift, and
  "semantically similar ≠ answers the question." We should not build on embeddings.
- **Structural graphs beat search only on hidden, non-lexical dependencies** — the blast-radius
  case — **and only if the model is explicitly told to use the structure** (the 58% finding). If
  decompose/grader is agentic, we **inject** the structural context; we don't offer it as an
  optional tool.
- Nobody runs Microsoft-style GraphRAG (LLM-extracted entity graphs) over code in production. The
  code graphs people use are **hand-built symbol/reference graphs from tree-sitter or LSP**.

### The technique we'll actually build — Aider's repo map

```
  tree-sitter parse → def/ref tags → graph (node=symbol, edge=references)
    → personalized PageRank (hub functions outrank private helpers;
      symbols mentioned in the current task get 10×, files-in-chat 50×)
    → binary-search pack signatures into a token budget (default ~1k tokens)
  = whole-repo STRUCTURAL awareness (signatures, not bodies) for pennies
```

Most battle-tested open technique in the space, and the closest to what we need. We scope it to
a diff (see §5).

---

## 3 · Impact analysis — the honest ceiling

This is the capability we want, and the one to be most sober about.

```
  static call-graph impact analysis
  precision ~99%   ·   RECALL 70–93%   →   it SILENTLY MISSES edges
  PyCG: 99.2% precision / 69.9% recall on real Python apps
  ISSTA'24 median recall ~0.884; JS worse; cross-service = 0 (invisible to static)
```

**Verdict: advisory-only, a lower bound on blast radius, never a ceiling.** Sound impact graphs
exist only for *typed, single-process, statically-indexed* code (where Sourcegraph/Moderne earn
trust). Dynamic (Python/JS), reflective, or cross-service code is structurally under-reported.
Vendors admit LLM-only blast-radius "might find 80% of dependencies or hallucinate connections."
(Replit, July 2025: an agent deleted a prod DB with a 91-dependent blast radius it never saw.)

**Why this is fine for Reckon:** we're a *comprehension prompt*, not a compiler gate. "This touches
`AuthSession`, which ~12 call sites depend on — explain that contract" is useful at 80% recall.
We steer a human's attention; we don't certify safety. Advisory framing is native to what we are.

---

## 4 · Build reality — cost, cadence, maintenance, resurfacing

```
  RECONSTRUCTION CADENCE (nobody does routine full rebuilds)
    continuous / file-watch ── IDE-local (tree-sitter, Cursor ~3-min Merkle diff)
    ~1 min poll             ── Zoekt default
    per-commit/push         ── the aspiration for SCIP/stack-graphs at scale
    FULL rebuild            ── ONLY on force-push / branch-set change / cold start
                              ← this tail is where teams underestimate cost

  COST: per-pass is cheap, FREQUENCY is the trap
    text-embedding-3-small $0.02/M tok → 10M code chunks (~5B tok) ≈ $100/full pass
    the $12K/month horror story = naive WEEKLY FULL re-embed of a 1TB corpus
    → incremental (hash/Merkle per file, cache by content) is the whole game
    (note: we are NOT using embeddings, so this is context, not our cost model)

  RESURFACING (graph → LLM context, best-evidenced)
    retrieve a TASK-SCOPED SUBGRAPH → PageRank rank → serialize as COMPACT
    STRUCTURED snippets (signatures + edges), NOT prose, NOT raw dump → fit budget
    if agentic: explicitly prompt to use it (the 58%-ignore finding)

  BUILD vs BUY
    build  tree-sitter + Aider-style repo map → self-contained, multi-lang via
                                                 grammars, no service dependency, ~80% recall
    buy    Sourcegraph SCIP/MCP or GitHub code-nav API → precise xrefs + types, they
                                                 own staleness; per-language coverage is a menu
    under-documented number industry-wide: person-months to build a NEW-language indexer.
    GitHub shipped stack-graphs Python-only for years — expensive even for the inventors.
```

---

## 5 · The Reckon plan — two levels

```
  ┌─ PR-GATE LEVEL (build now, light, EPHEMERAL) ──────────────────────────────┐
  │ we see ONE diff at gate time across potentially THOUSANDS of small repos.    │
  │ a persistent per-repo index = the staleness + storage + force-push-rebuild   │
  │ nightmare at our worst scale. AVOID IT.                                       │
  │                                                                             │
  │ Build an EPHEMERAL per-PR repo map:                                          │
  │   1. fetch the changed files + a bounded neighborhood (their refs/referrers) │
  │   2. tree-sitter parse → def/ref graph → personalized PageRank               │
  │   3. use it to:                                                             │
  │      (a) TIER CRITICALITY — high fan-in hub? gate hard. leaf CSS? gate light │
  │      (b) ENRICH decompose — "touched by 12 call sites, explain the contract" │
  │   4. throw it away. reconstruct per PR.                                      │
  │ cost = one bounded parse per PR. NO index to keep fresh. This IS lever ②.    │
  └─────────────────────────────────────────────────────────────────────────────┘
  ┌─ MCP LEVEL (deep, later) ──────────────────────────────────────────────────┐
  │ dev-time, ONE repo, persistent tree-sitter/SCIP index, incremental on save,  │
  │ agentic navigation. the real "understand the whole system" graph. heavy      │
  │ build; justified once the wedge (the gate) has users.                       │
  └─────────────────────────────────────────────────────────────────────────────┘
```

The ephemeral per-PR repo map is the key insight: it sidesteps **every** operational pain in §4
(no persistent store, no staleness, no rebuild tail, no per-repo cost) while delivering lever ②'s
criticality signal and better "how does this interact" questions. It's Aider's proven technique,
scoped to a diff.

---

## 6 · Roadmap: build → buy

```
  NOW        tree-sitter repo map, ephemeral per-PR, ~80% recall, free, self-contained
             → good enough to ship criticality-tiering + interaction-aware questions
                     │
                     ▼
  LATER      migrate the reference edges to BUY: Sourcegraph SCIP / GitHub code-nav API
             → precise, type-aware xrefs; objectively better recall/precision
             → they own indexing + staleness + per-language coverage
             trigger to switch: when ~80% recall's false-negatives start mattering, or
             when precise cross-file/type-aware questions become the product's edge
```

The build is deliberately a **bridge**. Keep the repo-map interface narrow (input: diff +
neighborhood; output: ranked symbols + edges + criticality tier) so the backend can swap from
tree-sitter to SCIP without touching the gate logic.

---

## 7 · Open dependencies

- **Data claim must change (D4).** Today Reckon "never reads code outside the PR" (README,
  ARCHITECTURE, HN draft). Reading a change's neighborhood breaks that. Before shipping the
  graph, update: README "What it can (and can't) see", ARCHITECTURE, and the HN data paragraph,
  to disclose that Reckon reads a bounded neighborhood of the changed files (not the whole repo,
  not stored). This is a launch-blocking edit *for the graph feature*, not for the current gate.
- **GitHub permissions.** Reading beyond the diff needs `Contents: read` (already held) and
  fetching referenced files via the API — confirm rate-limit headroom on large repos.
- **Language coverage.** tree-sitter grammars per language; start with the languages Reckon's
  users actually ship (TS/JS/Python likely first). Degrade gracefully (fall back to diff-only
  gating) for unsupported languages.
- **Behavioral steering.** If decompose is agentic, inject the structural context directly
  (the 58%-ignore finding), don't expose it as an optional tool.

---

## Sources

Aider repomap (aider.chat/2023/10/22/repomap.html) · Sourcegraph SCIP (announcing-scip) + BM25F
(keeping-it-boring-and-relevant) · Cursor semsearch + secure-codebase-indexing · Claude Code
no-indexing (vadim.blog) + Anthropic large-codebases best-practices · Gortex/zzet.org grep-vs-graph
taxonomy · CodeCompass (arXiv 2602.20048) · LocAgent (arXiv 2503.09089) · PyCG (arXiv 2103.00587) ·
"Total Recall? How Good Are Static Call Graphs Really?" ISSTA'24 · "When to use Graphs in RAG"
(arXiv 2506.05690) · Glean / Indexing code at scale (Meta Eng, 2024) · GitHub stack graphs +
TS precise-nav GA · voyage-code-3 (HF) · Kythe (kythe.io) · Joern CPG (IEEE S&P 2014, ToT 2024) ·
Cursor infra (Pragmatic Engineer) · Zoekt indexserver (default 1-min poll) · OpenAI embedding
pricing 2026 · RAG freshness problem (tianpan.co).
