// `plx-template merge` as a process: two renders and a directory with local
// edits, in a scratch directory. The renders are written by hand, with the
// policies file beside each that `render` writes (render-command.test.ts).
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { plx, put, read, type Scratch, scratch } from './testing/run.ts';
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
      const run = plx(['merge', s.path('old'), s.path('new'), s.path('target')]);
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
    const run = plx(['merge', s.path('old'), s.path('new'), s.path('target')]);
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
    const missing = plx(['merge', s.path('no-old'), s.path('new'), s.path('no-target')]);
    assert.equal(missing.code, 3);
    assert.deepEqual(
      JSON.parse(missing.stdout).errors.map((e: { path: string }) => e.path),
      [s.path('no-old'), s.path('no-target')],
    );
  });
});
