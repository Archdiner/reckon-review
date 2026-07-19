import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * reckon-pr's persistence over Supabase (Postgres via supabase-js). This is the GitHub-App
 * state — installations, repos, checkpoints, attempts — NOT @reckon/core's recall ledger
 * (v1 has no recall). The secret/service_role key bypasses RLS, so no policies are needed.
 */

export interface CheckpointRow {
  id: string;
  repo_id: number;
  pr_number: number;
  pr_node_id: string;
  head_sha: string;
  check_run_id: number | null;
  decisions: unknown;
  decisions_hash: string;
  rigor: string;
  status: string; // pending | passed | trivial | error
  passed_by: string | null;
  passed_by_id: number | null;
  passed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewCheckpoint {
  repo_id: number;
  pr_number: number;
  pr_node_id: string;
  head_sha: string;
  check_run_id?: number | null;
  decisions: unknown;
  decisions_hash: string;
  rigor: string;
}

export interface NewAttempt {
  checkpoint_id: string;
  reviewer_login: string;
  reviewer_id: number;
  comment_id?: number | null;
  explanation: string;
  assisted: boolean;
  grade_pass: boolean;
  ungraded: boolean;
  scores?: unknown;
  overlap?: string;
  hole?: string;
}

export class SupabaseStore {
  private db: SupabaseClient;
  constructor(url: string, secretKey: string) {
    this.db = createClient(url, secretKey, { auth: { persistSession: false } });
  }

  async upsertInstallation(i: { id: number; account_login: string; account_type: string }): Promise<void> {
    const { error } = await this.db.from('installations').upsert(i);
    if (error) throw new Error(`upsertInstallation: ${error.message}`);
  }

  async upsertRepo(r: {
    id: number;
    installation_id: number;
    full_name: string;
    default_branch?: string;
    config?: unknown;
  }): Promise<void> {
    const { error } = await this.db.from('repos').upsert(r);
    if (error) throw new Error(`upsertRepo: ${error.message}`);
  }

  async createCheckpoint(c: NewCheckpoint): Promise<CheckpointRow> {
    const { data, error } = await this.db.from('checkpoints').insert(c).select().single();
    if (error) throw new Error(`createCheckpoint: ${error.message}`);
    return data as CheckpointRow;
  }

  /** The pending checkpoint for a PR (the gate a reviewer's explanation resolves). */
  async findPendingCheckpoint(repo_id: number, pr_number: number): Promise<CheckpointRow | null> {
    const { data, error } = await this.db
      .from('checkpoints')
      .select('*')
      .eq('repo_id', repo_id)
      .eq('pr_number', pr_number)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`findPendingCheckpoint: ${error.message}`);
    return (data as CheckpointRow) ?? null;
  }

  async recordAttempt(a: NewAttempt): Promise<void> {
    const { error } = await this.db.from('attempts').insert(a);
    if (error) throw new Error(`recordAttempt: ${error.message}`);
  }

  /** Any one reviewer's pass satisfies the gate (the decided v1 rule). */
  async markCheckpointPassed(id: string, by: { passed_by: string; passed_by_id: number }): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.db
      .from('checkpoints')
      .update({ status: 'passed', passed_by: by.passed_by, passed_by_id: by.passed_by_id, passed_at: now, updated_at: now })
      .eq('id', id);
    if (error) throw new Error(`markCheckpointPassed: ${error.message}`);
  }

  /** The most recent checkpoint for a PR, any status — used on synchronize (new push). */
  async findLatestCheckpoint(repo_id: number, pr_number: number): Promise<CheckpointRow | null> {
    const { data, error } = await this.db
      .from('checkpoints')
      .select('*')
      .eq('repo_id', repo_id)
      .eq('pr_number', pr_number)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`findLatestCheckpoint: ${error.message}`);
    return (data as CheckpointRow) ?? null;
  }

  /** Carry a passed checkpoint forward onto a new head (decisions unchanged after a push). */
  async updateCheckpointHead(id: string, head_sha: string): Promise<void> {
    const { error } = await this.db
      .from('checkpoints')
      .update({ head_sha, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw new Error(`updateCheckpointHead: ${error.message}`);
  }

  async getCheckpoint(id: string): Promise<CheckpointRow | null> {
    const { data, error } = await this.db.from('checkpoints').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`getCheckpoint: ${error.message}`);
    return (data as CheckpointRow) ?? null;
  }

  async countAttempts(checkpoint_id: string): Promise<number> {
    const { count, error } = await this.db
      .from('attempts')
      .select('*', { count: 'exact', head: true })
      .eq('checkpoint_id', checkpoint_id);
    if (error) throw new Error(`countAttempts: ${error.message}`);
    return count ?? 0;
  }

  /** Every prior explanation on a checkpoint, oldest first. The grader scores the reviewer's
   *  CUMULATIVE understanding across rounds — otherwise a reply that covers one decision reads
   *  as "missing" the others and the gate loops forever, never converging. */
  async listAttemptExplanations(checkpoint_id: string): Promise<string[]> {
    const { data, error } = await this.db
      .from('attempts')
      .select('explanation')
      .eq('checkpoint_id', checkpoint_id)
      .order('created_at', { ascending: true });
    if (error) throw new Error(`listAttemptExplanations: ${error.message}`);
    return (data ?? []).map((r: any) => r.explanation as string);
  }

  /** Count gates (checkpoints) created for an installation's repos since a timestamp. */
  async countInstallGatesSince(installationId: number, sinceIso: string): Promise<number> {
    const { data: repos, error: e1 } = await this.db.from('repos').select('id').eq('installation_id', installationId);
    if (e1) throw new Error(`countInstallGatesSince(repos): ${e1.message}`);
    const ids = (repos ?? []).map((r: any) => r.id);
    if (ids.length === 0) return 0;
    const { count, error } = await this.db
      .from('checkpoints')
      .select('*', { count: 'exact', head: true })
      .in('repo_id', ids)
      .gte('created_at', sinceIso);
    if (error) throw new Error(`countInstallGatesSince: ${error.message}`);
    return count ?? 0;
  }

  /** Count all gates created since a timestamp (global cost ceiling). */
  async countGlobalGatesSince(sinceIso: string): Promise<number> {
    const { count, error } = await this.db
      .from('checkpoints')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', sinceIso);
    if (error) throw new Error(`countGlobalGatesSince: ${error.message}`);
    return count ?? 0;
  }

  /** Deleting an installation cascades to its repos → checkpoints → attempts. */
  async deleteInstallation(id: number): Promise<void> {
    const { error } = await this.db.from('installations').delete().eq('id', id);
    if (error) throw new Error(`deleteInstallation: ${error.message}`);
  }
}
