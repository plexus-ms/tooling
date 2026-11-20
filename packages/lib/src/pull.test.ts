import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from './context.ts';
import { createPull, needsAHand, pullBody, pullOf } from './pull.ts';
import { fakeIo } from './testing/fakeIo.ts';

const base = { version: '0.2.0', sites: ['.', 'apps/site'], marked: [], note: 'Opened by `plx update`.' };

test('a body that needs no hand says so first, then what the pull request is', () => {
  assert.equal(needsAHand(base), false);
  assert.equal(
    pullBody(base),
    'Nothing needs a hand: every site merged clean.\n\nPlexus 0.2.0 (§ 1.5 PLX): `copier update` at the root, `apps/site`, the lockfile where manifests moved, and the workflow refs.\n\nOpened by `plx update`.',
  );
});

test('a body that needs a hand opens with every reason, the lockfile with what to run', () => {
  const state = {
    ...base,
    conflicted: ['apps/site'],
    marked: ['apps/site/a.txt', 'mise.toml'],
    failed: ['.'],
    lockfile: true,
  };
  assert.equal(needsAHand(state), true);
  const body = pullBody(state);
  assert.match(body, /^\*\*Needs a hand\.\*\* `plx update` marks this pull request ready once/);
  assert.doesNotMatch(body, /is a draft/, 'the same body serves a pull request the forge would not make a draft');
  assert.match(body, /^- Conflicts at `apps\/site`, committed with their markers\.$/m);
  assert.match(body, /^- Files that hold conflict markers: `apps\/site\/a\.txt`, `mise\.toml`\.$/m);
  assert.match(body, /^- `copier update` failed at the root, left as it was; run it there by hand\.$/m);
  assert.match(
    body,
    /^- The lockfile did not refresh: run `pnpm install` after resolving, and commit the lockfile\.$/m,
  );
  for (const one of [{ marked: ['x'] }, { failed: ['.'] }, { lockfile: true }, { conflicted: ['.'] }])
    assert.equal(needsAHand({ ...base, ...one }), true, JSON.stringify(one));
});

test('the pull request is read from the forge as JSON in any state, the open one first; a failure to ask is an error', async () => {
  const consumer = { path: '/r', rel: 'r', branch: 'develop', sites: [] };
  const asked: string[][] = [];
  const listed = (out: string | undefined) =>
    new Context(
      {},
      fakeIo({}, () => undefined, {
        gh: (_cwd, args) => {
          asked.push(args);
          return out;
        },
      }),
    );
  const pr = (number: number, state: string, head: string, cross = false) =>
    JSON.stringify({
      url: `https://forge/o/r/pull/${number}`,
      number,
      isDraft: number === 3,
      state,
      headRefOid: head,
      isCrossRepository: cross,
    });
  assert.deepEqual(
    await pullOf(listed(`[${pr(2, 'CLOSED', 'aaa')},${pr(3, 'OPEN', 'bbb')}]`), consumer, '/r', '0.2.0'),
    {
      url: 'https://forge/o/r/pull/3',
      number: 3,
      draft: true,
      open: true,
      head: 'bbb',
    },
  );
  assert.ok(asked[0]?.includes('all'), 'every state is asked for');
  assert.equal(asked[0]?.[asked[0].indexOf('--limit') + 1], '1000', "gh's default of 30 is not relied on");
  assert.deepEqual(await pullOf(listed(`[${pr(2, 'CLOSED', 'aaa')}]`), consumer, '/r', '0.2.0', 'aaa'), {
    url: 'https://forge/o/r/pull/2',
    number: 2,
    draft: false,
    open: false,
    head: 'aaa',
  });
  assert.equal(
    await pullOf(listed(`[${pr(2, 'CLOSED', 'aaa')}]`), consumer, '/r', '0.2.0', 'ccc'),
    undefined,
    'closed at another tip: an earlier branch of the same name',
  );
  assert.equal(
    (
      await pullOf(
        listed(`[${pr(4, 'MERGED', 'aaa')},${pr(7, 'CLOSED', 'aaa')},${pr(5, 'CLOSED', 'aaa')}]`),
        consumer,
        '/r',
        '0.2.0',
        'aaa',
      )
    )?.number,
    7,
    'the highest numbered of those at the tip, whatever the order listed',
  );
  assert.equal(
    await pullOf(listed(`[${pr(9, 'OPEN', 'ddd', true)}]`), consumer, '/r', '0.2.0', 'ddd'),
    undefined,
    "a fork's branch of the same name is not ours",
  );
  assert.equal(await pullOf(listed('[]'), consumer, '/r', '0.2.0'), undefined);
  await assert.rejects(pullOf(listed('not json'), consumer, '/r', '0.2.0'), /gave no JSON/);
  await assert.rejects(pullOf(listed(undefined), consumer, '/r', '0.2.0'), /fake gh fails/);
});

test('reviewers: a comma-separated string of user logins, blank for none; a team is refused', async () => {
  const { parseReviewers, reviewersOf } = await import('./pull.ts');
  assert.deepEqual(parseReviewers(' alice, bob ,,alice', 'x'), ['alice', 'bob']);
  assert.deepEqual(parseReviewers('', 'x'), []);
  assert.throws(() => parseReviewers('alice,acme/ops', '--reviewer'), /--reviewer names `acme\/ops`, a team/);
  assert.throws(() => parseReviewers('@alice', '--reviewer'), /not a GitHub user login/);
  assert.deepEqual(reviewersOf({}), []);
  assert.deepEqual(reviewersOf({ pr_reviewers: null }), []);
  assert.deepEqual(reviewersOf({ pr_reviewers: 'alice' }), ['alice']);
  assert.deepEqual(reviewersOf({ renovate_reviewers: 'alice' }), [], 'the old name is not read');
});

test('a draft the forge refuses is asked for once more as an ordinary pull request, with the same body', async () => {
  const req = { base: 'develop', version: '0.2.0', body: 'the body', draft: true };
  const opening = (refuse: (args: string[]) => boolean) => {
    const asked: string[][] = [];
    const said: string[] = [];
    const ctx = new Context(
      {},
      fakeIo({}, () => undefined, {
        gh: (_cwd, args) => {
          asked.push(args);
          return refuse(args) ? undefined : 'https://forge/o/r/pull/1';
        },
      }),
    );
    ctx.say = (line: string) => void said.push(line);
    return { ctx, asked, said };
  };
  const offered = opening(() => false);
  assert.equal(await createPull(offered.ctx, 'r', req, '/r'), true, 'a draft where the forge offers one');
  assert.equal(offered.asked.length, 1);
  assert.ok(offered.asked[0]?.includes('--draft'));

  const refused = opening((args) => args.includes('--draft'));
  assert.equal(await createPull(refused.ctx, 'r', req, '/r'), false, 'an ordinary one where it does not');
  assert.equal(refused.asked.length, 2, 'asked once more, not by the message');
  assert.ok(!refused.asked[1]?.includes('--draft'));
  assert.equal(refused.asked[1]?.at(-1), 'the body', 'the same body');
  assert.equal(refused.said.filter((l) => /the pull request is no draft: the forge refused one/.test(l)).length, 1);

  const neither = opening(() => true);
  await assert.rejects(createPull(neither.ctx, 'r', req, '/r'), /^Error: as a draft: .+; as an ordinary one: .+/);
  assert.equal(neither.asked.length, 2);

  const ordinary = opening(() => false);
  assert.equal(await createPull(ordinary.ctx, 'r', { ...req, draft: false }, '/r'), false);
  assert.equal(ordinary.asked.length, 1, 'no draft asked for, none tried');
  assert.ok(!ordinary.asked[0]?.includes('--draft'));
});

test('a body a later run writes says what it checked at the tip, never that every site merged clean', () => {
  const later = { ...base, checked: true, note: 'rewritten' };
  assert.equal(needsAHand(later), false);
  const ready = pullBody(later);
  assert.match(
    ready,
    /^Ready for review: no tracked file holds a conflict marker, and every site's answers record 0\.2\.0\.\n\n/,
  );
  assert.doesNotMatch(ready, /merged clean/);
  assert.doesNotMatch(ready, /pnpm install/);

  const resolved = { ...later, lockfile: true };
  assert.equal(needsAHand(resolved), false, 'the lockfile instruction alone keeps a later run ready');
  assert.match(
    pullBody(resolved),
    /^Ready for review: .+\n\n- Run `pnpm install`, and commit the lockfile if it changes\.\n\n/,
  );
  assert.doesNotMatch(pullBody(resolved), /once resolved/, 'ready, nothing is left to resolve');

  const behind = { ...later, behind: ['.', 'apps/site'], lockfile: true };
  assert.equal(needsAHand(behind), true);
  const body = pullBody(behind);
  assert.match(body, /^\*\*Needs a hand\.\*\* .+ every site's answers record the version\./);
  assert.match(
    body,
    /^- The answers at the root do not record 0\.2\.0: copier did not run here\. On this branch, in the root, run `mise exec copier@[0-9.]+ -- copier update --trust --skip-answered --vcs-ref 0\.2\.0` and commit what it changes\.$/m,
  );
  assert.match(body, /^- The answers at `apps\/site` do not record 0\.2\.0:/m);
  assert.match(body, /^- Run `pnpm install` once resolved, and commit the lockfile\.$/m);
  assert.doesNotMatch(body, /did not refresh/, 'a later run does not know whether the refresh failed');
});
