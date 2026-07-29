/**
 * Parser tests.
 *
 * The parser is the one place where a silent bug produces a plausible map. A body containing a
 * tab or a newline is not an edge case — it is what a well-written commit message looks like,
 * which means a naive parser loses exactly the commits the record dimension is about, and loses
 * them in the direction that flatters the repository.
 */

import { parseLog, resolveRenamePath, hasAgentTrailer } from './gitlog.js';

let failures = 0;
function ok(name: string, cond: boolean) {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const REC = '\x1e';
const U = '\x1f';

function entry(sha: string, name: string, email: string, date: string, subject: string, body: string, stats: string[]) {
  return `${REC}${sha}${U}${name}${U}${email}${U}${date}${U}${subject}${U}${body}\n${stats.join('\n')}`;
}

console.log('gitlog tests');

{
  const raw = entry('abc123', 'Ada', 'ada@x.com', '2026-01-15T10:00:00+00:00', 'Fix the thing', 'Because it was broken.', [
    '10\t2\tsrc/a.ts',
    '0\t5\tsrc/b.ts',
  ]);
  const [c] = parseLog(raw);
  ok('parses a plain commit', c?.sha === 'abc123' && c?.subject === 'Fix the thing');
  ok('parses the body', c?.body === 'Because it was broken.');
  ok('parses numstat', c?.files.length === 2 && c?.files[0]?.added === 10 && c?.files[1]?.deleted === 5);
  ok('parses the date', c?.at === Date.parse('2026-01-15T10:00:00+00:00'));
}

{
  // THE CASE THAT BREAKS A NAIVE PARSER: a multi-line body containing a tab.
  const body = 'Line one.\n\nLine two with a\ttab in it.\n\n- a bullet\n- another';
  const raw = entry('def456', 'Ada', 'ada@x.com', '2026-01-15T10:00:00Z', 'Subject', body, ['3\t1\tsrc/c.ts']);
  const [c] = parseLog(raw);
  ok('THE MULTILINE BODY CASE: body with newlines and a tab survives intact', c?.body === body);
  ok('the numstat after a multiline body is still found', c?.files.length === 1 && c?.files[0]?.path === 'src/c.ts');
}

{
  const raw =
    entry('a1', 'A', 'a@x.com', '2026-01-01T00:00:00Z', 's1', 'b1', ['1\t1\tp1']) +
    entry('a2', 'B', 'b@x.com', '2026-01-02T00:00:00Z', 's2', 'b2\nmore', ['2\t2\tp2']);
  const cs = parseLog(raw);
  ok('parses several commits', cs.length === 2 && cs[1]?.sha === 'a2');
}

{
  const raw = entry('bin1', 'A', 'a@x.com', '2026-01-01T00:00:00Z', 's', '', ['-\t-\tlogo.png']);
  const [c] = parseLog(raw);
  ok('binary files are kept with zero weight, not dropped', c?.files.length === 1 && c?.files[0]?.added === 0);
}

{
  const raw = entry('e1', 'A', 'a@x.com', '2026-01-01T00:00:00Z', 's', '', []);
  const [c] = parseLog(raw);
  ok('a commit with no numstat still parses', c?.sha === 'e1' && c?.files.length === 0);
}

ok('rename: brace form resolves to the new path', resolveRenamePath('src/{old => new}/file.ts') === 'src/new/file.ts');
ok('rename: leading brace form resolves', resolveRenamePath('{a => b}/file.ts') === 'b/file.ts');
ok('rename: arrow form resolves', resolveRenamePath('old/path.ts => new/path.ts') === 'new/path.ts');
ok('rename: a plain path is untouched', resolveRenamePath('src/a.ts') === 'src/a.ts');
ok('rename: empty brace side collapses cleanly', resolveRenamePath('src/{ => nested}/f.ts') === 'src/nested/f.ts');

ok('agent trailer detected', hasAgentTrailer('subject\n\nCo-authored-by: Claude <noreply@anthropic.com>'));
ok('agent footer detected', hasAgentTrailer('subject\n\n🤖 Generated with Claude Code'));
ok('a human co-author is not an agent trailer', !hasAgentTrailer('subject\n\nCo-authored-by: Ada <ada@x.com>'));
ok('prose mentioning an agent is not a trailer', !hasAgentTrailer('Rewrite the claude client timeout handling'));

console.log(failures === 0 ? '\nall gitlog tests passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
