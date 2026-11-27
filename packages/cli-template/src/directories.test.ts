// The functions a caller of the library uses to touch directories: the
// manifest of a template directory, and a merge of two renders into a
// directory, planned and then applied. Through the library's entry, with
// fixture templates in scratch directories.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planMerge, readManifest, readTree, render } from './index.ts';
import { put, read, scratch } from './testing/run.ts';

const BASKET = ['name: basket', 'questions:', '  fruit:', '    type: str', '  count:', '    default: 3', ''].join('\n');

test('readManifest reads the manifest of a template directory', async () => {
  const s = scratch();
  try {
    put(s.dir, { 'template.yml': BASKET, 'files/list.txt': 'apple\n' });
    const manifest = await readManifest(s.dir);
    assert.equal(manifest.name, 'basket');
    assert.deepEqual(
      manifest.questions.map((q) => q.name),
      ['fruit', 'count'],
    );
    assert.equal(manifest.questions[1]?.default, 3);
  } finally {
    s.remove();
  }
});

test('readManifest names every problem of a manifest that cannot be read', async () => {
  const s = scratch();
  try {
    put(s.dir, { 'template.yml': 'name: Basket\nquestions:\n  1x:\n', 'files/a.txt': 'a' });
    await assert.rejects(readManifest(s.dir), (error: Error) => {
      assert.match(error.message, /template\.yml/);
      assert.match(error.message, /Basket/);
      assert.match(error.message, /1x/);
      return true;
    });
  } finally {
    s.remove();
  }
});

test('readManifest rejects a directory that is no template', async () => {
  const s = scratch();
  try {
    await assert.rejects(readManifest(s.path('absent')), /no such directory/);
  } finally {
    s.remove();
  }
});

/** A render of the basket template with `list` as its list.txt, as a side of a merge. */
async function side(list: string) {
  const s = scratch();
  try {
    put(s.dir, { 'template.yml': BASKET, 'files/list.txt.jinja': list });
    const result = render([await readTree(s.dir)], { fruit: 'pear' });
    assert.deepEqual(result.errors, []);
    return { tree: result.tree, policies: result.files };
  } finally {
    s.remove();
  }
}

test('planMerge reports a merge and changes nothing until it is applied', async () => {
  const s = scratch();
  try {
    put(s.dir, { 'list.txt': 'mine\n', 'other.txt': 'mine\n' });
    const old = await side('{{ fruit }}\n');
    const next = await side('{{ fruit }} and {{ count }}\n');
    const plan = await planMerge(s.dir, old, next);
    assert.deepEqual(plan.report, [{ path: 'list.txt', outcome: 'conflicted' }]);
    assert.deepEqual(read(s.dir), { 'list.txt': 'mine\n', 'other.txt': 'mine\n' });
    await plan.apply();
    assert.deepEqual(read(s.dir), {
      'list.txt': '<<<<<<< current\nmine\n=======\npear and 3\n>>>>>>> new render\n',
      'other.txt': 'mine\n',
    });
  } finally {
    s.remove();
  }
});

test('planMerge merges clean where only the template changed, and adds what the new render adds', async () => {
  const s = scratch();
  try {
    put(s.dir, { 'list.txt': 'pear\n' });
    const old = await side('{{ fruit }}\n');
    const next = await side('{{ fruit }}\nplum\n');
    const plan = await planMerge(s.dir, old, next);
    assert.deepEqual(plan.report, [{ path: 'list.txt', outcome: 'clean' }]);
    await plan.apply();
    assert.deepEqual(read(s.dir), { 'list.txt': 'pear\nplum\n' });
  } finally {
    s.remove();
  }
});

test('planMerge rejects a target that is not a directory', async () => {
  const s = scratch();
  try {
    const old = await side('a\n');
    await assert.rejects(planMerge(s.path('absent'), old, old), /no such directory/);
  } finally {
    s.remove();
  }
});
