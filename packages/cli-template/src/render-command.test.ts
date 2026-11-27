// `plx-template render` as a process, on template directories of baskets and
// shelves in a scratch directory.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { plx, put, read, type Scratch, scratch } from './testing/run.ts';

const BASKET = [
  'name: basket',
  'questions:',
  '  fruit:',
  '    type: str',
  '    help: The fruit inside',
  '  count:',
  '    type: int',
  '    default: 3',
  'policies:',
  '  notes.md.jinja: born-once',
  'birth:',
  '  - [git, init]',
  '',
].join('\n');

/** A scratch directory holding a basket template, removed when `body` is done. */
function withBasket(body: (s: Scratch, basket: string) => void): void {
  const s = scratch();
  try {
    put(s.dir, {
      'basket/template.yml': BASKET,
      'basket/files/README.md.jinja': 'A basket of {{ count }} {{ fruit }}s.\n',
      'basket/files/notes.md.jinja': 'Notes on {{ fruit }}.\n',
      'basket/files/bin/count.sh': { text: '#!/bin/sh\necho 3\n', mode: 0o755 },
    });
    mkdirSync(s.path('basket/files/shelf/empty'), { recursive: true });
    body(s, s.path('basket'));
  } finally {
    s.remove();
  }
}

test('render writes the tree beside the policies, and prints the result as JSON', () => {
  withBasket((s, basket) => {
    put(s.dir, { 'answers.json': '{"fruit": "pear", "colour": "green"}' });
    const out = s.path('out');
    const run = plx(['render', '--answers', s.path('answers.json'), out, basket]);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(read(out), {
      'README.md': 'A basket of 3 pears.\n',
      'notes.md': 'Notes on pear.\n',
      'bin/count.sh': { text: '#!/bin/sh\necho 3\n', mode: 0o755 },
      'shelf/empty/': '',
    });
    assert.deepEqual(JSON.parse(run.stdout), {
      answers: { count: 3, fruit: 'pear' },
      unused: ['colour'],
      files: {
        'README.md': { template: 'basket', policy: 'merge' },
        'bin/count.sh': { template: 'basket', policy: 'merge' },
        'notes.md': { template: 'basket', policy: 'born-once' },
        'shelf/empty': { template: 'basket', policy: 'merge' },
      },
      birth: [{ template: 'basket', command: ['git', 'init'] }],
      errors: [],
    });
    assert.deepEqual(JSON.parse(read(s.dir)['out.plx-template.json'] as string), {
      files: JSON.parse(run.stdout).files,
    });
  });
});
