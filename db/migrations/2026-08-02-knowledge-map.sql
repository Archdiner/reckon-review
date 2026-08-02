-- Reckon: knowledge map + collection fixes (2026-08-02)
--
-- Paste this whole file into the Supabase SQL editor and run it. Every statement is
-- IF NOT EXISTS / idempotent, so re-running is safe and running it twice does nothing.
-- Nothing here drops, renames, or rewrites an existing column, so it cannot lose data.
--
-- The app tolerates these columns being absent (it retries writes without them and logs),
-- so there is no ordering requirement against a deploy. `npm run report` names any column
-- that is still missing, which is the only way that silent fallback is visible.
--
-- db/schema.sql remains the source of truth for the full shape; this file is just the delta.

-- ── checkpoints ────────────────────────────────────────────────────────────────────────────

-- Why a non-gated outcome was skipped. Skips are now recorded as rows (status 'trivial' |
-- 'peripheral' | 'capped'), which is what gives the usage funnel a denominator: without them
-- you can count gates but not the PRs Reckon actually saw.
alter table checkpoints add column if not exists skip_reason text;

-- What the change was ABOUT. `areas` is the stable subsystem spine the per-PR concept slugs are
-- projected onto; without it a demonstration cannot be placed on the architecture and freshness
-- has no drift signal to decay against.
alter table checkpoints add column if not exists files jsonb not null default '[]';
alter table checkpoints add column if not exists areas jsonb not null default '[]';

-- Who opened the PR. Deliberately here and NOT in the durable `users` table: an author whose PR
-- was merely scanned did not choose to interact, so their identity lives with the install-scoped
-- data that cascade-purges on uninstall.
alter table checkpoints add column if not exists author_login text;
alter table checkpoints add column if not exists author_id bigint;

-- Graph observability: how load-bearing the change was, whether the structural context built at
-- all, and how long it took.
alter table checkpoints add column if not exists hub_count integer not null default 0;
alter table checkpoints add column if not exists core_count integer not null default 0;
alter table checkpoints add column if not exists graph_used boolean not null default false;
alter table checkpoints add column if not exists graph_ms integer;

-- The SUBSYSTEM ROLLUP of the codebase graph that is already built on every gate and otherwise
-- discarded: area nodes (files, defs, fan-in, PageRank) plus which areas reference which. Tens of
-- nodes, not thousands of files. This is the architecture diagram the knowledge map is drawn on.
alter table checkpoints add column if not exists area_graph jsonb;

-- Present on most live databases already; included so a fresh paste is complete.
alter table checkpoints add column if not exists closeout jsonb;

-- The funnel and the drift count are both "checkpoints in this repo, recent first" scans.
create index if not exists checkpoints_repo_created_idx on checkpoints(repo_id, created_at desc);

-- ── demonstrations ─────────────────────────────────────────────────────────────────────────

-- The two axes of the knowledge map, stamped at write time because neither input survives to
-- read time: `area` needs the PR's changed paths (on a checkpoint that purges on uninstall) and
-- `domains` needs the explanation (which the durable record never carries).
alter table demonstrations add column if not exists area text;
alter table demonstrations add column if not exists domains jsonb not null default '[]';
alter table demonstrations add column if not exists head_sha text;

create index if not exists demonstrations_area_idx on demonstrations(repo_full_name, area);

-- ── verify ─────────────────────────────────────────────────────────────────────────────────
-- Run this after; every row should say 'ok'. Anything missing means the statement above it
-- did not apply.
select
  want.tbl || '.' || want.col as column,
  case when c.column_name is null then 'MISSING' else 'ok' end as status
from (values
  ('checkpoints','skip_reason'), ('checkpoints','files'), ('checkpoints','areas'),
  ('checkpoints','author_login'), ('checkpoints','author_id'), ('checkpoints','hub_count'),
  ('checkpoints','core_count'), ('checkpoints','graph_used'), ('checkpoints','graph_ms'),
  ('checkpoints','area_graph'), ('checkpoints','closeout'),
  ('demonstrations','area'), ('demonstrations','domains'), ('demonstrations','head_sha')
) as want(tbl, col)
left join information_schema.columns c
  on c.table_name = want.tbl and c.column_name = want.col and c.table_schema = 'public';
