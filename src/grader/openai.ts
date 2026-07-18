import OpenAI from 'openai';
import type { LlmBackend } from '@reckon/core';

/**
 * The OpenAI implementation of @reckon/core's LlmBackend port. Used by grade()/gradePlan()
 * and decompose(). Cross-vendor by design: if agents write with Claude and this grades with
 * GPT, self-preference can't rubber-stamp (the "don't self-judge" property, strengthened).
 */
export class OpenAiBackend implements LlmBackend {
  private client: OpenAI;
  constructor(apiKey: string, private model = 'gpt-5.4-mini') {
    this.client = new OpenAI({ apiKey });
  }

  async complete(
    system: string,
    user: string,
    opts: { model?: string; timeoutMs?: number } = {}
  ): Promise<string> {
    const resp = await this.client.chat.completions.create(
      {
        model: opts.model || this.model,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
      { timeout: opts.timeoutMs ?? 60_000 }
    );
    return resp.choices?.[0]?.message?.content ?? '';
  }
}
