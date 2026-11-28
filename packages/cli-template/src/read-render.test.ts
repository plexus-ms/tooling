// `readRender`: a render directory that `plx-template render` wrote, read back
// with the policies file beside it, as a caller of the library hands it to
// `planMerge`. The render is written by the command, as another version's
// plx-template would write it, and compared with what `render` returns.
import assert from 'node:assert/strict';
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { readRender, readTree, render } from './index.ts';
import { plxTemplate, put, type Scratch, scratch } from './testing/run.ts';

const BASKET = [
  'name: basket',
  'questions:',
  '  fruit:',
  '    type: str',
  'policies:',
  '  notes.md.jinja: born-once',
  '',
].join('\n');

/** A basket template rendered by the command into `out` with the answers, then `body`; the scratch removed after. */
async function withRender(body: (s: Scratch, out: string) => Promise<void>): Promise<void> {
  const s = scratch();
  try {
    put(s.dir, {
      'basket/template.yml': BASKET,
      'basket/files/README.md.jinja': 'A basket of {{ fruit }}s.\n',
      'basket/files/notes.md.jinja': 'Notes on {{ fruit }}.\n',
      'basket/files/bin/count.sh': { text: '#!/bin/sh\necho 3\n', mode: 0o755 },
    });
    const run = plxTemplate(['render', '--answers', '-', s.path('out'), s.path('basket')], '{"fruit": "pear"}');
    assert.equal(run.code, 0, run.stderr);
    await body(s, s.path('out'));
  } finally {
    s.remove();
  }
}

test('a render the command wrote reads back as the tree and the policies render gives', async () => {
  await withRender(async (s, out) => {
    const expected = render([await readTree(s.path('basket'))], { fruit: 'pear' });
    const read = await readRender(out);
    assert.deepEqual(read.tree, expected.tree);
    assert.deepEqual(
      [...read.policies].map(([path, { policy }]) => [path, policy]),
      [...expected.files].map(([path, { policy }]) => [path, policy]),
    );
  });
});

test('a render without its policies file, or with a wrong one, is refused naming the file', async () => {
  await withRender(async (_s, out) => {
    const policies = `${out}.plx-template.json`;
    writeFileSync(policies, '{"version": 1, "files": {}}');
    await assert.rejects(readRender(out), (error: Error & { path?: string }) => {
      assert.match(error.message, /lacks README\.md/);
      assert.equal(error.path, policies);
      return true;
    });
    rmSync(policies);
    await assert.rejects(readRender(out), /cannot read the policies file/);
  });
});

test('a render that holds a symlink is refused, naming it', async () => {
  await withRender(async (_s, out) => {
    symlinkSync('README.md', `${out}/link`);
    await assert.rejects(readRender(out), (error: Error & { path?: string }) => {
      assert.match(error.message, /symlink/);
      assert.equal(error.path, `${out}/link`);
      return true;
    });
  });
});
