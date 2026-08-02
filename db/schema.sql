-- Reckon-PR schema (v1). Apply to the Supabase Postgres for the GitHub App.
-- Mirrors ARCHITECTURE.md §3. gen_random_uuid() needs pgcrypto (on by default in Supabase).
create extension if not exists pgcrypto;

-- GitHub App installations (org or user that installed Reckon)
create table if not exists installations (
  id             bigint primary key,          -- github installation id
  account_login  text not null,
  account_type   text not null,               -- 'Organization' | 'User'
  suspended_at   timestamptz,
  created_at     timestamptz not null default now()
);

-- Repos the app is active on
create table if not exists repos (
  id               bigint primary key,         -- github repo id
  installation_id  bigint not null references installations(id) on delete cascade,
  full_name        text not null,              -- 'org/repo'
  default_branch   text not null default 'main',
  config           jsonb not null default '{}',   -- parsed .reckon.yml
  config_synced_at timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists repos_installation_idx on repos(installation_id);

-- One gated PR = one checkpoint
create table if not exists checkpoints (
  id              uuid primary key default gen_random_uuid(),
  repo_id         bigint not null references repos(id) on delete cascade,
  pr_number       integer not null,
  pr_node_id      text not null,
  head_sha        text not null,              -- commit the check attaches to
  check_run_id    bigint,                     -- github check run id
  decisions       jsonb not null default '[]',-- decompose() output (the sub-problems)
  decisions_hash  text not null,              -- carry-forward test on synchronize
  rigor           text not null default 'medium',
  -- Every outcome is a row, including the ones we skip. 'trivial'/'peripheral'/'capped' rows
  -- cost no model call but are what make the funnel (PRs seen -> gated -> answered -> passed)
  -- and the drift half-life measurable at all; without them a skip is invisible.
  status          text not null default 'pending', -- pending|passed|trivial|peripheral|capped|error
  skip_reason     text,                       -- why a non-gated outcome was skipped
  -- What the change was ABOUT, recorded at gate time. `areas` is the stable subsystem spine the
  -- per-PR concept slugs get projected onto (src/knowledge/areas.ts); without it a demonstration
  -- cannot be placed on the architecture, and freshness has no drift signal to decay against.
  files           jsonb not null default '[]',-- changed paths
  areas           jsonb not null default '[]',-- derived subsystem keys
  -- Who opened the PR. Deliberately kept HERE and not in the durable `users` table: an author
  -- whose PR we merely scanned has not chosen to interact with Reckon, so their identity lives
  -- with the install-scoped data that cascade-purges on uninstall. `users` is reserved for
  -- people who actually engaged (replied with an explanation), whose record is durable.
  author_login    text,
  author_id       bigint,
  hub_count       integer not null default 0, -- changed files with fan-in >= HUB_FANIN
  core_count      integer not null default 0, -- changed files tiered 'core'
  graph_used      boolean not null default false, -- did the structural context actually build
  graph_ms        integer,                    -- how long it took (cost/latency observability)
  -- The SUBSYSTEM ROLLUP of the codebase graph we already build per PR and otherwise discard:
  -- area nodes (files, defs, fan-in, PageRank) + which areas reference which. Tens of nodes, not
  -- thousands of files. This is the architecture diagram the knowledge map is drawn on, and it
  -- cannot be recomputed later because the source it came from is never stored. The file-level
  -- graph and the source stay ephemeral; only this summary survives.
  area_graph      jsonb,
  passed_by       text,                       -- github login who passed (audit)
  passed_by_id    bigint,
  passed_at       timestamptz,
  closeout        jsonb,                      -- the rich deposit (per-topic read) persisted on pass; null if best-effort close failed
  next_recall_due timestamptz,                -- reserved for future recall; NULL in v1
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists checkpoints_pr_head_idx on checkpoints(repo_id, pr_number, head_sha);
-- Idempotent migration for already-live DBs (the create-table-if-not-exists above won't add
-- new columns to an existing table). Safe to re-run.
alter table checkpoints add column if not exists closeout jsonb;
alter table checkpoints add column if not exists skip_reason text;
alter table checkpoints add column if not exists files jsonb not null default '[]';
alter table checkpoints add column if not exists areas jsonb not null default '[]';
alter table checkpoints add column if not exists hub_count integer not null default 0;
alter table checkpoints add column if not exists core_count integer not null default 0;
alter table checkpoints add column if not exists graph_used boolean not null default false;
alter table checkpoints add column if not exists graph_ms integer;
alter table checkpoints add column if not exists author_login text;
alter table checkpoints add column if not exists author_id bigint;
alter table checkpoints add column if not exists area_graph jsonb;
-- The funnel and the drift count are both "checkpoints in this repo, recent first" scans.
create index if not exists checkpoints_repo_created_idx on checkpoints(repo_id, created_at desc);

-- Every explanation attempt + its grade (conversation + audit trail)
create table if not exists attempts (
  id             uuid primary key default gen_random_uuid(),
  checkpoint_id  uuid not null references checkpoints(id) on delete cascade,
  reviewer_login text not null,
  reviewer_id    bigint not null,
  comment_id     bigint,                      -- the github comment this reply came from
  explanation    text not null,
  assisted       boolean not null default true,  -- always true on github (diff on screen)
  grade_pass     boolean not null,
  ungraded       boolean not null default false, -- grader failed open (LOUD)
  scores         jsonb,
  overlap        text,                        -- low|medium|high|unknown
  hole           text,                        -- rescue prompt returned on fail
  created_at     timestamptz not null default now()
);
create index if not exists attempts_checkpoint_idx on attempts(checkpoint_id);

-- ── THE CONNECTION (cross-surface) ───────────────────────────────────────────────────────
-- Reckon spans two surfaces: this GitHub-App PR gate (merge-time) and the local reckon-mcp
-- loop (dev-time). Both are the SAME person. The join key is the GitHub NUMERIC user id — the
-- PR gate already records it (attempts.reviewer_id, checkpoints.passed_by_id), and the MCP host
-- now stamps it on every event it forwards. These two tables are where the surfaces meet.

-- The identity that spans both surfaces. Upserted from whichever surface sees the user first:
-- a forwarded MCP event, or the PR handlers, which promote everyone who ACTUALLY ENGAGED (replied
-- to a gate with an explanation, pass or fail), not only the people who eventually passed.
-- Populating it on pass alone made this table a subset of `demonstrations` and told you nothing
-- about reach or drop-off. A PR author whose diff was merely scanned is NOT here: they did not
-- choose to interact, so their login stays on checkpoints.author_login, which purges on uninstall.
create table if not exists users (
  github_id     bigint primary key,          -- the cross-surface join key
  github_login  text,
  email         text,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now()
);

-- Local MCP comprehension events, forwarded from the reckon-mcp host (dev-time checkpoints).
-- Metadata only — NEVER the source (ground_truth) or the raw explanation; a profile needs the
-- concept + scores + tier, not the code. github_id joins to users and to attempts.reviewer_id,
-- so one query spans dev-time + merge-time for a person. Session-scoped, not tied to a PR.
create table if not exists mcp_events (
  id            text primary key,            -- @reckon/core ExplanationRecord id (uuid)
  github_id     bigint,                      -- join key (null if identity unresolved)
  github_login  text,
  email         text,
  session_id    text,
  subsystem     text,
  concept       text,
  stage         text,                        -- plan | build
  rigor         text,
  assisted      boolean,
  told          boolean,                     -- cleared by TELL at the escalation floor
  passed        boolean,
  ungraded      boolean,
  scores        jsonb,
  overlap       text,
  attempts      integer,
  repo          text,                        -- best-effort owner/name from the session's git remote
  created_at    timestamptz not null default now()
);
create index if not exists mcp_events_github_idx on mcp_events(github_id);
create index if not exists mcp_events_subsystem_idx on mcp_events(subsystem);

-- ── THE DURABLE RECORD (merge-time) ──────────────────────────────────────────────────────
-- One row per topic a person demonstrated understanding of on a PASSED gate. This is the
-- merge-time twin of mcp_events, and the raw material for the future skill graph (cluster the
-- `concept` slugs; each cluster's leaves are these rows, which you can click through to the
-- exact demonstration).
--
-- DELIBERATELY NOT FK'd to installations/repos: this is the PERSON's record, so it must OUTLIVE
-- any single repo or the app being uninstalled (the gate's per-repo data in checkpoints/attempts
-- cascade-purges on uninstall; this does not). Provenance (repo_full_name, pr_number) is a
-- DENORMALIZED text copy for exactly that reason — it stays intact after the source repo row is
-- gone. Deletion of this record is user-initiated (store.deleteUserRecord), not tied to uninstall.
-- The TWO AXES (src/knowledge/*) are stamped here at write time, not derived at read time,
-- because both inputs are gone by then: `area` needs the PR's changed paths (which live on a
-- checkpoint that cascade-purges on uninstall) and `domains` needs the explanation (which is
-- never stored durably at all). A durable record has to carry its own categorization.
--   area    = WHERE, one repo's subsystem. The team map, the architecture overlay.
--   domains = WHAT KIND, portable across repos. The person's skill profile.
create table if not exists demonstrations (
  id              uuid primary key default gen_random_uuid(),
  github_id       bigint not null,            -- durable owner + join key (users.github_id)
  github_login    text,
  concept         text not null,              -- the raw slug (skill-graph leaf; cluster later)
  summary         text,                       -- what the topic was
  verdict         text,                       -- strong | solid | thin | null (from the closeout)
  note            text,                       -- the grader's per-topic note, if any
  area            text,                       -- axis 1: repo subsystem key (knowledge/areas.ts)
  domains         jsonb not null default '[]',-- axis 2: closed-vocab domains (knowledge/domains.ts)
  repo_full_name  text,                       -- denormalized provenance (survives repo purge)
  pr_number       integer,
  head_sha        text,                       -- which commit the understanding was OF
  demonstrated_at timestamptz not null default now()
);
create index if not exists demonstrations_github_idx on demonstrations(github_id);
create index if not exists demonstrations_concept_idx on demonstrations(concept);
create index if not exists demonstrations_area_idx on demonstrations(repo_full_name, area);
alter table demonstrations add column if not exists area text;
alter table demonstrations add column if not exists domains jsonb not null default '[]';
alter table demonstrations add column if not exists head_sha text;
