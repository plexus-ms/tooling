// The built plx-ci, run as a process: the bundle has to start. plx-ci does not
// use the template engine, which lib exports code for, so a bundle that cannot
// start because it carries the engine's wasm loader is found here. Needs
// `pnpm build`, which turbo runs before the tests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

test('the built plx-ci starts', () => {
  const run = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'dist', 'plx-ci.js'), '--help'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /plx-ci/);
});
