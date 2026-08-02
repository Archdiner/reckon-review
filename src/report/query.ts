/**
 * The report's READ layer. Deliberately separate from SupabaseStore: that class is the hot path
 * a webhook runs through and should stay small and obviously correct. This one runs offline from
 * a CLI, pulls whole tables, and is allowed to be slow.
 *
 * Everything here tolerates a column that has not been migrated yet. Supabase migrations are
 * applied by hand from db/schema.sql, so at any moment the deployed app may be writing columns
 * the database does not have, or this report may be reading them. `select('*')` plus optional
 * field access means a partially-migrated database yields a partial report rather than a crash,
 * and the health panel says exactly which columns are missing.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface InstallationRow {
  id: number; account_login: string; account_type: string; suspended_at: string | null; created_at: string;
}
export interface RepoRow {
  id: number; installation_id: number; full_name: string; default_branch: string; config: unknown; created_at: string;
}
export interface CheckpointRow {
  id: string; repo_id: number; pr_number: number; head_sha: string; status: string;
  skip_reason?: string | null; files?: string[] | null; areas?: string[] | null;
  hub_count?: number | null; core_count?: number | null; graph_used?: boolean | null; graph_ms?: number | null;
  author_login?: string | null; author_id?: number | null;
  decisions: unknown; rigor: string; closeout?: unknown;
  passed_by: string | null; passed_by_id: number | null; passed_at: string | null;
  created_at: string; updated_at: string;
}
export interface AttemptRow {
  id: string; checkpoint_id: string; reviewer_login: string; reviewer_id: number;
  explanation: string; grade_pass: boolean; ungraded: boolean; hole: string | null; created_at: string;
}
export interface UserRow { github_id: number; github_login: string | null; email: string | null; first_seen: string; last_seen: string; }
export interface DemonstrationRow {
  id: string; github_id: number; github_login: string | null; concept: string; summary: string | null;
  verdict: string | null; note: string | null; area?: string | null; domains?: string[] | null;
  repo_full_name: string | null; pr_number: number | null; head_sha?: string | null; demonstrated_at: string;
}
export interface McpEventRow {
  id: string; github_id: number | null; github_login: string | null; subsystem: string | null;
  concept: string | null; passed: boolean | null; ungraded: boolean | null; repo: string | null; created_at: string;
}

export interface Snapshot {
  installations: InstallationRow[];
  repos: RepoRow[];
  checkpoints: CheckpointRow[];
  attempts: AttemptRow[];
  users: UserRow[];
  demonstrations: DemonstrationRow[];
  mcpEvents: McpEventRow[];
  /** Tables that could not be read at all, with the reason. A missing table is a finding, not a
   *  crash: `mcp_events` legitimately does not exist unless the sister MCP host was deployed. */
  unreadable: { table: string; reason: string }[];
  fetchedAt: string;
}

const PAGE = 1000;

export class ReportQuery {
  private db: SupabaseClient;
  constructor(url: string, secretKey: string) {
    this.db = createClient(url, secretKey, { auth: { persistSession: false } });
  }

  /** Page through a whole table. supabase-js caps a single response at 1000 rows, so a naive
   *  select silently truncates and every number downstream is quietly wrong. */
  private async all<T>(table: string, orderBy: string): Promise<{ rows: T[]; error?: string }> {
    const rows: T[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.db.from(table).select('*').order(orderBy, { ascending: true }).range(from, from + PAGE - 1);
      if (error) return { rows, error: error.message };
      const batch = (data ?? []) as T[];
      rows.push(...batch);
      if (batch.length < PAGE) break;
    }
    return { rows };
  }

  async snapshot(): Promise<Snapshot> {
    const unreadable: { table: string; reason: string }[] = [];
    const read = async <T>(table: string, orderBy: string): Promise<T[]> => {
      const { rows, error } = await this.all<T>(table, orderBy);
      if (error) unreadable.push({ table, reason: error });
      return rows;
    };

    const [installations, repos, checkpoints, attempts, users, demonstrations, mcpEvents] = await Promise.all([
      read<InstallationRow>('installations', 'created_at'),
      read<RepoRow>('repos', 'created_at'),
      read<CheckpointRow>('checkpoints', 'created_at'),
      read<AttemptRow>('attempts', 'created_at'),
      read<UserRow>('users', 'first_seen'),
      read<DemonstrationRow>('demonstrations', 'demonstrated_at'),
      read<McpEventRow>('mcp_events', 'created_at'),
    ]);

    return {
      installations, repos, checkpoints, attempts, users, demonstrations, mcpEvents,
      unreadable, fetchedAt: new Date().toISOString(),
    };
  }
}
