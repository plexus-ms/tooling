// The import boundaries. The engine knows nothing of who calls it, so no file
// of this package, its tests and fixtures included, imports a `@plexus-ms/*`
// package or a path outside the package, and its manifest depends on none.
// And the core works on trees in memory, so no source file but the shell's,
// named in SHELL, imports the filesystem, processes, the OS or paths.
// Imports are read with TypeScript's own pre-processor, so that static, type,
// re-export and dynamic imports and `require` calls all count.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The source files that touch the filesystem or run a command, by path from the package's root. */
const SHELL = ['src/git-merge-file.ts'];

/** The modules only the shell imports. */
const SYSTEM = /^(node:)?(fs|fs\/promises|child_process|os|path)$/;

/** What a source file imports, by specifier. */
function specifiers(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((i) => i.fileName);
}

/** The imports of one source file at `file` that reach the system, each as `<file>: <specifier>`. */
function systemImports(file: string, source: string): string[] {
  return specifiers(source)
    .filter((specifier) => SYSTEM.test(specifier))
    .map((specifier) => `${relative(root, file)}: ${specifier}`);
}

/** The imports of one source file at `file` that cross the boundary, each as `<file>: <specifier>`. */
function crossings(file: string, source: string): string[] {
  return specifiers(source)
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

test('the scan catches every import of the system, and nothing else', () => {
  const file = join(root, 'src', 'a.ts');
  const source = [
    "import { readFile } from 'node:fs';",
    "import { readFile as r } from 'node:fs/promises';",
    "import type { Stats } from 'fs';",
    "const { spawn } = await import('node:child_process');",
    "const os = require('os');",
    "export { join } from 'node:path';",
    "import { a } from './fs.ts';",
    "import { b } from 'node:url';",
    "import { c } from 'path-browserify';",
  ].join('\n');
  assert.deepEqual(systemImports(file, source), [
    'src/a.ts: node:fs',
    'src/a.ts: node:fs/promises',
    'src/a.ts: fs',
    'src/a.ts: node:child_process',
    'src/a.ts: os',
    'src/a.ts: node:path',
  ]);
});

test("no source file but the shell's imports the filesystem, processes, the OS or paths", () => {
  const files = sources(join(root, 'src')).map((f) => relative(root, f));
  for (const shell of SHELL) assert.ok(files.includes(shell), `${shell} exists`);
  const core = files.filter((f) => !f.endsWith('.test.ts') && !f.startsWith('src/testing/') && !SHELL.includes(f));
  assert.ok(core.includes('src/merge.ts'), 'the scan reaches the core');
  assert.deepEqual(
    core.flatMap((f) => systemImports(join(root, f), readFileSync(join(root, f), 'utf8'))),
    [],
  );
});
