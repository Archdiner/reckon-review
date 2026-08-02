/**
 * `npm run report` — pull everything out of Supabase and write the HTML report.
 *
 *   npm run report                        → reckon-report.html
 *   npm run report -- --out /tmp/r.html   → somewhere else
 *   npm run report -- --json              → also dump the model as JSON, for piping
 *
 * Reads the same SUPABASE_URL / SUPABASE_SECRET_KEY the app uses. Read-only: this never writes
 * to the database, so it is safe to point at production.
 */
import { writeFileSync } from 'node:fs';
import { ReportQuery } from './query.js';
import { build } from './model.js';
import { renderReport } from './render.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    console.error('missing SUPABASE_URL / SUPABASE_SECRET_KEY');
    process.exit(2);
  }

  const out = arg('out', 'reckon-report.html')!;
  const snapshot = await new ReportQuery(url, key).snapshot();
  const model = build(snapshot);

  writeFileSync(out, renderReport(model), 'utf8');
  if (process.argv.includes('--json')) writeFileSync(out.replace(/\.html$/, '') + '.json', JSON.stringify(model, null, 2), 'utf8');

  const s = model.snapshot;
  console.log(`wrote ${out}`);
  console.log(`  ${s.installations.length} installs, ${s.repos.length} repos, ${s.checkpoints.length} PR outcomes, ${s.attempts.length} explanations, ${s.demonstrations.length} demonstrations, ${s.users.length} people`);
  console.log(`  funnel: seen ${model.funnel.seen} -> gated ${model.funnel.gated} -> answered ${model.funnel.answered} -> passed ${model.funnel.passed}`);
  console.log(`  ${model.areas.length} areas mapped`);

  // Findings go to the console too, so this is usable as a check without opening the HTML.
  for (const f of model.findings) console.log(`  [${f.severity.toUpperCase()}] ${f.title}${f.count ? ` (${f.count})` : ''}`);

  // Non-zero on a critical finding, so this can be wired into a scheduled job later.
  process.exit(model.findings.some((f) => f.severity === 'critical') ? 1 : 0);
}

main().catch((e) => {
  console.error('report failed:', e?.message || e);
  process.exit(1);
});
