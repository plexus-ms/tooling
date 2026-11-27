// The built plx-ci, run as a process: the bundle has to start. plx-ci does not
// use the template engine, which lib exports code for, so a bundle that cannot
// start because it carries the engine's wasm loader is found here. The bundle
// is built into a scratch directory, never into the package's own dist, which
// another build may be writing at the same time.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

let scratch = '';
before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'plx-ci-bundle-'));
  const pkg = join(import.meta.dirname, '..');
  copyFileSync(join(pkg, 'package.json'), join(scratch, 'package.json'));
  execFileSync(process.execPath, ['build.js', join(scratch, 'dist')], { cwd: pkg });
});
after(() => rmSync(scratch, { recursive: true, force: true }));

test('the built plx-ci starts', () => {
  const run = spawnSync(process.execPath, [join(scratch, 'dist', 'plx-ci.js'), '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /plx-ci/);
});
