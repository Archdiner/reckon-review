/**
 * Identity tests.
 *
 * Two directions, both load-bearing. Under-merging invents a bus factor and sends a false alarm
 * to a customer. Over-merging on a generic display name collapses a team into one contributor.
 * Both would be reported as risk with a straight face.
 */

import { isBot, normalizeEmail, normalizeName, resolveIdentities } from './identity.js';
import type { Commit } from './types.js';

let failures = 0;
function ok(name: string, cond: boolean) {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

function commit(name: string, email: string, at = 0): Commit {
  return {
    sha: `${name}-${email}-${at}`,
    authorName: name,
    authorEmail: email,
    at,
    subject: 's',
    body: '',
    files: [],
    agentTrailer: false,
    bot: false,
  };
}

console.log('identity tests');

ok('github noreply drops the numeric user id', normalizeEmail('1234+octo@users.noreply.github.com') === 'gh:octo');
ok('github noreply without an id normalises the same', normalizeEmail('octo@users.noreply.github.com') === 'gh:octo');
ok('subaddressing is stripped', normalizeEmail('first.last+gh@example.com') === 'first.last@example.com');
ok('case is not meaningful', normalizeEmail('First.Last@Example.COM') === 'first.last@example.com');
ok('name normalisation keeps apostrophes', normalizeName("  O'Brien  Ada ") === "o'brien ada");

ok('dependabot is a bot by email', isBot('dependabot', 'support@dependabot.com'));
ok('renovate is a bot by name', isBot('renovate[bot]', 'bot@renovateapp.com'));
ok('github actions is a bot', isBot('github-actions[bot]', 'actions@github.com'));
ok('a person named Robert is not a bot', !isBot('Robert Bottomley', 'rob@example.com'));
ok('a person is not a bot merely for having a name', !isBot('Ada Lovelace', 'ada@example.com'));

{
  // THE ALIASING CASE: one person, three addresses, linked through the display name.
  const commits = [
    commit('Ada Lovelace', 'ada@work.com'),
    commit('Ada Lovelace', 'ada@personal.dev'),
    commit('Ada Lovelace', '99+ada@users.noreply.github.com'),
  ];
  const r = resolveIdentities(commits);
  const keys = new Set(commits.map((c) => r.keyFor(c.authorName, c.authorEmail)));
  ok('THE ALIASING CASE: three addresses, one display name, one identity', keys.size === 1);
  ok('resolution reports the merge', r.before === 3 && r.after === 1);
}

{
  // The safety valve: a generic display name must NOT merge two different people.
  const commits = [commit('root', 'alice@example.com'), commit('root', 'bob@example.com')];
  const r = resolveIdentities(commits);
  const keys = new Set(commits.map((c) => r.keyFor(c.authorName, c.authorEmail)));
  ok('a generic display name does not collapse two people', keys.size === 2);
}

{
  const commits = [commit('Ada Lovelace', 'ada@work.com'), commit('Grace Hopper', 'grace@work.com')];
  const r = resolveIdentities(commits);
  const keys = new Set(commits.map((c) => r.keyFor(c.authorName, c.authorEmail)));
  ok('two distinct people stay distinct', keys.size === 2);
}

{
  const r = resolveIdentities([commit('Ada Lovelace', 'ada@work.com')]);
  const key = r.keyFor('Ada Lovelace', 'ada@work.com');
  ok('the key carries no name', !key.toLowerCase().includes('ada'));
  ok('the key carries no address', !key.includes('@') && !key.includes('work'));
  ok('the key is stable across calls', key === r.keyFor('Ada Lovelace', 'ada@work.com'));
}

console.log(failures === 0 ? '\nall identity tests passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
