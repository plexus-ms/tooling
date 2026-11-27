import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { templatesRoot } from '@plexus-ms/lib';

const PACKAGE = join(import.meta.dirname, '..');
const TEMPLATES = join(PACKAGE, '..', '..', 'templates');

/** Every file below `dir` with its bytes and executable bit, by relative path. */
function listing(dir: string, base = dir): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return Object.entries(listing(path, base));
      const mode = statSync(path).mode & 0o111 ? 'x' : '-';
      return [[path.slice(base.length + 1), `${mode} ${readFileSync(path).toString('base64')}`]];
    }),
  );
}

test('the build puts the templates beside the bundle, where templatesRoot finds them', () => {
  execFileSync(process.execPath, ['build.js'], { cwd: PACKAGE });
  const bundle = join(PACKAGE, 'dist', 'plx.js');
  const root = templatesRoot(pathToFileURL(bundle).href);
  assert.equal(root, join(PACKAGE, 'dist', 'templates'));
  const bundled = listing(root);
  assert.ok(Object.keys(bundled).includes('repo-turbo/template.yml'));
  assert.deepEqual(bundled, listing(TEMPLATES));
});
