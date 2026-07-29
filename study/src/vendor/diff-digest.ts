/**
 * Whole-PR visibility for decompose (large-PR hardening, lever ①).
 *
 * decompose() head-truncates its input to 8000 chars. On a large PR that means it only ever
 * SEES the first few files, so the topics it generates are blind to the tail — and a reviewer
 * can pass the gate having explained the front of the diff while the rest merges unexamined.
 * The failure the reckon chunking study flagged ("strong on 2, vague on 7 → PASSED") starts
 * here: you can't gate coverage of a decision decompose never read.
 *
 * The fix keeps the SAME token budget but spends it across the ENTIRE PR instead of the first
 * 8000 chars: every changed file is represented (its path is guaranteed to appear), and each
 * file's hunks are sampled to fit. So decompose sees the shape of the whole change and its
 * clusters can span it. Small diffs (the common case) pass through untouched.
 */

const DEFAULT_BUDGET = 7500; // under decompose()'s internal 8000 slice, with headroom.

interface FileBlock {
  header: string; // the "diff --git a/… b/…" line (carries the path)
  lines: string[]; // the meaningful lines: hunk headers (@@) and changed lines (+/-)
  changed: number; // count of +/- lines (for the truncation marker)
}

function splitFiles(diff: string): FileBlock[] {
  // Split before each "diff --git" line; the first chunk (if any) is preamble we drop.
  const parts = diff.split(/\n(?=diff --git )/);
  const blocks: FileBlock[] = [];
  for (const part of parts) {
    if (!part.startsWith('diff --git ')) continue;
    const all = part.split('\n');
    const header = all[0];
    // Keep only signal: hunk headers and changed lines. Drop index/---/+++ noise to save budget
    // (the "diff --git" line already carries both paths). Keep file-op markers (new/deleted/rename)
    // since they change what the diff MEANS.
    const lines: string[] = [];
    let changed = 0;
    for (const l of all.slice(1)) {
      if (l.startsWith('@@')) lines.push(l);
      else if (l.startsWith('+') && !l.startsWith('+++')) { lines.push(l); changed++; }
      else if (l.startsWith('-') && !l.startsWith('---')) { lines.push(l); changed++; }
      else if (/^(new file|deleted file|rename (from|to)) /.test(l)) lines.push(l);
    }
    blocks.push({ header, lines, changed });
  }
  return blocks;
}

/**
 * Return a representation of `diff` that fits within `budget` chars while representing EVERY
 * file in the PR. Diffs already within budget are returned unchanged.
 */
export function diffDigest(diff: string, budget = DEFAULT_BUDGET): string {
  if (diff.length <= budget) return diff;

  const blocks = splitFiles(diff);
  if (blocks.length === 0) {
    // Unparseable as a git diff: sample both ends rather than only the head, so at least the
    // start AND end of the change are visible.
    const half = Math.floor(budget / 2) - 40;
    return `${diff.slice(0, half)}\n\n… [middle elided] …\n\n${diff.slice(-half)}`;
  }

  const preamble = `[Large PR digested to fit: ${blocks.length} files changed. Every file is listed; hunks are sampled. Treat this as the WHOLE change.]\n\n`;

  // SEP accounts for the "\n\n" between chunks; MARKER_RESERVE leaves room for the per-file
  // truncation marker so appending it can't overflow. MIN_PERFILE is the floor below which a
  // per-file chunk can't hold even the header plus the marker — at that point sampling is
  // pointless and we switch to a compact file LIST (paths only), which fits far more files.
  const SEP = 2;
  const MARKER_RESERVE = 48;
  const MIN_PERFILE = 100;
  const perFile = Math.floor((budget - preamble.length) / blocks.length) - SEP;

  if (perFile < MIN_PERFILE) {
    const paths = blocks.map((b) => b.header.replace(/^diff --git a\/(.*?) b\/.*$/, '$1'));
    const head = `[Large PR: ${blocks.length} files changed. Too large to show hunks; files only.]`;
    const lines: string[] = [head];
    let shown = 0;
    for (const p of paths) {
      // Reserve room for the trailing "… and N more" note so nothing is dropped silently.
      if ([...lines, `- ${p}`].join('\n').length > budget - 40) break;
      lines.push(`- ${p}`);
      shown++;
    }
    if (shown < paths.length) lines.push(`… and ${paths.length - shown} more files not shown`);
    return lines.join('\n');
  }

  const chunks = blocks.map((b) => {
    let chunk = b.header;
    let shown = 0;
    for (const l of b.lines) {
      if (chunk.length + l.length + 1 + MARKER_RESERVE > perFile) break;
      chunk += `\n${l}`;
      shown++;
    }
    if (shown < b.lines.length) {
      const omitted = b.changed - b.lines.slice(0, shown).filter((l) => /^[+-]/.test(l)).length;
      chunk += `\n… (${Math.max(omitted, 0)} more changed lines in this file)`;
    }
    return chunk;
  });

  const out = preamble + chunks.join('\n\n');
  // Backstop: never exceed budget even in pathological cases (a single very long path/header).
  return out.length <= budget ? out : out.slice(0, budget);
}
