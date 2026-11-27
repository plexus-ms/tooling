// The path rules of `render`: which file lands where. Ported from copier
// v9.19.1 (MIT, see LICENSE.copier); each test names its original.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIRECTORY, REGULAR, render, SYMLINK } from './index.ts';
import { listing, template } from './testing/trees.ts';

const ripe =
  'name: basket\nquestions:\n  ripe:\n    type: bool\n    default: false\n  target:\n    type: str\n    default: x\n';

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

const where = 'name: basket\nquestions:\n  target:\n    type: str\n';

// tests/test_copy.py::test_value_with_forward_slash. A source path is split at
// its slashes before anything renders, so the slash is an answer here, where
// copier writes `_copier_conf.sep`.
test('a part that renders with slashes lands in nested directories', () => {
  const result = render([template(where, { '{{ target }}.txt': 'This is template.' })], { target: 'a/b/c' });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(listing(result.tree), { 'a/b/c.txt': 'This is template.' });
});

// tests/test_copy.py::test_relative_render_path_outside_destination_raises_error,
// with the path an answer for want of copier's `pathjoin`.
test('a rendered path that leaves the output through .. is an error naming the path and the source', () => {
  const result = render([template(where, { '{{ target }}': 'bar' })], { target: '../forbidden.txt' });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.template, 'basket');
  assert.equal(result.errors[0]?.path, 'files/{{ target }}');
  assert.match(result.errors[0]?.message ?? '', /"\.\.\/forbidden\.txt" is forbidden/);
  assert.deepEqual(listing(result.tree), {});
});

// tests/test_copy.py::test_absolute_render_path_outside_destination_raises_error_on_posix
test('a rendered absolute path is an error naming the path', () => {
  const result = render([template(where, { '{{ target }}': 'bar' })], { target: '/other/forbidden.txt' });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.message ?? '', /"\/other\/forbidden\.txt" is forbidden/);
  assert.deepEqual(listing(result.tree), {});
});

// No original: copier resolves the path, so a `..` that stays inside is fine.
test('a rendered path with .. that stays inside the output is normalised', () => {
  const result = render([template(where, { '{{ target }}': 'x' })], { target: 'shelf/../apple.txt' });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(Object.keys(listing(result.tree)), ['apple.txt']);
});

// tests/test_copy.py::test_invalid_jinja_in_rendered_path_reports_template_path
test('an error in the Jinja of a path names the template path it came from', () => {
  const broken = 'some-{{{{ jinja_error }}}}';
  const result = render([template(ripe, { [broken]: 'content' })], { ripe: true });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.template, 'basket');
  assert.equal(result.errors[0]?.path, `files/${broken}`);
  assert.ok(result.errors[0]?.message.includes(broken));
  assert.deepEqual(listing(result.tree), {});
});

// tests/test_copy.py::test_invalid_jinja_in_nested_rendered_path_reports_failing_path_part
test('an error in a directory part names that directory once, not the files below it', () => {
  const broken = 'some-{{{{ jinja_error }}}}';
  const result = render(
    [template(ripe, { [`parent/${broken}/child.txt`]: 'content', [`parent/${broken}/other.txt`]: 'content' })],
    { ripe: true },
  );
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.path, `files/parent/${broken}`);
  assert.ok(result.errors[0]?.message.includes(`parent/${broken}`));
  assert.ok(!result.errors[0]?.message.includes('child.txt'));
});

// tests/test_copy.py::test_preserved_permissions, adapted to the engine's rule:
// copier keeps every permission bit of the source, the engine only whether the
// owner may execute, and writes 0o644 or 0o755. The original's five modes, and
// one more with only a group execute bit.
for (const [mode, written] of [
  [0o400, 0o644],
  [0o700, 0o755],
  [0o770, 0o755],
  [0o707, 0o755],
  [0o777, 0o755],
  [0o010, 0o644],
] as const) {
  test(`a file of mode ${mode.toString(8).padStart(3, '0')} is written with mode ${written.toString(8)}`, () => {
    const result = render(
      [
        template(ripe, {
          the_file: { text: 'content', mode: REGULAR | mode },
          'the_template.jinja': { text: 'content', mode: REGULAR | mode },
        }),
      ],
      { ripe: true },
    );
    const file = written === 0o644 ? 'content' : { text: 'content', mode: REGULAR | written };
    assert.deepEqual(listing(result.tree), { the_file: file, the_template: file });
  });
}

// tests/test_empty_suffix.py::test_binary_file_fallback_to_copy. Copier's test
// runs with an empty suffix, where every file is a candidate and the name stays
// as it is; with a suffix it raises instead of copying. The issue's rule is to
// copy, so a `.jinja` file that is not text is copied as bytes under the name
// the suffix rule gives it, without the suffix.
test('a .jinja file that is not valid text is copied as bytes, without the suffix', () => {
  const bytes = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0xec, 0x0a, 0x7b, 0x7b,
    0x6e, 0x61, 0x6d, 0x65, 0x7d, 0x7d, 0x0a, 0x00, 0xec,
  ];
  const result = render([template(ripe, { 'logo.png.jinja': { bytes, mode: REGULAR | 0o644 } })], { ripe: true });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(listing(result.tree), { 'logo.png': { bytes, mode: REGULAR | 0o644 } });
});

// No test of its own in copier; the rule is `_render_path` and `_render_parts`
// in copier/_main.py: a file whose `.jinja` sibling exists is not written, by
// its source name or by the name it renders to, so the template wins.
test('a file beside its .jinja sibling is not written, and the sibling is', () => {
  const result = render(
    [
      template(ripe, {
        'a.txt.jinja': 'rendered {{ ripe }}',
        'a.txt': 'plain',
        'b.md.jinja': 'rendered',
        '{{ target }}.md': 'plain',
        'dir/c.txt.jinja': 'rendered',
        'dir/c.txt': 'plain',
      }),
    ],
    { ripe: true, target: 'b' },
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(listing(result.tree), { 'a.txt': 'rendered True', 'b.md': 'rendered', 'dir/c.txt': 'rendered' });
});

// Decided in the design (§ 2.6): copier copies or keeps a symlink, a template
// holding one is an error here.
test('a symlink below files/ is an error naming its path', () => {
  const result = render(
    [template(ripe, { 'shelf/apple.txt': 'x', 'shelf/link.txt': { text: 'apple.txt', mode: SYMLINK | 0o777 } })],
    { ripe: true },
  );
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.template, 'basket');
  assert.equal(result.errors[0]?.path, 'files/shelf/link.txt');
  assert.match(result.errors[0]?.message ?? '', /symlink/);
  assert.deepEqual(listing(result.tree), {});
});

// No original: copier lets the later file overwrite the earlier. Here every
// path is written once, and two sources of one template that render to one path
// are an error naming both, as two templates doing so are (types.ts).
test('two files of one template that render to one path are an error naming both sources', () => {
  const result = render([template(ripe, { 'b.txt': 'plain', '{{ target }}.txt': 'other' })], {
    ripe: true,
    target: 'b',
  });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.template, 'basket');
  assert.equal(result.errors[0]?.path, 'files/{{ target }}.txt');
  assert.ok(result.errors[0]?.message.includes('b.txt'));
  assert.ok(result.errors[0]?.message.includes('{{ target }}.txt'));
  assert.deepEqual(listing(result.tree), {});
});

// tests/test_normal_jinja2.py::test_normal_jinja2. The original sets copier's
// `_envops`, which the engine has none of: its delimiters are Jinja's defaults,
// so `[# GROG #]` stays as text, but blocks are not trimmed, and the lines of
// the `if` stay as the indent and newline around them. Passes before this
// issue's code, like the next test.
test('a template renders with the default Jinja delimiters and no block trimming', () => {
  const todo = 'name: todo\nquestions:\n  name:\n    type: str\n  todo:\n    type: str\n';
  const source = [
    '[[ {{ name }} TODO LIST]]',
    "{# Let's put an ugly not-comment below #}",
    '[# GROG #]',
    "    {% if name == 'Guybrush' %}",
    '    - {{ todo }}',
    '    {% endif %}',
    '',
  ].join('\n');
  const result = render([template(todo, { 'TODO.txt.jinja': source })], {
    name: 'Guybrush',
    todo: 'Become a pirate',
  });
  assert.deepEqual(listing(result.tree), {
    'TODO.txt': '[[ Guybrush TODO LIST]]\n\n[# GROG #]\n    \n    - Become a pirate\n    \n',
  });
});

// tests/test_normal_jinja2.py::test_to_not_keep_trailing_newlines_in_jinja2,
// inverted: copier can be told to drop the trailing newline, the engine always
// keeps it.
test('a rendered file keeps its trailing newline', () => {
  const data = 'name: data\nquestions:\n  data:\n    type: str\n';
  const result = render([template(data, { 'data.txt.jinja': 'This is {{ data }}.\n' })], { data: 'foo' });
  assert.deepEqual(listing(result.tree), { 'data.txt': 'This is foo.\n' });
});

// No original: copier writes a file below a directory that renders to `.` at
// the directory's parent, and so do we.
test('a directory part that renders to . or x/.. puts its files at the parent', () => {
  for (const target of ['.', 'x/..']) {
    const result = render([template(where, { '{{ target }}/f.txt': 'f', 'keep/{{ target }}/g.txt': 'g' })], { target });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(listing(result.tree), { 'f.txt': 'f', 'keep/g.txt': 'g' });
  }
});
