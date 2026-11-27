// `plx-template merge` as a process: two renders and a directory with local
// edits, in a scratch directory. The renders are written by hand, with the
// policies file beside each that `render` writes (render-command.test.ts).
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { plxTemplate, put, read, type Scratch, scratch } from './testing/run.ts';
import type { Listing } from './testing/trees.ts';

/** The policies file beside a render, for the paths it holds: all `merge` but those named born-once. */
function policies(paths: readonly string[], bornOnce: readonly string[] = []): string {
  const files = Object.fromEntries(
    paths.map((p) => [p, { template: 'basket', policy: bornOnce.includes(p) ? 'born-once' : 'merge' }]),
  );
  return JSON.stringify({ files });
}

/** A scratch directory with the renders `old` and `new` and the directory `target`. */
function withDirectories(
  old: Listing,
  next: Listing,
  target: Listing,
  body: (s: Scratch) => void,
  bornOnce: readonly string[] = [],
): void {
  const s = scratch();
  try {
    put(s.path('old'), old);
    put(s.path('new'), next);
    mkdirSync(s.path('target'));
    put(s.path('target'), target);
    put(s.dir, {
      'old.plx-template.json': policies(Object.keys(old), bornOnce),
      'new.plx-template.json': policies(Object.keys(next), bornOnce),
    });
    body(s);
  } finally {
    s.remove();
  }
}

const OLD = {
  'clean.txt': 'a\nb\nc\n',
  'conflict.txt': 'x\n',
  'removed.txt': 'gone\n',
  'edited-removed.txt': 'gone too\n',
  'born.md': 'first\n',
  'bin/tool.sh': '#!/bin/sh\necho 1\n',
};
const NEW = {
  'clean.txt': 'a\nb\nc\nd\n',
  'conflict.txt': 'y\n',
  'added.txt': 'new\n',
  'born.md': 'second\n',
  'bin/tool.sh': { text: '#!/bin/sh\necho 1\n', mode: 0o755 },
};
const TARGET = {
  'clean.txt': 'A\nb\nc\n',
  'conflict.txt': 'z\n',
  'removed.txt': 'gone\n',
  'edited-removed.txt': 'gone too, edited\n',
  'born.md': 'mine\n',
  'bin/tool.sh': '#!/bin/sh\necho 1\n',
  'mine.txt': "not the template's\n",
};

test('merge applies what the template changed to the directory, and reports each path', () => {
  withDirectories(
    OLD,
    NEW,
    TARGET,
    (s) => {
      const run = plxTemplate(['merge', s.path('old'), s.path('new'), s.path('target')]);
      assert.equal(run.code, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), {
        report: [
          { path: 'added.txt', outcome: 'added' },
          { path: 'bin/tool.sh', outcome: 'clean' },
          { path: 'born.md', outcome: 'kept' },
          { path: 'clean.txt', outcome: 'clean' },
          { path: 'conflict.txt', outcome: 'conflicted' },
          { path: 'edited-removed.txt', outcome: 'conflicted' },
          { path: 'removed.txt', outcome: 'deleted' },
        ],
      });
      assert.deepEqual(read(s.path('target')), {
        'added.txt': 'new\n',
        'bin/tool.sh': { text: '#!/bin/sh\necho 1\n', mode: 0o755 },
        'born.md': 'mine\n',
        'clean.txt': 'A\nb\nc\nd\n',
        'conflict.txt': '<<<<<<< current\nz\n=======\ny\n>>>>>>> new render\n',
        'edited-removed.txt': 'gone too, edited\n',
        'mine.txt': "not the template's\n",
      });
    },
    ['born.md'],
  );
});

test('a render without its policies file, a malformed one, or a directory that is missing is code 3, every error listed, nothing written', () => {
  withDirectories(OLD, NEW, TARGET, (s) => {
    rmSync(s.path('old.plx-template.json'));
    writeFileSync(s.path('new.plx-template.json'), '{"files": {"clean.txt": {"policy": "sometimes"}}}');
    const before = read(s.path('target'));
    const run = plxTemplate(['merge', s.path('old'), s.path('new'), s.path('target')]);
    assert.equal(run.code, 3);
    const { errors } = JSON.parse(run.stdout);
    assert.deepEqual(
      errors.map((e: { path: string }) => e.path),
      [s.path('old.plx-template.json'), s.path('new.plx-template.json')],
    );
    assert.match(errors[0].message, /render/);
    for (const e of errors) assert.ok(run.stderr.includes(e.message), e.message);
    assert.deepEqual(read(s.path('target')), before);

    writeFileSync(s.path('new.plx-template.json'), policies(Object.keys(NEW)));
    const missing = plxTemplate(['merge', s.path('no-old'), s.path('new'), s.path('no-target')]);
    assert.equal(missing.code, 3);
    assert.deepEqual(
      JSON.parse(missing.stdout).errors.map((e: { path: string }) => e.path),
      [s.path('no-old'), s.path('no-target')],
    );
  });
});

/** The permission bits of `path` below the scratch directory. */
const permissions = (s: Scratch, path: string): number => statSync(s.path(path)).mode & 0o777;

test('merge changes only the executable bits of a file that exists, and never widens its permissions', () => {
  const old = { 'a.sh': 'echo\n', 'b.sh': 'echo\n', 'c.sh': 'echo\n' };
  const next = {
    'a.sh': { text: 'echo\n', mode: 0o755 },
    'b.sh': { text: 'echo\n', mode: 0o755 },
    'c.sh': { text: 'echo\n', mode: 0o644 },
  };
  withDirectories(old, next, old, (s) => {
    chmodSync(s.path('target/a.sh'), 0o600);
    chmodSync(s.path('target/b.sh'), 0o640);
    chmodSync(s.path('target/c.sh'), 0o755);
    const run = plxTemplate(['merge', s.path('old'), s.path('new'), s.path('target')]);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(
      JSON.parse(run.stdout).report.map((e: { outcome: string }) => e.outcome),
      ['clean', 'clean'],
    );
    assert.equal(permissions(s, 'target/a.sh'), 0o700, 'owner only stays owner only');
    assert.equal(permissions(s, 'target/b.sh'), 0o750, 'group read becomes group execute, nothing else moves');
    assert.equal(permissions(s, 'target/c.sh'), 0o755, 'a file the template did not change is not touched');
  });
});

test('merge never writes or deletes through a symlink', () => {
  const old = { link: 'one\n', 'dir/file.txt': 'one\n', 'gone.txt': 'one\n' };
  const next = { link: 'two\n', 'dir/file.txt': 'two\n', 'new/file.txt': 'two\n' };
  withDirectories(old, next, {}, (s) => {
    put(s.dir, { 'outside/target.txt': 'one\n', 'outside/file.txt': 'one\n', 'outside/gone.txt': 'one\n' });
    symlinkSync(s.path('outside/target.txt'), s.path('target/link'));
    symlinkSync(s.path('outside'), s.path('target/dir'));
    symlinkSync(s.path('outside'), s.path('target/new'));
    symlinkSync(s.path('outside/gone.txt'), s.path('target/gone.txt'));
    const run = plxTemplate(['merge', s.path('old'), s.path('new'), s.path('target')]);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(read(s.path('outside')), { 'target.txt': 'one\n', 'file.txt': 'one\n', 'gone.txt': 'one\n' });
    assert.ok(lstatSync(s.path('target/link')).isSymbolicLink());
    assert.ok(lstatSync(s.path('target/gone.txt')).isSymbolicLink());
    for (const e of JSON.parse(run.stdout).report) assert.notEqual(e.outcome, 'clean', e.path);
  });
});

test('a deletion removes the directories it leaves empty, up to the target, and no others', () => {
  const old = { 'a/b/c.txt': 'x\n', 'a/keep.txt': 'x\n', 'd/e/f.txt': 'x\n', 'g/h/i.txt': 'x\n' };
  const next = { 'a/keep.txt': 'x\n', 'g/h': { text: '', mode: 0o040755 } };
  withDirectories(old, next, old, (s) => {
    mkdirSync(s.path('target/empty-before'));
    const run = plxTemplate(['merge', s.path('old'), s.path('new'), s.path('target')]);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(Object.keys(read(s.path('target'))).sort(), ['a/keep.txt', 'empty-before/', 'g/h/']);
  });
});

test('merge reads only what the renders name: an unreadable directory elsewhere in the target is no matter', () => {
  withDirectories({ 'a.txt': 'one\n' }, { 'a.txt': 'two\n' }, { 'a.txt': 'one\n' }, (s) => {
    put(s.path('target'), { 'node_modules/x/y.js': 'big\n', '.git/HEAD': 'ref\n' });
    chmodSync(s.path('target/node_modules'), 0o000);
    chmodSync(s.path('target/.git'), 0o000);
    try {
      const run = plxTemplate(['merge', s.path('old'), s.path('new'), s.path('target')]);
      assert.equal(run.code, 0, run.stderr);
      assert.equal(readFileSync(s.path('target/a.txt'), 'utf8'), 'two\n');
    } finally {
      chmodSync(s.path('target/node_modules'), 0o755);
      chmodSync(s.path('target/.git'), 0o755);
    }
  });
});

test('merge adds an empty directory of the new render, and a file the user deleted stays deleted', () => {
  const old = { 'a.txt': 'one\n' };
  const next = { 'a.txt': 'two\n', 'shelf/empty': { text: '', mode: 0o040755 } };
  withDirectories(old, next, {}, (s) => {
    const run = plxTemplate(['merge', s.path('old'), s.path('new'), s.path('target')]);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(read(s.path('target')), { 'shelf/empty/': '' });
    assert.deepEqual(JSON.parse(run.stdout).report, [
      { path: 'a.txt', outcome: 'kept' },
      { path: 'shelf/empty', outcome: 'added' },
    ]);
  });
});
