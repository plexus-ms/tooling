import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from './context.ts';
import { needsAHand, openPullOf, pullBody } from './pull.ts';
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

test('the open pull request is read from the forge as JSON: its URL, number and draft state', async () => {
  const consumer = { path: '/r', rel: 'r', branch: 'develop', sites: [] };
  const listed = (out: string) =>
    new Context(
      {},
      fakeIo({}, () => undefined, { gh: (_cwd, args) => (args.includes('list') ? out : undefined) }),
    );
  assert.deepEqual(
    await openPullOf(listed('[{"url":"https://forge/o/r/pull/3","number":3,"isDraft":true}]'), consumer, '/r', '0.2.0'),
    { url: 'https://forge/o/r/pull/3', number: 3, draft: true },
  );
  assert.equal(await openPullOf(listed('[]'), consumer, '/r', '0.2.0'), undefined);
  assert.equal(await openPullOf(listed('not json'), consumer, '/r', '0.2.0'), undefined);
});
