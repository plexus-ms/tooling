// The manifest, read through render: what each part of it does to the result,
// and every way it can be wrong.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { render } from './index.ts';
import { template } from './testing/trees.ts';

test('render gives each path its template and its policy, born-once where the manifest says so by source path', () => {
  const result = render(
    [
      template('name: basket\npolicies:\n  notes.md.jinja: born-once\n  README.md: merge\n', {
        'notes.md.jinja': 'notes',
        'README.md': 'read me',
        'shelf/label.txt': 'label',
      }),
    ],
    {},
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    new Map(result.files),
    new Map([
      ['notes.md', { template: 'basket', policy: 'born-once' }],
      ['README.md', { template: 'basket', policy: 'merge' }],
      ['shelf/label.txt', { template: 'basket', policy: 'merge' }],
    ]),
  );
});

test('render returns the birth commands in the manifest order, as argument vectors it does not run', () => {
  const result = render(
    [template('name: basket\nbirth:\n  - [weave, --tight]\n  - [fill, basket, "with fruit"]\n', { 'a.txt': 'a' })],
    {},
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.birth, [
    { template: 'basket', command: ['weave', '--tight'] },
    { template: 'basket', command: ['fill', 'basket', 'with fruit'] },
  ]);
});
