/**
 * Guard tests.
 *
 * A leakage control that never fires is indistinguishable from no control at all. The
 * shingle rules were loosened twice while building this (paths as barriers, then line ends
 * as barriers), each time to kill a false positive, and each loosening is a chance to have
 * quietly disabled the check. These tests pin both directions: the guard must stay silent on
 * the legitimate cases that tripped it, and must still fire on an actual leak.
 *
 * Run: npx tsx src/guard.test.ts
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PrReader, LeakageError, assertDerivedFromDiff, assertNoRawDiff,
  measureRecordOverlap, blindAssign,
} from './guard.js';

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : String(e)}`);
  }
}
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};
function throws(fn: () => void, msg: string) {
  try {
    fn();
  } catch (e) {
    if (e instanceof LeakageError) return;
    throw new Error(`${msg} (threw wrong error: ${e})`);
  }
  throw new Error(msg);
}

const dir = mkdtempSync(join(tmpdir(), 'guard-test-'));

const DIFF = [
  'diff --git a/src/pool.ts b/src/pool.ts',
  '@@ -10,7 +10,9 @@ export class Pool {',
  '-  private idle: Conn[] = [];',
  '+  private idle: Conn[] = [];',
  '+  private waiters: Array<(c: Conn) => void> = [];',
  '+  // hand the connection straight to the next waiter instead of returning it',
  '+  release(c: Conn) { const w = this.waiters.shift(); if (w) w(c); else this.idle.push(c); }',
].join('\n');

const RECORD = [
  '# Hand released connections directly to waiters',
  '',
  'Returning the connection to the idle list first meant a waiter could lose the',
  'race to a fresh caller and starve under sustained load, so release now passes',
  'the connection straight to the head of the waiter queue.',
].join('\n');

writeFileSync(join(dir, 'diff.patch'), DIFF);
writeFileSync(join(dir, 'record.md'), RECORD);

console.log('guard tests');

check('diff-only reader can read the diff', () => {
  assert(new PrReader(dir, 'diff-only').readDiff().includes('waiters'), 'diff not readable');
});

check('diff-only reader is denied the record', () => {
  throws(() => new PrReader(dir, 'diff-only').readRecord(), 'reader should have refused record.md');
});

check('record-only reader is denied the diff', () => {
  throws(() => new PrReader(dir, 'record-only').readDiff(), 'reader should have refused diff.patch');
});

check('a prompt that is the diff passes containment', () => {
  assertDerivedFromDiff(dir, DIFF, 'test');
});

check('a digest that drops context lines still passes containment', () => {
  // Mimics diffDigest: keep changed lines, drop the rest, so distant lines become adjacent.
  const digest = DIFF.split('\n').filter((l) => /^[+-@]/.test(l)).join('\n');
  assertDerivedFromDiff(dir, digest, 'test');
});

check('THE REAL LEAK: record prose spliced into the prompt is caught', () => {
  throws(
    () => assertDerivedFromDiff(dir, `${DIFF}\n${RECORD}`, 'test'),
    'guard failed to catch the description leaking into a diff-derived prompt'
  );
});

check('a shared file path alone does NOT trip containment', () => {
  // The false positive that broke the first design: path in both diff and record.
  writeFileSync(join(dir, 'record.md'), `${RECORD}\n\nSee src/pool.ts for the change.`);
  assertDerivedFromDiff(dir, DIFF, 'test');
  writeFileSync(join(dir, 'record.md'), RECORD);
});

check('raw diff syntax in a scorer prompt is rejected', () => {
  throws(() => assertNoRawDiff(`QUESTION: why?\n${DIFF}`, 'test'), 'raw diff not rejected');
});

check('ordinary prose passes the scorer check', () => {
  assertNoRawDiff(`QUESTION: why?\nTEXT:\n${RECORD}`, 'test');
});

check('record/diff overlap is measured, not thrown', () => {
  const clean = measureRecordOverlap(dir);
  assert(clean.recordShingles > 0, 'expected the record to produce shingles');
  assert(clean.shared === 0, `independent prose should not overlap, got ${clean.shared}`);

  // A docs-style PR whose diff contains the description's own sentences.
  writeFileSync(join(dir, 'diff.patch'), `${DIFF}\n+${RECORD.split('\n')[2]}`);
  const copied = measureRecordOverlap(dir);
  assert(copied.shared > 0, 'expected copied prose to be detected as overlap');
  writeFileSync(join(dir, 'diff.patch'), DIFF);
});

check('blinding is deterministic and assigns both roles', () => {
  const a = blindAssign('repo__1', 'seed');
  assert(a.A !== a.B, 'A and B must differ');
  assert(blindAssign('repo__1', 'seed').A === a.A, 'assignment must be reproducible');
  const flips = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((i) => blindAssign(`repo__${i}`, 'seed').A);
  assert(new Set(flips).size === 2, 'assignment must vary across PRs, not be constant');
});

rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nall guard tests passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
