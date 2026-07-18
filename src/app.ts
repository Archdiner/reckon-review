/**
 * Probot entry. Wires GitHub webhooks to the two handlers, injecting the proven
 * store (Supabase) + grader (OpenAI, gpt-5.4-mini) once.
 *
 * Run with Probot's runtime (it supplies APP_ID / PRIVATE_KEY / WEBHOOK_SECRET from env and
 * an installation-scoped octokit per event). Set OPENAI_API_KEY, SUPABASE_URL,
 * SUPABASE_SECRET_KEY too. See README for the GitHub App registration steps.
 */
import type { Probot } from 'probot';
import { loadConfig } from './config.js';
import { OpenAiBackend } from './grader/openai.js';
import { SupabaseStore } from './store/supabase.js';
import { onPullRequestOpened, onPullRequestSynchronize, onIssueComment, type Deps } from './handlers.js';

export default function app(probot: Probot): void {
  const cfg = loadConfig();
  const deps: Deps = {
    store: new SupabaseStore(cfg.supabaseUrl, cfg.supabaseSecretKey),
    backend: new OpenAiBackend(cfg.openaiApiKey, cfg.graderModel),
    rigor: 'medium',
  };

  probot.on(['pull_request.opened', 'pull_request.ready_for_review'], async (context) => {
    try {
      await onPullRequestOpened(context, deps);
    } catch (err: any) {
      context.log.error({ err: err?.message || err }, 'reckon: pull_request handler failed');
    }
  });

  probot.on('pull_request.synchronize', async (context) => {
    try {
      await onPullRequestSynchronize(context, deps);
    } catch (err: any) {
      context.log.error({ err: err?.message || err }, 'reckon: synchronize handler failed');
    }
  });

  probot.on('issue_comment.created', async (context) => {
    try {
      await onIssueComment(context, deps);
    } catch (err: any) {
      context.log.error({ err: err?.message || err }, 'reckon: issue_comment handler failed');
    }
  });
}
