import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from './context.ts';
import { needsAHand, pullBody, pullOf } from './pull.ts';
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
  assert.match(body, /^\*\*Needs a hand\.\*\* This pull request is a draft;/);
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
  const closed = '{"url":"https://forge/o/r/pull/2","number":2,"isDraft":false,"state":"CLOSED"}';
  const open = '{"url":"https://forge/o/r/pull/3","number":3,"isDraft":true,"state":"OPEN"}';
  assert.deepEqual(await pullOf(listed(`[${closed},${open}]`), consumer, '/r', '0.2.0'), {
    url: 'https://forge/o/r/pull/3',
    number: 3,
    draft: true,
    open: true,
  });
  assert.ok(asked[0]?.includes('all'), 'every state is asked for');
  assert.deepEqual(await pullOf(listed(`[${closed}]`), consumer, '/r', '0.2.0'), {
    url: 'https://forge/o/r/pull/2',
    number: 2,
    draft: false,
    open: false,
  });
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
