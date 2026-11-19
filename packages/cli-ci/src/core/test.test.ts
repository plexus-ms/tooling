import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeArgs, overrideEnv, specEnv } from './test.ts';

test('the override’s x-plexus-ci.env is the specs’ environment, beside the port and the base URL', () => {
  const env = overrideEnv(
    'x-plexus-ci:\n  env:\n    DATABASE_URL: postgres://u:p@127.0.0.1:5432/db\nservices:\n  db: {}\n',
  );
  assert.deepEqual(env, { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db' });
  assert.deepEqual(specEnv(3000, env), {
    CI: '1',
    PLEXUS_LOOPBACK_PORT: '3000',
    E2E_BASE_URL: 'http://127.0.0.1:3000',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  });
  assert.deepEqual(overrideEnv('services: {}\n'), {});
  assert.throws(() => overrideEnv('x-plexus-ci:\n  env: nope\n'), /not a map/);
});

test('every stack command names the project and both files', () => {
  assert.deepEqual(composeArgs('ci-my-app'), [
    'compose',
    '--project-name',
    'ci-my-app',
    '--file',
    'compose.yaml',
    '--file',
    'compose.ci.yaml',
  ]);
});
