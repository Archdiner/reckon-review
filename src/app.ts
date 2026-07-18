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
    dailyPerInstall: cfg.dailyPerInstall,
    dailyGlobal: cfg.dailyGlobal,
  };

  // ACK the webhook immediately, then process in the BACKGROUND. decompose/grade take
  // several seconds; awaiting them inside the handler would hold GitHub's connection past its
  // ~10s delivery timeout under load and trigger duplicate retries. We fire-and-forget so
  // Probot returns 200 in milliseconds. Trade-off: a background failure is logged but not
  // retried by GitHub (a re-push re-triggers); a durable queue is the scale-up answer.
  const bg = (name: string, p: Promise<void>): void => {
    void p.catch((err: any) => probot.log.error({ err: err?.message || err }, `reckon: ${name} handler failed`));
  };

  probot.on(['pull_request.opened', 'pull_request.ready_for_review'], (context) => {
    bg('pull_request', onPullRequestOpened(context, deps));
  });

  probot.on('pull_request.synchronize', (context) => {
    bg('synchronize', onPullRequestSynchronize(context, deps));
  });

  probot.on('issue_comment.created', (context) => {
    bg('issue_comment', onIssueComment(context, deps));
  });
}
