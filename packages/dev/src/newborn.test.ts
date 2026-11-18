import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVerifyLog } from './newborn.ts';

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
