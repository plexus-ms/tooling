// The import boundary: the engine knows nothing of who calls it, so no file of
// this package, its tests and fixtures included, imports a `@plexus-ms/*`
// package or a path outside the package, and its manifest depends on none.
// Imports are read with TypeScript's own pre-processor, so that static, type,
// re-export and dynamic imports and `require` calls all count.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The imports of one source file at `file` that cross the boundary, each as `<file>: <specifier>`. */
function crossings(file: string, source: string): string[] {
  const { importedFiles } = ts.preProcessFile(source, true, true);
  return importedFiles
    .map((i) => i.fileName)
    .filter((specifier) => {
      if (specifier.startsWith('@plexus-ms/')) return true;
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) return false;
      const target = relative(root, resolve(dirname(file), specifier));
      return target === '..' || target.startsWith('../');
    })
    .map((specifier) => `${relative(root, file)}: ${specifier}`);
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.name === 'node_modules' || d.name === 'dist') return [];
    const path = join(dir, d.name);
    if (d.isDirectory()) return sources(path);
    return /\.[cm]?[jt]sx?$/.test(d.name) ? [path] : [];
  });
}

test('the scan catches every kind of import across the boundary, and nothing else', () => {
  const file = join(root, 'src', 'a.ts');
  const source = [
    "import { x } from '@plexus-ms/lib';",
    "import type { Y } from '@plexus-ms/cli';",
    "export * from '@plexus-ms/config';",
    "const z = await import('@plexus-ms/cli-ci');",
    "const w = require('@plexus-ms/dev');",
    "import '../../lib/src/index.ts';",
    "import '/elsewhere/file.ts';",
    "import { a } from './b.ts';",
    "import { c } from '../src/c.ts';",
    "import { d } from 'minijinja-js';",
    "import { e } from 'node:fs';",
  ].join('\n');
  assert.deepEqual(crossings(file, source), [
    'src/a.ts: @plexus-ms/lib',
    'src/a.ts: @plexus-ms/cli',
    'src/a.ts: @plexus-ms/config',
    'src/a.ts: @plexus-ms/cli-ci',
    'src/a.ts: @plexus-ms/dev',
    'src/a.ts: ../../lib/src/index.ts',
    'src/a.ts: /elsewhere/file.ts',
  ]);
});

test('no file of the package imports from Plexus or from outside the package', () => {
  const files = sources(root);
  assert.ok(files.includes(fileURLToPath(import.meta.url)), 'the scan reaches this file');
  assert.deepEqual(
    files.flatMap((f) => crossings(f, readFileSync(f, 'utf8'))),
    [],
  );
});

test('the package depends on no Plexus package', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const names = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((field) =>
    Object.keys(manifest[field] ?? {}),
  );
  assert.deepEqual(
    names.filter((n) => n.startsWith('@plexus-ms/')),
    [],
  );
});
