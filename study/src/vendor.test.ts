/**
 * Drift check for the vendored product files.
 *
 * `study/` is self-contained so it can be extracted into its own repository, which means it
 * carries copies of `diff-digest.ts` and the `@reckon/core` tarball rather than importing
 * them across the repo. Copies drift. The study's claim that it measures the world with the
 * instrument Reckon actually ships is only true while they do not.
 *
 * So: when the product source is present (running inside the monorepo), every copy is
 * compared byte-for-byte against its original and any difference fails. When it is absent
 * (running as an extracted standalone repo) the file is reported unverifiable and skipped,
 * because there is nothing to compare against and refusing to run would be useless.
 *
 * Run: npx tsx src/vendor.test.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const studyRoot = join(here, '..');
const productRoot = join(studyRoot, '..');

interface VendoredFile {
  label: string;
  copy: string;
  original: string;
}

const FILES: VendoredFile[] = [
  {
    label: 'diff-digest.ts',
    copy: join(here, 'vendor', 'diff-digest.ts'),
    original: join(productRoot, 'src', 'diff-digest.ts'),
  },
  {
    label: 'reckon-core-0.5.0.tgz',
    copy: join(studyRoot, 'vendor', 'reckon-core-0.5.0.tgz'),
    original: join(productRoot, 'vendor', 'reckon-core-0.5.0.tgz'),
  },
];

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

let failures = 0;
let skipped = 0;

console.log('vendored-file drift check');

for (const f of FILES) {
  if (!existsSync(f.copy)) {
    failures++;
    console.log(`  FAIL  ${f.label}: vendored copy missing at ${f.copy}`);
    continue;
  }
  if (!existsSync(f.original)) {
    skipped++;
    console.log(`  skip  ${f.label}: product source not present (standalone checkout) — unverifiable`);
    continue;
  }
  const a = sha(f.copy);
  const b = sha(f.original);
  if (a === b) {
    console.log(`  ok    ${f.label}: matches product (${a.slice(0, 12)})`);
  } else {
    failures++;
    console.log(
      `  FAIL  ${f.label}: DRIFTED from the product.\n` +
        `        copy     ${a}\n` +
        `        product  ${b}\n` +
        `        The study claims to use the instrument production ships. Re-copy the file,\n` +
        `        or that claim is false. See src/vendor/PROVENANCE.md.`
    );
  }
}

if (skipped > 0) {
  console.log(`\n${skipped} file(s) unverifiable in a standalone checkout; this is expected outside the monorepo.`);
}
console.log(failures === 0 ? 'vendored files ok' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
