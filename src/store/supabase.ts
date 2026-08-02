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
  status: string; // pending | passed | trivial | peripheral | capped | error
  skip_reason: string | null;
  files: string[] | null;
  areas: string[] | null;
  hub_count: number | null;
  core_count: number | null;
  graph_used: boolean | null;
  graph_ms: number | null;
  author_login: string | null;
  author_id: number | null;
  passed_by: string | null;
  passed_by_id: number | null;
  passed_at: string | null;
  closeout: unknown | null; // the rich deposit persisted on pass (null if best-effort failed)
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
  status?: string;
  skip_reason?: string;
  files?: string[];
  areas?: string[];
  hub_count?: number;
  core_count?: number;
  graph_used?: boolean;
  graph_ms?: number | null;
  author_login?: string | null;
  author_id?: number | null;
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

export interface NewDemonstration {
  github_id: number;
  github_login?: string;
  concept: string;
  summary?: string;
  verdict?: string | null; // strong | solid | thin | null
  note?: string;
  area?: string | null; // axis 1: repo subsystem (knowledge/areas.ts)
  domains?: string[]; // axis 2: portable knowledge domains (knowledge/domains.ts)
  repo_full_name?: string;
  pr_number?: number;
  head_sha?: string;
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

  /** Columns added after the first deploy. A Supabase migration is applied by hand, so a deploy
   *  can legitimately land before the SQL does; every write that uses one of these degrades to
   *  the pre-migration column set rather than failing. Only `createCheckpoint` is on the merge
   *  path, and it is the one that must never fail for a reason as cosmetic as a missing column. */
  private static readonly LATE_CHECKPOINT_COLS = ['skip_reason', 'files', 'areas', 'hub_count', 'core_count', 'graph_used', 'graph_ms', 'author_login', 'author_id'] as const;

  private static isMissingColumn(message: string): boolean {
    return /column .* does not exist|could not find the .* column/i.test(message);
  }

  private static strip<T extends object>(o: T, keys: readonly string[]): T {
    const copy: any = { ...o };
    for (const k of keys) delete copy[k];
    return copy as T;
  }

  async createCheckpoint(c: NewCheckpoint): Promise<CheckpointRow> {
    const { data, error } = await this.db.from('checkpoints').insert(c).select().single();
    if (!error) return data as CheckpointRow;
    if (!SupabaseStore.isMissingColumn(error.message)) throw new Error(`createCheckpoint: ${error.message}`);

    console.warn('createCheckpoint: new columns absent, writing the pre-migration set (run db/schema.sql)');
    const lean = SupabaseStore.strip(c, SupabaseStore.LATE_CHECKPOINT_COLS);
    const retry = await this.db.from('checkpoints').insert(lean).select().single();
    if (retry.error) throw new Error(`createCheckpoint: ${retry.error.message}`);
    return retry.data as CheckpointRow;
  }

  /**
   * Record a PR we deliberately did NOT gate (trivial, peripheral, over the daily cap). No model
   * call, so it is nearly free, and it is the difference between "we gated 12 PRs" and "we saw
   * 96 PRs, gated 12, and here is why the other 84 were skipped". It also feeds drift: a skipped
   * PR still moved the code, so it still ages every demonstration in the areas it touched.
   *
   * Best-effort by construction: this runs on paths that have already told GitHub the check is
   * green, so a failure here is logged and swallowed, never surfaced.
   */
  async recordSkip(c: NewCheckpoint & { status: string; skip_reason: string }): Promise<void> {
    try {
      await this.createCheckpoint(c);
    } catch (err: any) {
      console.warn(`recordSkip: ${err?.message || err}`);
    }
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

  /** Any one reviewer's pass satisfies the gate (the decided v1 rule). The closeout (the
   *  rich deposit) is persisted alongside so a user's Reckon record can show what they
   *  demonstrated they understand — null when the best-effort close failed. */
  async markCheckpointPassed(
    id: string,
    by: { passed_by: string; passed_by_id: number; closeout?: unknown }
  ): Promise<void> {
    const now = new Date().toISOString();
    // Critical write: flip the gate to passed + record who cleared it. Must succeed.
    const { error } = await this.db
      .from('checkpoints')
      .update({ status: 'passed', passed_by: by.passed_by, passed_by_id: by.passed_by_id, passed_at: now, updated_at: now })
      .eq('id', id);
    if (error) throw new Error(`markCheckpointPassed: ${error.message}`);

    // Best-effort: persist the rich close. Tolerates the `closeout` column being absent (a
    // deploy that lands BEFORE the migration still passes cleanly — the deposit MESSAGE is
    // computed in-handler and unaffected; only persistence waits for the column).
    if (by.closeout !== undefined) {
      const { error: e2 } = await this.db.from('checkpoints').update({ closeout: by.closeout }).eq('id', id);
      if (e2) console.warn(`markCheckpointPassed: closeout not persisted (${e2.message}) — run the migration`);
    }
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

  /** Deleting a repo cascades to its checkpoints → attempts. Used when a single repo is
   *  removed from an install (the install itself stays). */
  async deleteRepo(id: number): Promise<void> {
    const { error } = await this.db.from('repos').delete().eq('id', id);
    if (error) throw new Error(`deleteRepo: ${error.message}`);
  }

  // ── The durable, cross-install personal record ─────────────────────────────────────────
  // These write to tables keyed by github_id that are NOT cascade-purged on uninstall (unlike
  // checkpoints/attempts). They back the persistent skill graph, and are disclosed as such.

  /** Promote a GitHub identity into the durable users table (the cross-surface anchor). Upsert
   *  so it is idempotent across every PR a person passes; refreshes last_seen. */
  async upsertUser(u: { github_id: number; github_login?: string; email?: string }): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.db
      .from('users')
      .upsert({ github_id: u.github_id, github_login: u.github_login, email: u.email, last_seen: now }, { onConflict: 'github_id' });
    if (error) throw new Error(`upsertUser: ${error.message}`);
  }

  /** Append demonstrated-understanding rows (one per topic on a passed gate). Degrades to the
   *  pre-migration column set rather than losing the whole write to a missing column. */
  async recordDemonstrations(rows: NewDemonstration[]): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await this.db.from('demonstrations').insert(rows);
    if (!error) return;
    if (!SupabaseStore.isMissingColumn(error.message)) throw new Error(`recordDemonstrations: ${error.message}`);

    console.warn('recordDemonstrations: new columns absent, writing the pre-migration set (run db/schema.sql)');
    const lean = rows.map((r) => SupabaseStore.strip(r, ['area', 'domains', 'head_sha']));
    const retry = await this.db.from('demonstrations').insert(lean);
    if (retry.error) throw new Error(`recordDemonstrations: ${retry.error.message}`);
  }

  /**
   * How many substantive changes landed in these areas since a timestamp. The DRIFT half-life
   * input (src/knowledge/freshness.ts): understanding decays because the code moved, and this
   * is the measurement of "moved".
   *
   * Counts gated and capped outcomes only. A 'trivial' or 'peripheral' skip by definition
   * touched nothing load-bearing, so it must not age anyone's understanding, or every README
   * typo would erode the map.
   */
  async countAreaChangesSince(repo_id: number, sinceIso: string): Promise<Map<string, number>> {
    const { data, error } = await this.db
      .from('checkpoints')
      .select('areas, status, created_at')
      .eq('repo_id', repo_id)
      .gte('created_at', sinceIso)
      .in('status', ['pending', 'passed', 'capped', 'error']);
    if (error) throw new Error(`countAreaChangesSince: ${error.message}`);
    const counts = new Map<string, number>();
    for (const row of (data ?? []) as any[]) {
      for (const a of (row.areas ?? []) as string[]) counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    return counts;
  }

  /** A person's durable record, newest first. Used by the integration test and available to any
   *  future record surface; the report reads through its own query layer, not this one. */
  async listDemonstrations(github_id: number): Promise<NewDemonstration[]> {
    const { data, error } = await this.db
      .from('demonstrations')
      .select('*')
      .eq('github_id', github_id)
      .order('demonstrated_at', { ascending: false });
    if (error) throw new Error(`listDemonstrations: ${error.message}`);
    return (data ?? []) as NewDemonstration[];
  }

  /** Delete a person's durable record on request (the honest counterpart to persistence — the
   *  record survives uninstall, so deletion has to be explicit). Removes their demonstrations
   *  and the users anchor; leaves any per-repo gate data to the install-scoped cascade. */
  async deleteUserRecord(github_id: number): Promise<void> {
    const d = await this.db.from('demonstrations').delete().eq('github_id', github_id);
    if (d.error) throw new Error(`deleteUserRecord(demonstrations): ${d.error.message}`);
    const u = await this.db.from('users').delete().eq('github_id', github_id);
    if (u.error) throw new Error(`deleteUserRecord(users): ${u.error.message}`);
  }
}
