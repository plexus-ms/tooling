import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MAX_AGE, maxAgeOf, needOf, parseMaxAge, type Release } from './need.ts';

const releases: Release[] = [
  { version: '0.3.0', published: '2026-02-25T10:00:00Z' },
  { version: '0.1.0', published: '2026-01-01T10:00:00Z' },
  { version: '0.2.0', published: '2026-02-10T10:00:00Z' },
];
const on = (day: string) => new Date(`${day}T12:00:00Z`);
const base = { recorded: ['0.1.0'], releases, maxAge: 30, now: on('2026-03-01') };
const cut = (version: string, day: string): Release => ({ version, published: `${day}T10:00:00Z` });

test('a pending minor rests while the oldest version not taken is younger than the interval', () => {
  assert.deepEqual(needOf(base), {
    take: false,
    why: '2 newer versions, the oldest (0.2.0) cut 19 days ago; the interval is 30 days',
  });
  assert.deepEqual(needOf({ ...base, recorded: ['0.3.0'] }), { take: false, why: 'no version newer than 0.3.0' });
});

test('a pending minor is taken once the oldest version not taken is as old as the interval: the newest, in one pull', () => {
  const due = needOf({ ...base, now: on('2026-03-12') });
  assert.deepEqual(due, {
    take: true,
    version: '0.3.0',
    why: '0.2.0, the oldest version not taken, was cut 30 days ago (interval: 30 days; 2 newer versions)',
  });
  // On 0.2.0 only 0.3.0 is not taken, and it is 15 days old.
  assert.equal(needOf({ ...base, recorded: ['0.2.0'], now: on('2026-03-12') }).take, false);
});

test('the default interval is a week', () => {
  const week = { recorded: ['0.1.0'], releases: [cut('0.1.0', '2026-01-01'), cut('0.2.0', '2026-02-20')] };
  const at = (day: string) => needOf({ ...week, maxAge: DEFAULT_MAX_AGE, now: on(day) }).take;
  assert.equal(at('2026-02-26'), false, 'six days');
  assert.equal(at('2026-02-27'), true, 'seven days');
});

test('the site furthest behind is the one the repo is measured by', () => {
  const need = needOf({ ...base, recorded: ['0.3.0', '0.1.0'], now: on('2026-03-12') });
  assert.equal(need.take, true);
  assert.equal(needOf({ ...base, recorded: ['0.3.0', '0.2.0'], now: on('2026-03-12') }).take, false);
});

test('an interval of zero takes every version', () => {
  assert.deepEqual(needOf({ ...base, maxAge: 0, now: on('2026-02-25') }), {
    take: true,
    version: '0.3.0',
    why: 'an interval of zero takes every version (2 newer versions)',
  });
  assert.equal(needOf({ ...base, maxAge: 0, recorded: ['0.3.0'] }).take, false, 'nothing newer, nothing to take');
});

test('a pending patch is taken at once, and with it the newest of the major', () => {
  const hotfix = [cut('0.1.0', '2026-01-01'), cut('0.1.1', '2026-02-28'), cut('0.2.0', '2026-02-28')];
  // A hotfix of the minor line the repo is on, a day old: the newest of the major comes with it.
  assert.deepEqual(needOf({ ...base, releases: hotfix }), {
    take: true,
    version: '0.2.0',
    why: '0.1.1 is a hotfix, taken at once (2 newer versions)',
  });
  // The newest of the major is a patch release: taken at once.
  const newest = [cut('0.1.0', '2026-01-01'), cut('0.2.0', '2026-02-28'), cut('0.2.1', '2026-02-28')];
  assert.deepEqual(needOf({ ...base, releases: newest }), {
    take: true,
    version: '0.2.1',
    why: '0.2.1 is a hotfix, taken at once (2 newer versions)',
  });
});

test('a hotfix of a minor line the repo never had, under a newer minor, does not hurry it', () => {
  const older = [
    cut('0.1.0', '2026-01-01'),
    cut('0.2.0', '2026-02-27'),
    cut('0.2.1', '2026-02-28'),
    cut('0.3.0', '2026-02-28'),
  ];
  assert.deepEqual(needOf({ ...base, releases: older }), {
    take: false,
    why: '3 newer versions, the oldest (0.2.0) cut 2 days ago; the interval is 30 days',
  });
});

test('a pending major is not taken unasked: it is named, and the repo goes on within its own major', () => {
  const major = [cut('0.1.0', '2026-01-01'), cut('1.0.0', '2026-01-10')];
  assert.deepEqual(needOf({ ...base, releases: major }), {
    take: false,
    why: '1.0.0 is a new major, taken only when asked',
  });
  // A minor of the repo's major past the interval is taken, and the major named beside it.
  const both = [...major, cut('0.2.0', '2026-01-05'), cut('1.1.0', '2026-02-01')];
  assert.deepEqual(needOf({ ...base, releases: both }), {
    take: true,
    version: '0.2.0',
    why: '0.2.0, the oldest version not taken, was cut 55 days ago (interval: 30 days; 1 newer version)',
    held: '1.1.0 is a new major, taken only when asked',
  });
  // So is a hotfix; and a repo at the newest of its major rests on it.
  const fix = [...major, cut('0.1.1', '2026-02-28')];
  assert.equal(needOf({ ...base, releases: fix }).take && needOf({ ...base, releases: fix }).version, '0.1.1');
  assert.deepEqual(needOf({ ...base, releases: both, recorded: ['0.2.0'] }), {
    take: false,
    why: '1.1.0 is a new major, taken only when asked',
  });
});

test('a site that records no version is brought onto the newest one', () => {
  assert.match(needOf({ ...base, recorded: ['0.3.0', 'a1b2c3d'] }).why, /a site records 'a1b2c3d', not a version/);
  const none = needOf({ ...base, recorded: [undefined] });
  assert.equal(none.take && none.version, '0.3.0');
  assert.match(none.why, /a site records no version/);
});

test('the interval of a repo is its answer, 7 days when the answers do not say', () => {
  assert.equal(maxAgeOf({}), DEFAULT_MAX_AGE);
  assert.equal(DEFAULT_MAX_AGE, 7);
  assert.equal(maxAgeOf({ update_max_age: 30 }), 30);
  assert.equal(maxAgeOf({ update_max_age: '0' }), 0);
  assert.throws(() => maxAgeOf({ update_max_age: -1 }), /not a whole number of days/);
  assert.throws(() => parseMaxAge('1.5', '--max-age'), /--max-age is '1.5', not a whole number of days/);
});

// The versions of the consolidated layout up to 2026-11-10, as the forge dates
// them; the 14 from 2026-11-01 on each opened a pull request in every
// consumer. plexus-ms/libraries had no change of its own in that time.
const NOVEMBER: Release[] = [
  ['0.100.0', '2026-10-31T19:14:26Z'],
  ['0.101.0', '2026-10-31T20:16:18Z'],
  ['0.102.0', '2026-10-31T21:43:50Z'],
  ['0.103.0', '2026-11-01T19:11:44Z'],
  ['0.104.0', '2026-11-01T20:47:11Z'],
  ['0.105.0', '2026-11-01T22:58:54Z'],
  ['0.106.0', '2026-11-05T10:51:34Z'],
  ['0.106.1', '2026-11-05T14:47:24Z'],
  ['0.107.0', '2026-11-05T15:55:28Z'],
  ['0.108.0', '2026-11-05T22:17:08Z'],
  ['0.109.0', '2026-11-05T22:53:37Z'],
  ['0.110.0', '2026-11-06T12:12:12Z'],
  ['0.111.0', '2026-11-08T09:37:08Z'],
  ['0.112.0', '2026-11-08T17:41:11Z'],
  ['0.113.0', '2026-11-09T14:56:31Z'],
  ['0.114.0', '2026-11-09T20:43:27Z'],
  ['0.115.0', '2026-11-10T17:31:32Z'],
].map(([version = '', published = '']) => ({ version, published }));

test('replay: a quiet repo on 0.102.0 takes the versions of 2026-11-01 to 2026-11-10 in one pull, a week on', () => {
  const daily = (from: string, days: number) =>
    Array.from({ length: days }, (_, i) => new Date(Date.parse(`${from}T06:23:00Z`) + i * 86_400_000));
  let current = '0.102.0';
  const pulls: string[] = [];
  for (const now of daily('2026-11-01', 10)) {
    const releases = NOVEMBER.filter((r) => Date.parse(r.published) <= now.getTime());
    const need = needOf({ recorded: [current], releases, maxAge: DEFAULT_MAX_AGE, now });
    if (!need.take) continue;
    current = need.version;
    pulls.push(`${now.toISOString().slice(0, 10)} ${need.version}`);
  }
  // 0.103.0 was cut on 2026-11-01 in the evening: the scheduled run of 2026-11-09 is the first a week past it.
  // 0.106.1 repaired a minor line the repo never had, and was not the newest for long: it hurried nothing.
  assert.deepEqual(pulls, ['2026-11-09 0.112.0']);
});
