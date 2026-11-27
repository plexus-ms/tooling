import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REGULAR, render } from './index.ts';
import { listing, template } from './testing/trees.ts';

const basket = 'name: basket\nquestions:\n  fruit:\n    type: str\n';

test('render renders a file ending in .jinja with the answers, without the suffix, and copies any other as bytes', () => {
  const result = render(
    [
      template(basket, {
        'README.md': 'A basket of {{ fruit }}.\n',
        'notes.md.jinja': 'A basket of {{ fruit }}.\n',
        'shelf/label.txt.jinja': '{{ fruit | upper }}',
        'bin/count.sh': { text: '#!/bin/sh\necho 3\n', mode: REGULAR | 0o755 },
        'bin/name.sh.jinja': { text: 'echo {{ fruit }}\n', mode: REGULAR | 0o755 },
        'shelf/photo.bin': { bytes: [0xff, 0x00, 0xfe], mode: REGULAR | 0o644 },
      }),
    ],
    { fruit: 'pear' },
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(listing(result.tree), {
    'README.md': 'A basket of {{ fruit }}.\n',
    'notes.md': 'A basket of pear.\n',
    'shelf/label.txt': 'PEAR',
    'bin/count.sh': { text: '#!/bin/sh\necho 3\n', mode: REGULAR | 0o755 },
    'bin/name.sh': { text: 'echo pear\n', mode: REGULAR | 0o755 },
    'shelf/photo.bin': { bytes: [0xff, 0x00, 0xfe], mode: REGULAR | 0o644 },
  });
});

test('render reports every file whose Jinja fails, by template and path, and then returns no files', () => {
  const result = render(
    [
      template(basket, {
        'a.txt.jinja': '{{ fruit }}',
        'b.txt.jinja': '{{ colour }}',
        'c.txt.jinja': '{% if fruit %}',
      }),
    ],
    { fruit: 'pear' },
  );
  assert.deepEqual(
    result.errors.map(({ template, path }) => ({ template, path })),
    [
      { template: 'basket', path: 'files/b.txt.jinja' },
      { template: 'basket', path: 'files/c.txt.jinja' },
    ],
  );
  assert.match(result.errors[0]?.message ?? '', /undefined/);
  assert.deepEqual(listing(result.tree), {});
  assert.deepEqual([...result.files], []);
  assert.deepEqual(result.birth, []);
});
