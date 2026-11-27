// plx-template as a process: its arguments, its help and its exit codes. The
// commands' behaviour is tested in render-command.test.ts and
// merge-command.test.ts, and the update by hand in update.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plx } from './testing/run.ts';

test('--help describes both commands, the answers, the exit codes and the sidecar of a render', () => {
  const run = plx(['--help']);
  assert.equal(run.code, 0);
  assert.equal(run.stderr, '');
  for (const word of ['render', 'merge', '--answers', 'exit', 'standard input', 'standard error'])
    assert.ok(run.stdout.includes(word), `the help says ${word}`);
});

test('each command has a help of its own', () => {
  const render = plx(['render', '--help']);
  assert.equal(render.code, 0);
  assert.match(render.stdout, /plx-template render/);
  assert.match(render.stdout, /<output-dir>/);
  const merge = plx(['merge', '--help']);
  assert.equal(merge.code, 0);
  assert.match(merge.stdout, /plx-template merge/);
  assert.match(merge.stdout, /<old-dir> <new-dir> <target-dir>/);
});

test('no command, an unknown command and an unknown option are usage errors: code 2, nothing on standard output', () => {
  for (const args of [[], ['frobnicate'], ['render', '--frobnicate'], ['merge', 'a', 'b'], ['render', 'out']]) {
    const run = plx(args);
    assert.equal(run.code, 2, args.join(' '));
    assert.equal(run.stdout, '', args.join(' '));
    assert.match(run.stderr, /--help/, args.join(' '));
  }
});
