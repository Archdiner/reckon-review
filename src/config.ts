/** Env config for reckon-pr. The server uses the Supabase SECRET (service_role) key,
 *  which bypasses RLS — correct for a trusted server; the publishable key is for
 *  untrusted clients (none here). */
export interface Config {
  supabaseUrl: string;
  supabaseSecretKey: string;
  openaiApiKey: string;
  graderModel: string;
}

export function loadConfig(): Config {
  const req = (k: string): string => {
    const v = process.env[k];
    if (!v || !v.trim()) throw new Error(`missing required env: ${k}`);
    return v.trim();
  };
  return {
    supabaseUrl: req('SUPABASE_URL'),
    supabaseSecretKey: req('SUPABASE_SECRET_KEY'),
    openaiApiKey: req('OPENAI_API_KEY'),
    // gpt-5.4-mini: current-gen, caught slop in the probe, ~2s (fine on the async PR flow).
    graderModel: process.env.RECKON_GRADER_MODEL || 'gpt-5.4-mini',
  };
}
