import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { templatesRoot } from './templatesRoot.ts';

const layout = (...dirs: string[]) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'templates-root-')));
  for (const d of dirs) mkdirSync(join(dir, d), { recursive: true });
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
};

test('from source, the root is the templates directory of the repo', () => {
  assert.equal(templatesRoot(), join(import.meta.dirname, '..', '..', '..', 'templates'));
});

test('in the built package, the root is the templates directory beside the bundle', () => {
  const { dir, remove } = layout('node_modules/@plexus-ms/cli/dist/templates');
  try {
    const dist = join(dir, 'node_modules/@plexus-ms/cli/dist');
    assert.equal(templatesRoot(pathToFileURL(join(dist, 'plx.js')).href), join(dist, 'templates'));
  } finally {
    remove();
  }
});

test('the templates beside the bundle win over the repo layout', () => {
  const { dir, remove } = layout('packages/cli/dist/templates', 'templates');
  try {
    const dist = join(dir, 'packages/cli/dist');
    assert.equal(templatesRoot(pathToFileURL(join(dist, 'plx.js')).href), join(dist, 'templates'));
  } finally {
    remove();
  }
});

test('the root is the repo layout where no templates sit beside the module', () => {
  const { dir, remove } = layout('packages/lib/dist', 'templates');
  try {
    const lib = join(dir, 'packages/lib/dist');
    assert.equal(templatesRoot(pathToFileURL(join(lib, 'index.js')).href), join(dir, 'templates'));
  } finally {
    remove();
  }
});

test('where neither layout holds the templates, it fails and says where it looked', () => {
  const { dir, remove } = layout('node_modules/@plexus-ms/lib/dist');
  try {
    const lib = join(dir, 'node_modules/@plexus-ms/lib/dist');
    assert.throws(
      () => templatesRoot(pathToFileURL(join(lib, 'index.js')).href),
      (error: Error) =>
        error.message.includes(join(lib, 'templates')) &&
        error.message.includes(join(dir, 'node_modules', 'templates')),
    );
  } finally {
    remove();
  }
});

test('a file named templates is no templates directory', () => {
  const { dir, remove } = layout('packages/cli/dist', 'templates');
  try {
    const dist = join(dir, 'packages/cli/dist');
    writeFileSync(join(dist, 'templates'), '');
    assert.equal(templatesRoot(pathToFileURL(join(dist, 'plx.js')).href), join(dir, 'templates'));
  } finally {
    remove();
  }
});
