// Several templates rendered into one tree: one namespace of answers, the
// answers a template reads from another, the names of the templates rendered
// together, one owner per path, and a tree that does not depend on the order
// the templates are given in. The fixtures are a basket, which owns `fruit`, a
// shelf, which owns `book`, and the templates that read from them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type RenderError, render } from './index.ts';
import { listing, template } from './testing/trees.ts';

const basket = 'name: basket\nquestions:\n  fruit:\n    type: str\n';
const shelf = 'name: shelf\nquestions:\n  book:\n    type: str\n';

/** Where each error points, without its message. */
const where = (errors: readonly RenderError[]) =>
  errors.map(({ template, other, path, question }) => ({ template, other, path, question }));

test('answers are one namespace: each template takes the given answers to its own questions', () => {
  const result = render(
    [template(basket, { 'basket.txt.jinja': '{{ fruit }}' }), template(shelf, { 'shelf.txt.jinja': '{{ book }}' })],
    { fruit: 'pear', book: 'atlas' },
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.answers, { fruit: 'pear', book: 'atlas' });
  assert.deepEqual(listing(result.tree), { 'basket.txt': 'pear', 'shelf.txt': 'atlas' });
});

test('a file that uses an answer another template owns, without declaring it, is an error, in its content and in its path', () => {
  const result = render(
    [
      template(basket, { 'basket.txt.jinja': '{{ fruit }}' }),
      template(shelf, { 'shelf.txt.jinja': 'beside {{ fruit }}', '{{ fruit }}.txt': 'x' }),
    ],
    { fruit: 'pear', book: 'atlas' },
  );
  assert.deepEqual(where(result.errors), [
    { template: 'shelf', other: undefined, path: 'files/shelf.txt.jinja', question: undefined },
    { template: 'shelf', other: undefined, path: 'files/{{ fruit }}.txt', question: undefined },
  ]);
  for (const { message } of result.errors) assert.match(message, /undefined/);
});

test('a question that uses an answer another template owns, without declaring it, is an error, in its default, when, choices and validator', () => {
  for (const field of [
    'default: "{{ fruit }}"',
    'when: "{{ fruit }}"',
    'choices: "[{{ fruit }}]"',
    'validator: "{{ fruit }}"',
  ]) {
    const reader = `name: shelf\nquestions:\n  book:\n    type: str\n    ${field}\n`;
    const given = field.startsWith('default') ? { fruit: 'pear' } : { fruit: 'pear', book: 'pear' };
    const result = render([template(basket), template(reader)], given);
    assert.deepEqual(
      where(result.errors),
      [{ template: 'shelf', other: undefined, path: undefined, question: 'book' }],
      field,
    );
    assert.match(result.errors[0]?.message ?? '', /undefined/, field);
  }
});

test('the result names, for each path, the template that wrote it and its policy', () => {
  const result = render(
    [
      template('name: basket\npolicies:\n  label.txt: born-once\n', { 'label.txt': 'a', 'basket/notes.txt': 'b' }),
      template('name: shelf\npolicies:\n  shelf/index.txt: born-once\n', { 'shelf/index.txt': 'c', 'README.md': 'd' }),
    ],
    {},
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    new Map(result.files),
    new Map([
      ['label.txt', { template: 'basket', policy: 'born-once' }],
      ['basket/notes.txt', { template: 'basket', policy: 'merge' }],
      ['shelf/index.txt', { template: 'shelf', policy: 'born-once' }],
      ['README.md', { template: 'shelf', policy: 'merge' }],
    ]),
  );
});

test('the result lists the birth commands of each template in the order the templates were given, and runs none', () => {
  const weave = template('name: basket\nbirth:\n  - [weave]\n  - [fill, basket]\n', { 'a.txt': 'a' });
  const build = template('name: shelf\nbirth:\n  - [build, shelf]\n', { 'b.txt': 'b' });
  assert.deepEqual(render([build, weave], {}).birth, [
    { template: 'shelf', command: ['build', 'shelf'] },
    { template: 'basket', command: ['weave'] },
    { template: 'basket', command: ['fill', 'basket'] },
  ]);
  assert.deepEqual(
    render([weave, build], {}).birth.map(({ template }) => template),
    ['basket', 'basket', 'shelf'],
  );
});

test('two templates declaring the same question is an error naming both, and the render writes nothing', () => {
  const other = 'name: crate\nquestions:\n  fruit:\n    type: str\n';
  const result = render([template(basket, { 'a.txt': 'a' }), template(other, { 'b.txt': 'b' })], { fruit: 'pear' });
  assert.deepEqual(where(result.errors), [
    { template: 'basket', other: 'crate', path: 'template.yml', question: 'fruit' },
  ]);
  assert.match(result.errors[0]?.message ?? '', /basket/);
  assert.match(result.errors[0]?.message ?? '', /crate/);
  assert.deepEqual(listing(result.tree), {});
});

test('two templates of one name is an error naming both by their position', () => {
  const result = render([template(basket, { 'a.txt': 'a' }), template('name: basket\n', { 'b.txt': 'b' })], {
    fruit: 'pear',
  });
  assert.deepEqual(where(result.errors), [
    { template: 'basket', other: 'basket', path: 'template.yml', question: undefined },
  ]);
  assert.equal(result.errors[0]?.message, 'templates 1 and 2 are both named basket');
  assert.deepEqual(listing(result.tree), {});
});

test('a declared read that no template of the render owns and no answer gives is an error naming the template and the read', () => {
  const crate = 'name: crate\nreads:\n  fruit:\n  colour:\n';
  const result = render([template(crate, { 'crate.txt': 'empty' })], {});
  assert.deepEqual(where(result.errors), [
    { template: 'crate', other: undefined, path: 'template.yml', question: 'fruit' },
    { template: 'crate', other: undefined, path: 'template.yml', question: 'colour' },
  ]);
  assert.match(result.errors[0]?.message ?? '', /fruit/);
  assert.deepEqual(listing(result.tree), {});
});

test('a given answer that no template of the render owns satisfies a declared read, as given, in files, paths and questions', () => {
  const crate =
    'name: crate\nquestions:\n  label:\n    type: str\n    default: "{{ fruit }} x{{ count }}"\nreads:\n  fruit:\n  count:\n';
  const result = render(
    [template(crate, { '{{ fruit }}/label.txt.jinja': '{{ label }}, {{ count + 1 }} next time' })],
    { fruit: 'pear', count: 3 },
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.answers, { label: 'pear x3' });
  assert.deepEqual(listing(result.tree), { 'pear/label.txt': 'pear x3, 4 next time' });
});

const orchard =
  'name: orchard\nquestions:\n  trees:\n    type: int\n  rows:\n    type: int\n    default: "{{ trees // 2 }}"\n';
const crate = 'name: crate\nreads:\n  trees:\n  rows:\n';

test('a declared read that another template of the render owns sees the answer that template resolved', () => {
  const result = render(
    [
      template(orchard, { 'orchard.txt.jinja': '{{ trees }}' }),
      template(crate, { 'crate.txt.jinja': '{{ trees + rows }}' }),
    ],
    { trees: '4' },
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.answers, { trees: 4, rows: 2 });
  assert.deepEqual(listing(result.tree), { 'orchard.txt': '4', 'crate.txt': '6' });
});
