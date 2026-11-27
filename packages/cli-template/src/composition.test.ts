// Several templates rendered into one tree: one namespace of answers, the
// answers a template reads from another, the names of the templates rendered
// together, one owner per path, and a tree that does not depend on the order
// the templates are given in. The fixtures are a basket, which owns `fruit`, a
// shelf, which owns `book`, and the templates that read from them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIRECTORY, type RenderError, render } from './index.ts';
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

test('a read with a default sees the default when nothing supplies it, and a supplied value wins over it', () => {
  const box = 'name: box\nreads:\n  trees: {default: 1}\n';
  const files = { 'box.txt.jinja': '{{ trees }}' };
  const alone = render([template(box, files)], {});
  assert.deepEqual(alone.errors, []);
  assert.deepEqual(listing(alone.tree), { 'box.txt': '1' });
  const given = render([template(box, files)], { trees: 7 });
  assert.deepEqual(listing(given.tree), { 'box.txt': '7' });
  const owned = render([template(orchard), template(box, files)], { trees: '9' });
  assert.deepEqual(owned.errors, []);
  assert.deepEqual(listing(owned.tree), { 'box.txt': '9' });
});

test('the order of the templates does not change the tree: an owner is resolved before the templates that read from it', () => {
  const box = 'name: box\nquestions:\n  lid:\n    type: str\n    default: "{{ rows }} rows"\nreads:\n  rows:\n';
  const reader = template(crate, { 'crate.txt.jinja': '{{ trees + rows }}' });
  const lidded = template(box, { 'box.txt.jinja': '{{ lid }}' });
  const owner = template(orchard, { 'orchard.txt.jinja': '{{ trees }}' });
  const results = [
    [reader, lidded, owner],
    [owner, lidded, reader],
    [lidded, reader, owner],
  ].map((templates) => render(templates, { trees: '4' }));
  for (const result of results) {
    assert.deepEqual(result.errors, []);
    assert.deepEqual(listing(result.tree), { 'crate.txt': '6', 'box.txt': '2 rows', 'orchard.txt': '4' });
    assert.deepEqual(result.answers, { trees: 4, rows: 2, lid: '2 rows' });
    assert.deepEqual(new Map(result.files), new Map(results[0]?.files));
  }
});

test('templates that read from each other in a cycle are one error naming them, and a template that reads from them adds none', () => {
  const reading = (name: string, owns: string, reads: string) =>
    template(`name: ${name}\nquestions:\n  ${owns}:\n    type: str\nreads:\n  ${reads}:\n`, { [`${name}.txt`]: name });
  const result = render(
    [
      reading('basket', 'fruit', 'book'),
      template(crate, { 'crate.txt.jinja': '{{ trees }}' }),
      reading('orchard', 'trees', 'fruit'),
      reading('shelf', 'book', 'fruit'),
    ],
    { fruit: 'pear', book: 'atlas', trees: 'oak', rows: 1 },
  );
  assert.deepEqual(where(result.errors), [
    { template: 'basket', other: 'shelf', path: 'template.yml', question: undefined },
  ]);
  assert.equal(
    result.errors[0]?.message,
    'the reads of basket and shelf form a cycle: basket reads book from shelf, shelf reads fruit from basket',
  );
  const three = render(
    [reading('basket', 'fruit', 'book'), reading('shelf', 'book', 'trees'), reading('orchard', 'trees', 'fruit')],
    {},
  );
  assert.deepEqual(
    three.errors.map(({ message }) => message),
    [
      'the reads of basket, shelf and orchard form a cycle: basket reads book from shelf, shelf reads trees from orchard, orchard reads fruit from basket',
    ],
  );
});

test('a given answer that no template owns or reads is listed as unused and is no error; one that a template reads is used', () => {
  const result = render([template(basket), template(crate)], { fruit: 'pear', trees: 3, rows: 1, colour: 'red' });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.unused, ['colour']);
  assert.deepEqual(result.answers, { fruit: 'pear' });
});

test('the names of the templates rendered together are a variable, _templates, in files, paths and questions, in the order of the names', () => {
  const together = `name: crate
questions:
  label:
    type: str
    default: "{{ _templates | join(' ') }}"
  lid:
    type: bool
    default: true
    when: "{{ 'basket' in _templates }}"
`;
  const crated = template(together, {
    'names.txt.jinja': "{{ _templates | join(',') }} {{ label }}",
    "{% if 'basket' in _templates %}for-basket.txt{% endif %}": 'x',
    "{% if 'shelf' in _templates %}for-shelf.txt{% endif %}": 'x',
  });
  for (const templates of [
    [crated, template(basket)],
    [template(basket), crated],
  ]) {
    const result = render(templates, { fruit: 'pear' });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.answers, { fruit: 'pear', label: 'basket crate', lid: true });
    assert.deepEqual(listing(result.tree), { 'names.txt': 'basket,crate basket crate', 'for-basket.txt': 'x' });
  }
  const alone = render([crated], {});
  assert.deepEqual(alone.answers, { label: 'crate' });
  assert.deepEqual(listing(alone.tree), { 'names.txt': 'crate crate' });
});

test('two templates rendering the same path is an error naming both, and the render writes nothing', () => {
  const result = render(
    [
      template(basket, { 'label.txt': 'plain', 'basket.txt': 'b' }),
      template(shelf, { '{{ book }}.txt.jinja': '{{ book }}', 'shelf.txt': 's' }),
    ],
    { fruit: 'pear', book: 'label' },
  );
  assert.deepEqual(where(result.errors), [
    { template: 'basket', other: 'shelf', path: 'files/label.txt', question: undefined },
  ]);
  assert.equal(
    result.errors[0]?.message,
    "basket's label.txt and shelf's {{ book }}.txt.jinja both render to label.txt",
  );
  assert.deepEqual(listing(result.tree), {});
  assert.deepEqual([...result.files], []);
});

test("a file of one template with another template's path below it is an error naming both", () => {
  const result = render([template(shelf, { '{{ book }}/page.txt': 'p' }), template(basket, { atlas: 'a file' })], {
    fruit: 'pear',
    book: 'atlas',
  });
  assert.deepEqual(where(result.errors), [
    { template: 'basket', other: 'shelf', path: 'files/atlas', question: undefined },
  ]);
  assert.equal(
    result.errors[0]?.message,
    "basket's atlas renders to atlas, a file, and shelf's {{ book }}/page.txt renders to atlas/page.txt below it",
  );
  assert.deepEqual(listing(result.tree), {});
});

test("an empty directory is written by one template: two leaving it empty is an error naming both, and one is implied by the other's files below it", () => {
  const dir = { text: '', mode: DIRECTORY | 0o755 };
  const both = render([template(basket, { attic: dir }), template(shelf, { '{{ book }}': dir })], {
    fruit: 'pear',
    book: 'attic',
  });
  assert.deepEqual(where(both.errors), [
    { template: 'basket', other: 'shelf', path: 'files/attic', question: undefined },
  ]);
  assert.equal(both.errors[0]?.message, "basket's attic and shelf's {{ book }} both render to attic");
  const below = render([template(basket, { attic: dir }), template(shelf, { '{{ book }}/old.txt': 'o' })], {
    fruit: 'pear',
    book: 'attic',
  });
  assert.deepEqual(below.errors, []);
  assert.deepEqual(listing(below.tree), { 'attic/old.txt': 'o' });
  assert.deepEqual(new Map(below.files), new Map([['attic/old.txt', { template: 'shelf', policy: 'merge' }]]));
});

test('a template whose question fails renders no files, so that the files using its answer add no second error', () => {
  const result = render(
    [
      template(basket, { '{{ fruit }}.txt.jinja': '{{ fruit }}', 'kind.txt.jinja': 'a {{ fruit }}' }),
      template(shelf, { 'shelf.txt.jinja': '{{ book }}' }),
    ],
    { book: 'atlas' },
  );
  assert.deepEqual(where(result.errors), [
    { template: 'basket', other: undefined, path: undefined, question: 'fruit' },
  ]);
});
