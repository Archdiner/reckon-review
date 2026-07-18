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
  status          text not null default 'pending', -- pending|passed|trivial|error
  passed_by       text,                       -- github login who passed (audit)
  passed_by_id    bigint,
  passed_at       timestamptz,
  next_recall_due timestamptz,                -- reserved for future recall; NULL in v1
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists checkpoints_pr_head_idx on checkpoints(repo_id, pr_number, head_sha);

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
