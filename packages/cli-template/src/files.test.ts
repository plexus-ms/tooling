// The path rules of `render`: which file lands where. Ported from copier
// v9.19.1 (MIT, see LICENSE.copier); each test names its original.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIRECTORY, render } from './index.ts';
import { listing, template } from './testing/trees.ts';

const ripe = 'name: basket\nquestions:\n  ripe:\n    type: bool\n    default: false\n';

// tests/test_conditional_file_name.py::test_render_conditional
test('a file whose name part renders to text lands under it', () => {
  const result = render([template(ripe, { '{% if ripe %}apple.txt{% endif %}.jinja': 'It is ripe.' })], { ripe: true });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(listing(result.tree), { 'apple.txt': 'It is ripe.' });
});

// tests/test_conditional_file_name.py::test_dont_render_conditional
test('a file whose name renders empty is skipped', () => {
  const result = render([template(ripe, { '{% if ripe %}apple.txt{% endif %}.jinja': 'It is ripe.' })], {
    ripe: false,
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(listing(result.tree), {});
  assert.deepEqual([...result.files], []);
});

// tests/test_conditional_file_name.py::test_render_conditional_subdir
test('a file below a directory renders its name part by part', () => {
  const result = render([template(ripe, { 'shelf/{% if ripe %}apple.txt{% endif %}.jinja': 'It is ripe.' })], {
    ripe: true,
  });
  assert.deepEqual(listing(result.tree), { 'shelf/apple.txt': 'It is ripe.' });
});

// tests/test_conditional_file_name.py::test_dont_render_conditional_subdir
test('a skipped file below a directory is not written', () => {
  const result = render([template(ripe, { 'shelf/{% if ripe %}apple.txt{% endif %}.jinja': 'It is ripe.' })], {
    ripe: false,
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    Object.keys(listing(result.tree)).filter((path) => path.includes('apple')),
    [],
  );
});

// tests/test_conditional_file_name.py::test_answer_changes, its render half:
// the same template with the answer true and then false, which is what an
// update renders as its two sides. Copier's update half is `merge`'s.
test('the answer decides whether a file is in the tree', () => {
  const basket = template(ripe, { '{% if ripe %}apple.txt{% endif %}.jinja': '' });
  assert.deepEqual(Object.keys(listing(render([basket], { ripe: true }).tree)), ['apple.txt']);
  assert.deepEqual(Object.keys(listing(render([basket], { ripe: false }).tree)), []);
});

const dir = { text: '', mode: DIRECTORY | 0o755 };

// tests/test_copy.py::test_empty_dir, both parametrisations. Copier's `four`
// is a symlink to `three`; a symlink in a template is an error here, so the
// fixture leaves it out. A directory that holds nothing in the template is
// kept (`void/`, which the original lacks), and so is one whose files are all
// skipped (`five/`): an empty directory lands where its path renders.
test('a directory whose part renders empty is skipped with its files, and one that ends up empty is kept', () => {
  const gate = 'name: basket\nquestions:\n  do_it:\n    type: bool\n';
  const basket = template(gate, {
    '{% if do_it %}one_dir{% endif %}/one.txt.jinja': 'one',
    'two.txt': 'two',
    '{% if do_it %}three.txt{% endif %}.jinja': 'three',
    'five/{% if do_it %}six.txt{% endif %}.jinja': 'six',
    void: dir,
  });
  assert.deepEqual(listing(render([basket], { do_it: true }).tree), {
    'one_dir/one.txt': 'one',
    'two.txt': 'two',
    'three.txt': 'three',
    'five/six.txt': 'six',
    void: dir,
  });
  const off = render([basket], { do_it: false });
  assert.deepEqual(off.errors, []);
  assert.deepEqual(listing(off.tree), { 'two.txt': 'two', five: dir, void: dir });
  assert.deepEqual([...off.files.keys()], ['two.txt', 'five', 'void']);
});
