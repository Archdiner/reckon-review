/**
 * Tests for the data pack, which is mostly tests for a hand-rolled CSV parser.
 *
 * WHY THAT PARSER IS WORTH TESTING THIS HARD. It reads `per-question-scores.csv`, whose two
 * rationale columns are the scorer's prose — commas, quotes, and the occasional newline. A parser
 * that mishandles any of those does not throw: it shifts every column after the offending field, so
 * `real_score` starts reading text and `synthetic_score` starts reading a fragment of a sentence.
 * The output is a CSV full of plausible numbers that are silently wrong, and nothing downstream can
 * detect it. The first version of the reader refused quoted files outright, which was honest but left
 * the study's richest file unexported.
 *
 * The second thing under test is the MISSING-IS-BLANK rule. An unmeasured value and a value measured
 * as zero are different facts, and a writer that emits `0` for both destroys the difference beyond
 * recovery — the reader cannot tell which it was looking at.
 */

import { parseCsv, toCsv } from './datapack.js';
import { formatRecordSweepReport, type RecordSweepRow } from './recordsweep.js';

let failures = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ok    ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}
const eq = (name: string, got: unknown, want: unknown): void =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log('CSV parsing: the plain cases');
eq('one row', parseCsv('a,b,c\n'), [['a', 'b', 'c']]);
eq('two rows', parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
eq('no trailing newline', parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
eq('empty fields are preserved', parseCsv('a,,c\n'), [['a', '', 'c']]);
eq('a trailing empty field is preserved', parseCsv('a,b,\n'), [['a', 'b', '']]);
eq('CRLF line endings', parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
eq('a blank line is not a record', parseCsv('a,b\n1,2\n\n'), [['a', 'b'], ['1', '2']]);

console.log('\nCSV parsing: the cases that silently corrupt a naive split');
eq('a comma inside a quoted field', parseCsv('a,"b,c",d\n'), [['a', 'b,c', 'd']]);
eq('a doubled quote is one quote', parseCsv('a,"say ""hi""",c\n'), [['a', 'say "hi"', 'c']]);
eq('a newline inside a quoted field', parseCsv('a,"line1\nline2",c\n'), [['a', 'line1\nline2', 'c']]);
eq('quotes around an empty field', parseCsv('a,"",c\n'), [['a', '', 'c']]);
eq('a quoted field at end of row', parseCsv('a,"b,c"\n1,2\n'), [['a', 'b,c'], ['1', '2']]);
eq(
  'several quoted fields in one row',
  parseCsv('"a,1","b""2","c\nd"\n'),
  [['a,1', 'b"2', 'c\nd']]
);
{
  // THE REGRESSION THAT MATTERS: a rationale-shaped field must not shift the columns after it.
  const line = 'id1,repo,human,"The record says \'retry\', but does not say why 3s, so partial.",1,2\n';
  const rows = parseCsv(`id,repo,provenance,rationale,real_score,synthetic_score\n${line}`);
  eq('a prose field does not shift the numeric columns after it', rows[1]!.slice(4), ['1', '2']);
  ok('and the row has the right field count', rows[1]!.length === 6, `${rows[1]!.length}`);
}

console.log('\nCSV writing: missing is blank, never zero');
{
  const out = toCsv(['a', 'b', 'c', 'd'], [[1, null, undefined, 0]]);
  const body = out.split('\n')[1];
  eq('null and undefined write empty, 0 writes 0', body, '1,,,0');
  const back = parseCsv(out);
  eq('and it round-trips as empty rather than zero', back[1], ['1', '', '', '0']);
  ok(
    'an empty field is distinguishable from a zero after a round trip',
    back[1]![1] !== back[1]![3],
    'a reader could not tell "not measured" from "measured as nothing"'
  );
}
{
  const out = toCsv(['a', 'b'], [['has,comma', 'has"quote']]);
  eq('a comma is quoted on the way out', parseCsv(out)[1]![0], 'has,comma');
  eq('a quote is doubled on the way out', parseCsv(out)[1]![1], 'has"quote');
  const nl = toCsv(['a'], [['line1\nline2']]);
  eq('a newline survives a round trip', parseCsv(nl)[1]![0], 'line1\nline2');
}
{
  // Round-trip in a TWO-column frame. One column cannot be used here, and the reason is a real
  // limitation rather than a test detail: a row holding a single empty field serialises to an empty
  // line, and an empty line is indistinguishable from a blank separator line. RFC 4180 does not
  // resolve that ambiguity and neither can any reader; the parser drops blank lines, which is the
  // standard treatment. It costs nothing here because no file in the pack is single-column — asserted
  // below rather than assumed.
  const round = (v: string): string => parseCsv(toCsv(['x', 'y'], [[v, 'z']]))[1]![0]!;
  for (const v of ['plain', 'a,b', 'a"b', 'a\nb', '', '  spaced  ', '"leading', 'trailing"']) {
    ok(`round-trips ${JSON.stringify(v)}`, round(v) === v, `got ${JSON.stringify(round(v))}`);
  }
  eq('a row of nothing but empty fields survives', parseCsv('a,b,c\n,,\n')[1], ['', '', '']);
  eq('an empty leading field survives', parseCsv('a,b\n,2\n')[1], ['', '2']);
  eq(
    'THE LIMITATION, asserted: a lone empty field is read as a blank line and dropped',
    parseCsv('x\n\n'),
    [['x']]
  );
}

console.log('\nthe sweep report pools by QUESTION, not by repository average');
{
  // Two repositories, deliberately unequal in size. A mean of the two rates would be 45%; the
  // question-weighted pool is 18/110 = 16.4%. Averaging rates over repositories would let a tiny
  // repository count as much as a huge one, which is the classic way to publish a wrong headline.
  const rows: RecordSweepRow[] = [
    { repo: 'big/one', spec: 'big/one', status: 'scored', overallRate: 0.1, explicit: 10, questions: 100, regionsScored: 20, colouredCells: 20, regionsDropped: 5, substantiveBodyShare: 0.5 },
    { repo: 'small/two', spec: 'small/two', status: 'scored', overallRate: 0.8, explicit: 8, questions: 10, regionsScored: 4, colouredCells: 4, regionsDropped: 0, substantiveBodyShare: 0.9 },
    { repo: 'squashy/three', spec: 'squashy/three', status: 'refused', substantiveBodyShare: 0.03 },
    { repo: 'gone/four', spec: 'gone/four', status: 'failed', reason: 'clone failed' },
  ];
  const md = formatRecordSweepReport(rows);
  ok('pools by question: 18/110 = 16.4%', md.includes('16.4% of 110'), md.split('\n').find((l) => l.includes('Pooled')) ?? '');
  ok('does not report the mean of the rates (45%)', !md.includes('45.0%'));
  ok('counts the three statuses separately', md.includes('2 scored, 1 refused by the body-density gate, 1 not measured'));
  ok('names the refused repository', md.includes('squashy/three'));
  ok('says a refusal is the correct output', /correct output/i.test(md));
  ok('reports the between-repository spread', md.includes('10.0% to 80.0%'));
  ok('reports areas not scored, so a top slice is not read as a whole tree', md.includes('| 5 |'));
  ok('states the sampling-depth trade-off with its measured basis', md.includes('82%'));
  ok('no email-shaped string', !/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(md));
}

console.log('');
if (failures > 0) {
  console.log(`${failures} data-pack test(s) failed`);
  process.exit(1);
}
console.log('all data-pack tests passed');
