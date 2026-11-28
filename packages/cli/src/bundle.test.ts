import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { readTree, type Tree } from '@plexus-ms/cli-template';
import { templatesRoot } from '@plexus-ms/lib';

// The build runs into a scratch copy of the package, its package.json and a
// dist the build makes there, never into the package's own dist, which a
// `turbo run build` may be writing at the same time. What the scratch copy
// publishes is what the package publishes: `files` names `dist` alone.
const PACKAGE = join(import.meta.dirname, '..');
const TEMPLATES = join(PACKAGE, '..', '..', 'templates');

/** A tree as comparable data: each path's bytes, as base64, and its executable bit. */
const flat = (tree: Tree) =>
  Object.fromEntries(
    [...tree].map(([path, { bytes, mode }]) => [
      path,
      `${mode & 0o100 ? 'x' : '-'} ${Buffer.from(bytes).toString('base64')}`,
    ]),
  );

let scratch = '';
before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cli-bundle-'));
  copyFileSync(join(PACKAGE, 'package.json'), join(scratch, 'package.json'));
  execFileSync(process.execPath, ['build.js', join(scratch, 'dist')], { cwd: PACKAGE });
});
after(() => rmSync(scratch, { recursive: true, force: true }));

test('the build puts the templates beside the bundle, where templatesRoot finds them', async () => {
  const root = templatesRoot(pathToFileURL(join(scratch, 'dist', 'plx.js')).href);
  assert.equal(root, join(scratch, 'dist', 'templates'));
  const bundled = flat(await readTree(root));
  assert.ok(Object.keys(bundled).includes('repo-turbo/template.yml'));
  assert.deepEqual(bundled, flat(await readTree(TEMPLATES)));
});

test('the package holds every file of the templates, which npm leaves out for some names', async () => {
  const packed: string[] = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: scratch, encoding: 'utf8' }),
  )[0].files.map((file: { path: string }) => file.path);
  const missing = Object.keys(flat(await readTree(TEMPLATES)))
    .map((path) => `dist/templates/${path}`)
    .filter((path) => !packed.includes(path));
  assert.deepEqual(missing, []);
});
