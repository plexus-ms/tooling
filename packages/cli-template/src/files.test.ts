// The path rules of `render`: which file lands where. Ported from copier
// v9.19.1 (MIT, see LICENSE.copier); each test names its original.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { render } from './index.ts';
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
