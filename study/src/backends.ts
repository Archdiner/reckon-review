/**
 * LlmBackend implementations for the study.
 *
 * The study talks to models through @reckon/core's `LlmBackend` port and nothing else.
 * That is what lets stage 2 call the PRODUCTION `decompose()` unmodified — the study is
 * measuring the world with the instrument the product already ships, which is the whole
 * point of running it this way rather than writing a fresh question generator.
 *
 * Three backends:
 *   - AnthropicBackend  — api.anthropic.com, used for generation (stages 2 and 3).
 *   - OpenAiBackend     — api.openai.com, mirrors src/grader/openai.ts.
 *   - MockBackend       — deterministic, no network. Exercises the full pipeline so the
 *                         plumbing and the leakage guards can be tested without spending
 *                         a cent, and so a reviewer can reproduce the control flow offline.
 *
 * The protocol calls for a CHEAPER model at scoring than at generation, cross-checked for
 * agreement. Keeping generation and scoring on separate vendors also buys the property
 * Reckon's own grader is built around: a model does not judge its own output.
 */

import type { LlmBackend } from '@reckon/core';

export interface BackendOpts {
  model?: string;
  timeoutMs?: number;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`${resp.status} ${resp.statusText}: ${text.slice(0, 400)}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Retry on transient failures (429 / 5xx / abort). Generation runs are long; a single
 *  rate-limit blip should not cost the whole stage. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e);
      const retryable = /\b(429|500|502|503|504)\b|abort|ECONNRESET|fetch failed/i.test(msg);
      if (!retryable || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
    }
  }
  throw lastErr;
}

export class AnthropicBackend implements LlmBackend {
  constructor(
    private apiKey: string,
    private model = 'claude-sonnet-5',
    private baseUrl = 'https://api.anthropic.com'
  ) {}

  async complete(system: string, user: string, opts: BackendOpts = {}): Promise<string> {
    const json: any = await withRetry(() =>
      postJson(
        `${this.baseUrl}/v1/messages`,
        { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        {
          model: opts.model || this.model,
          max_tokens: 2000,
          temperature: 0,
          system,
          messages: [{ role: 'user', content: user }],
        },
        opts.timeoutMs ?? 90_000
      )
    );
    return (json?.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('') || '';
  }
}

export class OpenAiBackend implements LlmBackend {
  constructor(
    private apiKey: string,
    private model = 'gpt-5.4-mini',
    private baseUrl = 'https://api.openai.com'
  ) {}

  async complete(system: string, user: string, opts: BackendOpts = {}): Promise<string> {
    const json: any = await withRetry(() =>
      postJson(
        `${this.baseUrl}/v1/chat/completions`,
        { authorization: `Bearer ${this.apiKey}` },
        {
          model: opts.model || this.model,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        opts.timeoutMs ?? 90_000
      )
    );
    return json?.choices?.[0]?.message?.content ?? '';
  }
}

/**
 * Deterministic offline backend. It does NOT simulate model judgement — it produces
 * structurally valid output derived from a hash of the input so that every downstream
 * parser, guard and aggregation runs exactly as it would in a paid run.
 *
 * Any analysis produced from mock scores is plumbing evidence, never a finding. The
 * analysis stage refuses to emit a headline number when the run is flagged `mock`.
 */
export class MockBackend implements LlmBackend {
  async complete(system: string, user: string): Promise<string> {
    const h = hash(user);
    if (/JSON function/i.test(system) && /load-bearing/i.test(system)) {
      const n = 2 + (h % 3);
      const decisions = Array.from({ length: n }, (_, i) => ({
        concept: `mock-cluster-${i + 1}`,
        summary: `Mock cluster ${i + 1} derived from a ${user.length}-char input.`,
        question: `What makes mock cluster ${i + 1} correct here?`,
      }));
      return JSON.stringify({ decisions });
    }
    if (/RECORD-SURVIVAL SCORER \(SINGLE\)/.test(system)) {
      return JSON.stringify({ rationale: 'mock rationale', score: h % 3 });
    }
    if (/RECORD-SURVIVAL SCORER/.test(system)) {
      // Emit the strict scorer schema with deterministic pseudo-scores.
      return JSON.stringify({
        A: { score: h % 3, rationale: 'mock rationale A' },
        B: { score: (h >> 3) % 3, rationale: 'mock rationale B' },
      });
    }
    return [
      '## Summary',
      '',
      `Mock synthetic description generated offline from a ${user.length}-char diff.`,
      '',
      '## Changes',
      '',
      '- Mock bullet one',
      '- Mock bullet two',
    ].join('\n');
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export type BackendRole = 'generation' | 'scoring';

/**
 * Resolve a backend from the environment.
 *
 * `STUDY_MOCK=1` forces the offline backend for both roles. Otherwise generation prefers
 * Anthropic and scoring prefers OpenAI, so the two roles land on different vendors by
 * default; either can be overridden.
 */
export function backendFor(role: BackendRole): { backend: LlmBackend; label: string; mock: boolean } {
  if (process.env.STUDY_MOCK === '1') return { backend: new MockBackend(), label: 'mock', mock: true };

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  const openaiKey = process.env.OPENAI_API_KEY?.trim();

  const genModel = process.env.STUDY_GEN_MODEL || 'claude-sonnet-5';
  const scoreModel = process.env.STUDY_SCORE_MODEL || 'gpt-5.4-mini';

  if (role === 'generation') {
    if (anthropicKey) return { backend: new AnthropicBackend(anthropicKey, genModel), label: `anthropic:${genModel}`, mock: false };
    if (openaiKey) return { backend: new OpenAiBackend(openaiKey, scoreModel), label: `openai:${scoreModel}`, mock: false };
  } else {
    if (openaiKey) return { backend: new OpenAiBackend(openaiKey, scoreModel), label: `openai:${scoreModel}`, mock: false };
    if (anthropicKey) return { backend: new AnthropicBackend(anthropicKey, genModel), label: `anthropic:${genModel}`, mock: false };
  }

  throw new Error(
    'No model credentials found. Set ANTHROPIC_API_KEY and/or OPENAI_API_KEY, ' +
      'or run with STUDY_MOCK=1 to exercise the pipeline offline.'
  );
}
