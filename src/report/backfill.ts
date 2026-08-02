/**
 * `npm run backfill` — recover what the old collection code threw away, for PRs that already
 * happened.
 *
 *   npm run backfill              → dry run. reports exactly what it would write, touches nothing.
 *   npm run backfill -- --apply   → writes.
 *   npm run backfill -- --apply --repo owner/name   → one repo only.
 *
 * WHAT IS RECOVERABLE, and why:
 *
 *   checkpoints.files / areas / author   YES, from the GitHub API. A checkpoint knows its repo and
 *                                        PR number, and the PR's file list is still there, so the
 *                                        subsystem spine can be rebuilt for every gate ever opened.
 *   demonstrations.area                  YES, once its checkpoint has files: match on
 *                                        (repo_full_name, pr_number), take the dominant subsystem.
 *   demonstrations.domains               MOSTLY. The durable record never carried the explanation,
 *                                        but `attempts.explanation` still holds it for any install
 *                                        that has not been removed, so the keyword classifier gets
 *                                        the real text rather than just a concept slug. Rows whose
 *                                        install is gone fall back to concept + summary.
 *
 * WHAT IS NOT, and is reported rather than faked:
 *
 *   skipped PRs (trivial/peripheral/capped)   Never written at all, so there is no row to repair.
 *                                             Reconstructing them would mean re-classifying every
 *                                             PR in the repo's history against the diff as it was
 *                                             at the time, which is guesswork. The funnel is
 *                                             accurate from the deploy forward, not backward.
 *   checkpoints.area_graph                    Not backfilled on purpose. The diagram is
 *                                             newest-wins, so the next gate on each repo fills it
 *                                             for free; rebuilding it would mean pulling a tarball
 *                                             per historical PR to draw a diagram that is
 *                                             immediately superseded.
 *   closeout verdicts                         The per-topic read was never computed for those
 *                                             gates. Re-running it would be inventing a judgement
 *                                             of an explanation nobody graded that way, so those
 *                                             demonstrations keep the neutral unverdicted score.
 *
 * Read-mostly and idempotent: it only ever fills columns that are currently empty, so re-running
 * after a partial failure resumes rather than redoing.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { ProbotOctokit } from 'probot';
import { areasFor, areaFor } from '../knowledge/areas.js';
import { classifyDomains } from '../knowledge/domains.js';

const APPLY = process.argv.includes('--apply');
const ONLY_REPO = ((): string | null => {
  const i = process.argv.indexOf('--repo');
  return i >= 0 ? process.argv[i + 1] ?? null : null;
})();

function env(k: string): string {
  const v = process.env[k];
  if (!v || !v.trim()) throw new Error(`missing required env: ${k}`);
  return v.trim();
}

/** The same dominant-subsystem rule the live handler uses, so a backfilled row is
 *  indistinguishable from one written at gate time. */
function dominantArea(files: string[]): string | null {
  const counts = new Map<string, number>();
  for (const f of files) {
    const a = areaFor(f);
    if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

async function main(): Promise<void> {
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SECRET_KEY'), { auth: { persistSession: false } });
  const appId = env('APP_ID');
  const privateKey = process.env.PRIVATE_KEY || readFileSync(env('PRIVATE_KEY_PATH'), 'utf8');

  console.log(APPLY ? 'BACKFILL (writing)\n' : 'BACKFILL (dry run, nothing will be written)\n');

  const { data: repos, error: rErr } = await db.from('repos').select('id, installation_id, full_name');
  if (rErr) throw new Error(`repos: ${rErr.message}`);
  const targets = (repos ?? []).filter((r: any) => !ONLY_REPO || r.full_name === ONLY_REPO);
  if (targets.length === 0) {
    console.log('no repos to process. A repo row only exists once the app has seen an install or a PR.');
    return;
  }

  const stats = { checkpoints: 0, cpSkipped: 0, cpFailed: 0, demoAreas: 0, demoDomains: 0, demoUnresolved: 0 };
  const repoName = new Map<number, string>(targets.map((r: any) => [r.id, r.full_name]));

  // ── 1. checkpoints: files, areas, author ────────────────────────────────────────────────
  for (const repo of targets) {
    const [owner, name] = String(repo.full_name).split('/');
    // One installation-scoped client per repo. An uninstalled account will 401 here, which is
    // expected and skipped rather than fatal: its gate data is on its way out anyway.
    let octokit: any;
    try {
      octokit = new ProbotOctokit({ auth: { appId: Number(appId), privateKey, installationId: repo.installation_id } });
      await octokit.repos.get({ owner, repo: name });
    } catch (err: any) {
      console.log(`  skip ${repo.full_name}: cannot authenticate (${err?.status ?? err?.message}). Likely uninstalled.`);
      continue;
    }

    // Only rows that are actually missing the data, so a re-run resumes.
    const { data: cps, error } = await db
      .from('checkpoints')
      .select('id, pr_number, files, areas, author_login')
      .eq('repo_id', repo.id)
      .order('created_at', { ascending: false });
    if (error) throw new Error(`checkpoints(${repo.full_name}): ${error.message}`);

    const needy = (cps ?? []).filter((c: any) => !(c.files?.length) || !c.author_login);
    console.log(`${repo.full_name}: ${needy.length} of ${(cps ?? []).length} checkpoint(s) need backfill`);

    for (const c of needy as any[]) {
      try {
        const files: string[] = (await octokit.paginate(octokit.pulls.listFiles, {
          owner, repo: name, pull_number: c.pr_number, per_page: 100,
        })).map((f: any) => f.filename);
        const pr = await octokit.pulls.get({ owner, repo: name, pull_number: c.pr_number });
        const author = pr.data.user;

        const patch = {
          files,
          areas: areasFor(files),
          author_login: author?.login ?? null,
          author_id: author?.type === 'Bot' ? null : (author?.id ?? null),
        };
        if (APPLY) {
          const { error: uErr } = await db.from('checkpoints').update(patch).eq('id', c.id);
          if (uErr) throw new Error(uErr.message);
        }
        stats.checkpoints++;
        console.log(`  #${c.pr_number}: ${files.length} file(s) -> areas ${JSON.stringify(patch.areas)}${APPLY ? '' : '  (dry)'}`);
      } catch (err: any) {
        // A deleted PR, a transferred repo, a revoked token: skip it, keep going, report the total.
        stats.cpFailed++;
        console.log(`  #${c.pr_number}: could not backfill (${err?.status ?? err?.message})`);
      }
    }
  }

  // ── 2. demonstrations: area (from the now-backfilled checkpoints) + domains ─────────────
  const { data: demos, error: dErr } = await db
    .from('demonstrations')
    .select('id, repo_full_name, pr_number, concept, summary, area, domains');
  if (dErr) throw new Error(`demonstrations: ${dErr.message}`);

  // Checkpoint files by (repo, pr), so a demonstration can find the change it came from.
  const { data: allCps } = await db.from('checkpoints').select('id, repo_id, pr_number, files');
  const filesByPr = new Map<string, string[]>();
  const cpIdByPr = new Map<string, string>();
  for (const c of (allCps ?? []) as any[]) {
    const full = repoName.get(c.repo_id);
    if (!full) continue;
    const k = `${full}#${c.pr_number}`;
    if (c.files?.length) filesByPr.set(k, c.files);
    cpIdByPr.set(k, c.id);
  }

  // The explanations are still in `attempts` for any install that has not been removed, which is
  // strictly better input for the classifier than a concept slug.
  const { data: attempts } = await db.from('attempts').select('checkpoint_id, explanation');
  const textByCp = new Map<string, string>();
  for (const a of (attempts ?? []) as any[]) {
    textByCp.set(a.checkpoint_id, `${textByCp.get(a.checkpoint_id) ?? ''}\n${a.explanation}`.trim());
  }

  for (const d of (demos ?? []) as any[]) {
    if (ONLY_REPO && d.repo_full_name !== ONLY_REPO) continue;
    const k = `${d.repo_full_name}#${d.pr_number}`;
    const patch: Record<string, unknown> = {};

    if (!d.area) {
      const area = dominantArea(filesByPr.get(k) ?? []);
      if (area) { patch.area = area; stats.demoAreas++; }
      else stats.demoUnresolved++;
    }
    if (!(d.domains?.length)) {
      const cpId = cpIdByPr.get(k);
      const text = (cpId && textByCp.get(cpId)) || `${d.concept} ${d.summary ?? ''}`;
      const domains = classifyDomains(text);
      if (domains.length) { patch.domains = domains; stats.demoDomains++; }
    }
    if (Object.keys(patch).length === 0) continue;

    if (APPLY) {
      const { error: uErr } = await db.from('demonstrations').update(patch).eq('id', d.id);
      if (uErr) throw new Error(`demonstrations(${d.id}): ${uErr.message}`);
    }
    console.log(`  demo ${d.concept} (${k}): ${JSON.stringify(patch)}${APPLY ? '' : '  (dry)'}`);
  }

  console.log('\n──────────────────────────────────────────────');
  console.log(`checkpoints backfilled     ${stats.checkpoints}`);
  console.log(`checkpoints failed         ${stats.cpFailed}`);
  console.log(`demonstration areas set    ${stats.demoAreas}`);
  console.log(`demonstration domains set  ${stats.demoDomains}`);
  console.log(`demonstrations with no recoverable area  ${stats.demoUnresolved}`);
  console.log('\nNot backfilled, by design:');
  console.log('  skipped PRs (trivial/peripheral/capped) were never written, so there is no row to repair.');
  console.log('  area_graph is newest-wins; the next gate on each repo fills it for free.');
  console.log('  closeout verdicts were never computed for those gates; they keep the neutral score.');
  if (!APPLY) console.log('\nDRY RUN. Re-run with --apply to write.');
}

main().catch((e) => {
  console.error('backfill failed:', e?.message || e);
  process.exit(1);
});
