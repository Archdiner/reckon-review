/**
 * Leakage control.
 *
 * The study has exactly one result worth defending, and one way to void it:
 *
 *   Stage 2 must generate questions from the DIFF ALONE. If the written description
 *   reaches the question generator, the questions get shaped by the answer, the real
 *   record scores high for a circular reason, and every number downstream is worthless.
 *
 *   Stage 4 must score from the TEXT ALONE. If the diff reaches the scorer, it answers
 *   from the code instead of judging whether the text carries the mechanism.
 *
 * The protocol says to assert this in code rather than merely intend it. This module is
 * that assertion, in two layers:
 *
 *   1. STRUCTURAL — `readDiff` and `readRecord` are the only accessors, each stage
 *      declares which it is allowed to touch, and the wrong call throws.
 *   2. TEXTUAL — before any prompt is sent, `assertNoLeak` checks that the prompt shares
 *      no long word-shingle with the text that stage is forbidden to see. This catches
 *      leakage that structural separation misses, e.g. a description quoted verbatim
 *      inside a commit message that was concatenated into the diff header.
 *
 * A tripped guard is a hard failure. It never downgrades to a warning, because a run that
 * silently continued past a leak would produce numbers indistinguishable from clean ones.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type StageAccess = 'diff-only' | 'record-only';

export class LeakageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeakageError';
  }
}

/** A handle scoped to what one stage is permitted to read. */
export class PrReader {
  constructor(private dir: string, private access: StageAccess) {}

  readDiff(): string {
    if (this.access !== 'diff-only') {
      throw new LeakageError(`stage with access=${this.access} attempted to read diff.patch in ${this.dir}`);
    }
    return readFileSync(join(this.dir, 'diff.patch'), 'utf8');
  }

  readRecord(): string {
    if (this.access !== 'record-only') {
      throw new LeakageError(`stage with access=${this.access} attempted to read record.md in ${this.dir}`);
    }
    return readFileSync(join(this.dir, 'record.md'), 'utf8');
  }
}

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'with',
  'this', 'that', 'as', 'be', 'are', 'was', 'by', 'from', 'at', 'we', 'if', 'not',
]);

/**
 * Content word-shingles for PROSE overlap detection.
 *
 * Paths and dotted identifiers act as BARRIERS: a shingle may not span one. Without that
 * rule the check is unusable, and the pilot run proved it — a diff header naming
 * `a/providers/microsoft/winrm/src/airflow/providers/microsoft/winrm/…` flattens into eight
 * consecutive content words, and any record that mentions the same file trips the guard.
 *
 * That match is not contamination. The diff contains the path by construction, and a
 * description naming the file it changed is talking about the same subject, not reusing the
 * author's prose. What the guard is looking for is the DESCRIPTION's sentences appearing in a
 * prompt that must not contain them, and sentences do not contain slashes.
 *
 * Treating paths as barriers rather than merely ignoring them matters: ignoring them would
 * splice the words on either side together and invent shingles that were never adjacent.
 *
 * LINE ENDS ARE BARRIERS TOO, and that one is load-bearing for `assertDerivedFromDiff`.
 * `diffDigest` keeps each retained line verbatim but DROPS the unchanged context lines
 * between them, so lines that were far apart in the diff end up adjacent in the digest. A
 * shingler that ran across newlines would manufacture word sequences that appear in the
 * digest and nowhere in the source, and the containment assertion would fail on every large
 * PR — which is exactly what it did before this rule. Scoping shingles to a single line
 * makes the digest a strict subset of the diff, as it actually is.
 */
function shingles(text: string, n: number): Set<string> {
  const out = new Set<string>();

  for (const line of text.split('\n')) {
    let run: string[] = [];
    const flush = () => {
      for (let i = 0; i + n <= run.length; i++) out.add(run.slice(i, i + n).join(' '));
      run = [];
    };
    for (const raw of line.split(/\s+/)) {
      // Path, dotted identifier, URL, or hash-like blob: a barrier, contributing no words.
      if (/[/\\]/.test(raw) || /\w\.\w/.test(raw) || /^[0-9a-f]{7,}$/i.test(raw)) {
        flush();
        continue;
      }
      const w = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!w || w.length <= 1 || STOP.has(w)) continue;
      run.push(w);
    }
    flush();
  }
  return out;
}

/**
 * Throw if `prompt` appears to contain material from `forbidden`.
 *
 * Uses 8-word content shingles. Shorter windows produce false positives on any change
 * whose description legitimately reuses identifiers from the code ("adds retry to
 * fetch_user"); eight consecutive non-stopword tokens in common is prose reuse, not
 * coincidence.
 *
 * `allowance` tolerates a small number of matches, defaulting to zero. Some records quote
 * a code line the diff also contains; when a caller knowingly accepts that, it must say so
 * explicitly rather than the guard guessing.
 */
export function assertNoLeak(prompt: string, forbidden: string, context: string, allowance = 0): void {
  if (!forbidden.trim()) return;
  const a = shingles(prompt, 8);
  if (a.size === 0) return;
  const b = shingles(forbidden, 8);
  const hits: string[] = [];
  for (const s of b) {
    if (a.has(s)) {
      hits.push(s);
      if (hits.length > allowance + 3) break;
    }
  }
  if (hits.length > allowance) {
    throw new LeakageError(
      `${context}: prompt shares ${hits.length} 8-word shingle(s) with text this stage must not see. ` +
        `First overlap: "${hits[0]}". This voids the reproducibility control; refusing to proceed.`
    );
  }
}

/**
 * Reject a prompt that contains raw patch syntax.
 *
 * Used by the scoring stage, where the shingle test is not applicable: the synthetic
 * description was written from the diff and therefore shares identifiers with it by
 * construction, so an overlap test would fire on every PR and measure nothing. What CAN be
 * asserted cheaply and without false positives is that no unified diff was pasted into the
 * prompt — hunk headers and `diff --git` lines do not occur in ordinary prose.
 */
export function assertNoRawDiff(prompt: string, context: string): void {
  const marker = /^diff --git |^@@ -\d+(,\d+)? \+\d+(,\d+)? @@|^index [0-9a-f]{7,}\.\.[0-9a-f]{7,}/m.exec(prompt);
  if (marker) {
    throw new LeakageError(
      `${context}: prompt contains raw diff syntax ("${marker[0].slice(0, 40)}"). ` +
        'The scorer must judge the text alone; refusing to proceed.'
    );
  }
}

/** Digest bookkeeping lines, which are inserted by diffDigest and appear in no source file. */
const DIGEST_MARKER = /elided|more changed lines in this file|^\[Large PR|more files not shown/;

const stripDigestMarkers = (s: string) =>
  s.split('\n').filter((l) => !DIGEST_MARKER.test(l)).join('\n');

/**
 * Assert that a stage-2/stage-3 prompt is derived from the diff and nothing else.
 *
 * THIS REPLACED AN EARLIER, WRONG CHECK, and the reason is worth stating because it changes
 * what the guard can honestly claim.
 *
 * The first version tested the prompt for overlap with record.md and aborted on a match. On
 * the pilot corpus it fired twice, and neither was leakage. Once on a file path present in
 * the diff header and named in the description. Once on a documentation PR whose diff ADDS
 * the very prose its description summarises.
 *
 * The check was not merely noisy, it was incapable of detecting what it claimed to. Stage 2
 * and stage 3 build their prompt BY DIGESTING diff.patch. Every token in that prompt already
 * came from the diff, so an overlap with the record can only ever mean the diff and the
 * record genuinely share content. It can never indicate the description leaking in, because
 * there is no path by which the description could get there.
 *
 * What can be asserted, and is asserted here, is the containment that actually matters: the
 * prompt is a subset of the diff. If anything ever reached that prompt from another source —
 * a concatenation bug, a stray field — it would show up as prompt text absent from the diff,
 * and this throws.
 *
 * The real leakage control remains structural: `PrReader` denies these stages any handle on
 * record.md at all. That is a property of the code paths, not of a string comparison, and it
 * is what the study's validity actually rests on.
 */
export function assertDerivedFromDiff(prDir: string, prompt: string, context: string): void {
  let diff: string;
  try {
    diff = readFileSync(join(prDir, 'diff.patch'), 'utf8');
  } catch {
    return;
  }
  const inDiff = shingles(diff, 8);
  const novel: string[] = [];
  for (const s of shingles(stripDigestMarkers(prompt), 8)) {
    if (!inDiff.has(s)) {
      novel.push(s);
      if (novel.length > 3) break;
    }
  }
  if (novel.length > 0) {
    throw new LeakageError(
      `${context} [${prDir}]: prompt contains ${novel.length}+ 8-word shingle(s) absent from the diff. ` +
        `First: "${novel[0]}". The prompt must be derived from the diff alone; refusing to proceed.`
    );
  }
}

/**
 * Measure, without judging, how much prose the diff and the written record share.
 *
 * This is the observation the discarded check was accidentally making, kept because it is
 * genuinely interesting rather than because it polices anything. A PR whose diff already
 * contains the sentences of its own description — a documentation change, a changelog entry,
 * an ADR — is one where the record is recoverable from the artifact by copying, not by
 * understanding. That is the study's thesis showing up in its most literal possible form,
 * and it is worth counting rather than aborting on.
 *
 * Reported per PR so the headline can be recomputed with these excluded, in case a reviewer
 * argues they are the only reason the synthetic description keeps up.
 */
export function measureRecordOverlap(prDir: string): { shared: number; recordShingles: number } {
  let diff = '';
  let record = '';
  try {
    diff = readFileSync(join(prDir, 'diff.patch'), 'utf8');
    record = readFileSync(join(prDir, 'record.md'), 'utf8');
  } catch {
    return { shared: 0, recordShingles: 0 };
  }
  const inDiff = shingles(diff, 8);
  const inRecord = shingles(record, 8);
  let shared = 0;
  for (const s of inRecord) if (inDiff.has(s)) shared++;
  return { shared, recordShingles: inRecord.size };
}

/**
 * Blinding. Stage 4 shows the scorer two candidate texts labelled A and B and must not
 * reveal which is the real record. The assignment is derived from a seeded hash of the PR
 * id so a run is reproducible, and is written to a separate file the scorer prompt builder
 * never reads.
 */
export function blindAssign(prId: string, seed: string): { A: 'real' | 'synthetic'; B: 'real' | 'synthetic' } {
  let h = 2166136261;
  const s = `${seed}:${prId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (Math.abs(h) & 1) === 0 ? { A: 'real', B: 'synthetic' } : { A: 'synthetic', B: 'real' };
}
