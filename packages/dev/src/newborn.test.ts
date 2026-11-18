import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@plexus-ms/lib';
import { parseVerifyLog, preflightNewborns } from './newborn.ts';
import { fakeIo, type Tree } from './testing/fakeIo.ts';
import type { Versioned } from './version.ts';

const versioned: Versioned = {
  repos: [
    { name: 'template-repo-turbo', path: '/t1', latest: '0.1.0', pending: [] },
    { name: 'template-repo-operations', path: '/t2', latest: '0.1.0', pending: [] },
  ],
  skew: false,
};

/** A newborn as the fake tree holds it: a git repo with a marker and every contract verb. */
const NEWBORN: Tree = { '.git': {}, 'PLEXUS.md': '---\n---\n\n- A newborn.\n' };
const tasks = (cwd: string) =>
  JSON.stringify(
    ['dev', 'build', 'verify', 'lint', 'check', 'test'].map((name) => ({ name, source: `${cwd}/mise.toml` })),
  );

test("a newborn test's output: the step it stopped in, the lines that say why, and where it left the newborns", () => {
  // The shape of the app template's output when next typegen finds no app directory.
  const log = [
    '→ repo: render ../template-repo-turbo at HEAD',
    '→ apps/stateless-app: render',
    '→ repo: check',
    '[//:install] $ pnpm install',
    '[//:check] $ turbo run check',
    '@acme/stateless-app:check: $ next typegen && tsc --noEmit',
    '@acme/stateless-app:check: > Unexpected error while generating route types. Original error:',
    "@acme/stateless-app:check: Error: > Couldn't find any `pages` or `app` directory.",
    '@acme/stateless-app:check:     at ignore-listed frames',
    '@acme/stateless-app:check: [ELIFECYCLE] Command failed with exit code 1.',
    ' Tasks:    0 successful, 1 total',
    'Failed:    @acme/stateless-app#check',
    '[//:check] ERROR task failed',
    'kept: /tmp/newborn.abc/acme',
    '[check] ERROR task failed',
    '[verify] ERROR task failed',
    '',
  ].join('\n');
  assert.deepEqual(parseVerifyLog(log), {
    step: { shape: 'repo', what: 'check' },
    kept: '/tmp/newborn.abc/acme',
    cause: [
      '@acme/stateless-app:check: > Unexpected error while generating route types. Original error:',
      "@acme/stateless-app:check: Error: > Couldn't find any `pages` or `app` directory.",
      '@acme/stateless-app:check: [ELIFECYCLE] Command failed with exit code 1.',
      'Failed:    @acme/stateless-app#check',
    ],
  });
});

test('a failure whose output names no error is quoted by its last lines; a test that kept nothing names no directory', () => {
  const log = ['→ app: render', '→ app: lint', 'something went sideways', ''].join('\n');
  assert.deepEqual(parseVerifyLog(log), {
    step: { shape: 'app', what: 'lint' },
    cause: ['→ app: render', '→ app: lint', 'something went sideways'],
  });
  assert.deepEqual(parseVerifyLog(''), { cause: [] });
});

test('without a scratch directory from mktemp the newborn tests are not run', async () => {
  for (const made of ['', 'relative', '/not/there']) {
    let ran = false;
    const io = fakeIo({}, () => '', {
      mktemp: () => made,
      sh: () => {
        ran = true;
        return '';
      },
    });
    await assert.rejects(
      preflightNewborns(new Context({}, io), versioned, '0.2.0'),
      /^Error: mktemp -d gave .*; the newborn test is not run without a scratch directory of its own$/,
    );
    assert.equal(ran, false, `nothing ran with ${JSON.stringify(made)}`);
  }
});

test("an error while examining one template's newborns is that template's outcome, and the others are still examined", async () => {
  const tree: Tree = {
    s1: { 'verify.log': 'kept: /s1/k\n', k: NEWBORN },
    s2: { 'verify.log': 'kept: /s2/k\n', k: NEWBORN },
  };
  let made = 0;
  const removed: string[] = [];
  const io = fakeIo(
    tree,
    (cwd, args) => {
      if (cwd === '/s1/k' && args[0] === 'ls-files') throw new Error('git broke');
      return '';
    },
    {
      mktemp: () => `/s${++made}\n`,
      sh: () => '',
      mise: (cwd) => tasks(cwd),
      rm: (_cwd, args) => {
        removed.push(args.at(-1) ?? '');
        return '';
      },
    },
  );
  let err = '';
  io.stderr.on('data', (c: Buffer) => {
    err += c;
  });
  await assert.rejects(preflightNewborns(new Context({}, io), versioned, '0.2.0'), (e: Error) => {
    assert.match(e.message, /^1 template fails as a newborn repo:$/m);
    assert.match(e.message, /^ {4}✗ plx doctor examined no newborn: plx doctor could not examine \/s1\/k: git broke$/m);
    assert.ok(!e.message.includes('template-repo-operations'), e.message);
    return true;
  });
  assert.match(err, /✓ template-repo-operations: k/);
  assert.deepEqual(removed, ['/s1', '/s2'], 'each scratch goes, the failing one too');
});
