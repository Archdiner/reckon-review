/**
 * Vendored-file drift check.
 *
 * The map reuses the study's exclusion patterns, its record classifier and its model backends
 * so the two artifacts cannot disagree about what counts as machine-maintained code, what
 * counts as a written record, or which model produced a number. Copies that quietly drift
 * would break exactly that guarantee, and would break it invisibly — the map would keep
 * producing numbers, and they would stop meaning what the calibration says they mean.
 *
 * In a standalone checkout the originals are absent. That is reported as unverifiable rather
 * than failing, because a customer running the extracted tool has no study to compare against
 * and should not see a red test for it.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const STUDY = join(ROOT, '..', 'study');

const PAIRS: [copy: string, original: string][] = [
  [join(HERE, 'vendor', 'exclusions.ts'), join(STUDY, 'src', 'exclusions.ts')],
  [join(HERE, 'vendor', 'triviality.ts'), join(STUDY, 'src', 'triviality.ts')],
  [join(HERE, 'vendor', 'backends.ts'), join(STUDY, 'src', 'backends.ts')],
  [join(HERE, 'vendor', 'diff-digest.ts'), join(STUDY, 'src', 'vendor', 'diff-digest.ts')],
  [join(HERE, 'vendor', 'guard.ts'), join(STUDY, 'src', 'guard.ts')],
  [join(ROOT, 'vendor', 'reckon-core-0.5.0.tgz'), join(STUDY, 'vendor', 'reckon-core-0.5.0.tgz')],
];

const digest = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12);

let failures = 0;
let unverifiable = 0;

console.log('vendored-file drift check');
for (const [copy, original] of PAIRS) {
  const name = copy.replace(`${ROOT}/`, '');
  if (!existsSync(copy)) {
    console.log(`  FAIL  ${name}: the copy is missing`);
    failures++;
    continue;
  }
  if (!existsSync(original)) {
    console.log(`  --    ${name}: original not present (standalone checkout), unverifiable`);
    unverifiable++;
    continue;
  }
  const a = digest(copy);
  const b = digest(original);
  if (a === b) {
    console.log(`  ok    ${name}: matches the study (${a})`);
  } else {
    console.log(`  FAIL  ${name}: DRIFTED — copy ${a}, original ${b}`);
    failures++;
  }
}

if (unverifiable > 0) console.log(`\n${unverifiable} file(s) unverifiable in this checkout.`);
console.log(failures === 0 ? 'vendored files ok' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
