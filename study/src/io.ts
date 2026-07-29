/** Filesystem helpers shared by the stages. Deliberately thin — the interesting access
 *  rules live in guard.ts, and nothing here reads diff.patch or record.md. */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PrMeta } from './types.js';

export function prDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(root, e.name))
    .sort();
}

export function readMeta(dir: string): PrMeta {
  return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as PrMeta;
}

export function readJson<T>(dir: string, file: string): T | null {
  const p = join(dir, file);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeJson(dir: string, file: string, value: unknown): void {
  writeFileSync(join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
}

export function readText(dir: string, file: string): string {
  return readFileSync(join(dir, file), 'utf8');
}

export function writeText(dir: string, file: string, value: string): void {
  writeFileSync(join(dir, file), value);
}

export function has(dir: string, file: string): boolean {
  return existsSync(join(dir, file));
}

/** Bounded-concurrency map, used by every stage that makes model calls. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}
