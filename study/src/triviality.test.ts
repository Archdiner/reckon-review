/**
 * Triviality tests.
 *
 * The tier that matters is `trivial`, and it exists because of one real PR the binary
 * emptyBody flag mislabelled. That case is pinned here verbatim: if a future edit to the
 * heuristic lets it drift back to `substantive`, this fails.
 *
 * The opposite direction is pinned just as hard. A tier that quietly swallows short but real
 * descriptions would exclude genuine data and bias the headline the other way, so there are
 * cases here for a terse record that DOES say something.
 *
 * Run: npx tsx src/triviality.test.ts
 */

import { classifyRecord } from './triviality.js';

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

console.log('triviality tests');

check('title alone is empty', () => {
  const r = classifyRecord('# Fix the retry loop\n');
  assert(r.tier === 'empty', `expected empty, got ${r.tier}`);
});

check('THE AIRFLOW CASE: body is title restatement plus rebase chatter', () => {
  const record = [
    '# Bring back mapped task extra links test',
    '',
    '* Bring back mapped task extra links test',
    '',
    '* rebase and fixing test',
  ].join('\n');
  const r = classifyRecord(record);
  assert(r.tier === 'trivial', `expected trivial, got ${r.tier} (novelChars=${r.novelChars})`);
});

check('pure title restatement is trivial', () => {
  const r = classifyRecord('# Update the connection pool\n\nUpdate the connection pool\n');
  assert(r.tier === 'trivial', `expected trivial, got ${r.tier}`);
});

check('process chatter alone is trivial', () => {
  const r = classifyRecord('# Add retry backoff\n\n* address review comments\n* fix lint\n* rebase\n');
  assert(r.tier === 'trivial', `expected trivial, got ${r.tier}`);
});

check('a short but real description is substantive', () => {
  const record = [
    '# Add retry backoff',
    '',
    'Connections were retried immediately, which hammered the database during a failover.',
    'This adds exponential backoff capped at 30 seconds so the pool drains instead of spinning.',
  ].join('\n');
  const r = classifyRecord(record);
  assert(r.tier === 'substantive', `expected substantive, got ${r.tier} (novelChars=${r.novelChars})`);
});

check('title restatement PLUS real content is substantive', () => {
  const record = [
    '# Bring back mapped task extra links test',
    '',
    '* Bring back mapped task extra links test',
    '',
    'The test was removed when map indexes changed shape. It is restored against the new',
    'runtime lookup, which resolves links per map index rather than from the operator.',
  ].join('\n');
  const r = classifyRecord(record);
  assert(r.tier === 'substantive', `expected substantive, got ${r.tier} (novelChars=${r.novelChars})`);
});

check('tiers nest: empty implies not substantive', () => {
  for (const rec of ['# t\n', '# t\n\n', '   \n# t\n']) {
    const r = classifyRecord(rec);
    assert(r.tier !== 'substantive', `expected non-substantive for ${JSON.stringify(rec)}, got ${r.tier}`);
  }
});

check('a long descriptive body is substantive even without headings', () => {
  const r = classifyRecord(
    '# Refactor codec resolution\n\nCodec lookup previously scanned the registry on every ' +
      'field access, which showed up as 12% of serialization time in the profiler. The map is ' +
      'now built once at schema load.'
  );
  assert(r.tier === 'substantive', `expected substantive, got ${r.tier}`);
});

console.log(failures === 0 ? '\nall triviality tests passed' : `\n${failures} test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
