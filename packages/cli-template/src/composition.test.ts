// Several templates rendered into one tree: one namespace of answers, the
// answers a template reads from another, the names of the templates rendered
// together, one owner per path, and a tree that does not depend on the order
// the templates are given in. The fixtures are small: a basket, which owns
// `fruit`, a shelf, which owns `book`, an orchard, which owns `trees` and
// `rows`, a pantry with questions its `when` skips, and the crates and boxes
// that read from them.
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
  const reader = 'name: crate\nreads:\n  fruit:\n  colour:\n';
  const result = render([template(reader, { 'crate.txt': 'empty' })], {});
  assert.deepEqual(where(result.errors), [
    { template: 'crate', other: undefined, path: 'template.yml', question: 'fruit' },
    { template: 'crate', other: undefined, path: 'template.yml', question: 'colour' },
  ]);
  assert.match(result.errors[0]?.message ?? '', /fruit/);
  assert.deepEqual(listing(result.tree), {});
});

test('a given answer that no template of the render owns satisfies a declared read, as given, in files, paths and questions', () => {
  const reader =
    'name: crate\nquestions:\n  label:\n    type: str\n    default: "{{ fruit }} x{{ count }}"\nreads:\n  fruit:\n  count:\n';
  const result = render(
    [template(reader, { '{{ fruit }}/label.txt.jinja': '{{ label }}, {{ count + 1 }} next time' })],
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

/** A render's result as JSON, every map and record in its iteration order, without the birth commands. */
const serialised = ({ tree, files, answers, unused, errors }: ReturnType<typeof render>) =>
  JSON.stringify({
    tree: [...tree].map(([path, { bytes, mode }]) => [path, [...bytes], mode]),
    files: [...files],
    answers,
    unused,
    errors,
  });

test('the order of the templates does not change the result but for the birth commands: an owner is resolved before the templates that read from it', () => {
  const box =
    'name: box\nquestions:\n  lid:\n    type: str\n    default: "{{ rows }} rows"\nreads:\n  rows:\nbirth:\n  - [close]\n';
  const reader = template(crate, { 'crate.txt.jinja': '{{ trees + rows }}', 'b/c.txt': 'c' });
  const lidded = template(box, { 'box.txt.jinja': '{{ lid }}', 'b.txt': 'b' });
  const owner = template(`${orchard}birth:\n  - [plant]\n`, { 'orchard.txt.jinja': '{{ trees }}' });
  const orders = [
    [reader, lidded, owner],
    [owner, lidded, reader],
    [lidded, reader, owner],
  ];
  const [first, ...rest] = orders.map((templates) => render(templates, { zinc: 1, trees: '4', amber: 2 }));
  assert.ok(first);
  assert.deepEqual(first.errors, []);
  assert.deepEqual(listing(first.tree), {
    'b.txt': 'b',
    'b/c.txt': 'c',
    'box.txt': '2 rows',
    'crate.txt': '6',
    'orchard.txt': '4',
  });
  assert.deepEqual([...first.tree.keys()], ['b.txt', 'b/c.txt', 'box.txt', 'crate.txt', 'orchard.txt']);
  assert.deepEqual(Object.entries(first.answers), [
    ['lid', '2 rows'],
    ['rows', 2],
    ['trees', 4],
  ]);
  assert.deepEqual(first.unused, ['amber', 'zinc']);
  for (const result of rest) assert.equal(serialised(result), serialised(first));
  assert.deepEqual(
    [first, ...rest].map(({ birth }) => birth.map(({ command }) => command[0])),
    [
      ['close', 'plant'],
      ['plant', 'close'],
      ['close', 'plant'],
    ],
  );
});

test('the order of the templates does not change the errors: an error between two names the first by name in template', () => {
  const books = template(shelf, { 'label.txt': 's' });
  const wrong = template('name: crate\ncolour: red\n');
  const trees = template(orchard);
  const fruit = template(basket, { 'label.txt': 'b' });
  const [first, ...rest] = [
    [books, wrong, trees, fruit],
    [fruit, trees, wrong, books],
    [trees, books, fruit, wrong],
  ].map((templates) => render(templates, { fruit: 'pear', book: 'atlas' }).errors);
  assert.deepEqual(
    first?.map(({ template, other }) => [template, other]),
    [
      ['basket', 'shelf'],
      ['crate', undefined],
      ['orchard', undefined],
      ['orchard', undefined],
    ],
  );
  for (const errors of rest) assert.equal(JSON.stringify(errors), JSON.stringify(first));
});

test('templates that read from each other in a cycle, and those that read from them, are one error naming them all by name', () => {
  const reading = (name: string, owns: string, ...reads: string[]) =>
    template(
      `name: ${name}\nquestions:\n  ${owns}:\n    type: str\nreads:\n${reads.map((r) => `  ${r}:\n`).join('')}`,
      {
        [`${name}.txt`]: name,
      },
    );
  const result = render(
    [
      reading('shelf', 'book', 'fruit'),
      template(crate, { 'crate.txt.jinja': '{{ trees }}' }),
      reading('orchard', 'trees', 'fruit'),
      reading('basket', 'fruit', 'book'),
    ],
    { fruit: 'pear', book: 'atlas', trees: 'oak', rows: 1 },
  );
  assert.deepEqual(where(result.errors), [
    { template: 'basket', other: 'crate', path: 'template.yml', question: undefined },
  ]);
  assert.equal(
    result.errors[0]?.message,
    'the reads of basket, crate, orchard and shelf wait on each other: basket reads book from shelf, crate reads trees from orchard, orchard reads fruit from basket, shelf reads fruit from basket',
  );
  const apart = render(
    [
      reading('mill', 'flour', 'grain', 'water'),
      reading('well', 'water', 'flour'),
      reading('corn', 'grain', 'seed'),
      reading('drill', 'seed', 'grain'),
    ],
    {},
  );
  assert.deepEqual(
    apart.errors.map(({ message }) => message),
    [
      'the reads of corn, drill, mill and well wait on each other: corn reads seed from drill, drill reads grain from corn, mill reads grain from corn, mill reads water from well, well reads flour from mill',
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

test("an empty directory several templates hold is one directory, owned by the first by name, and one is implied by another template's files below it", () => {
  const dir = { text: '', mode: DIRECTORY | 0o755 };
  const held = [template(shelf, { '{{ book }}/{% if false %}x{% endif %}': 'x' }), template(basket, { attic: dir })];
  for (const templates of [held, [...held].reverse()]) {
    const both = render(templates, { fruit: 'pear', book: 'attic' });
    assert.deepEqual(both.errors, []);
    assert.deepEqual(listing(both.tree), { attic: dir });
    assert.deepEqual(new Map(both.files), new Map([['attic', { template: 'basket', policy: 'merge' }]]));
  }
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

test('a template whose read fails renders no files, so that the files using the read add no second error', () => {
  const box = 'name: box\nreads:\n  colour:\n';
  const result = render([template(box, { '{{ colour }}.txt.jinja': '{{ colour }}' })], {});
  assert.deepEqual(where(result.errors), [
    { template: 'box', other: undefined, path: 'template.yml', question: 'colour' },
  ]);
});

test("a read of a question that fails in its owner adds no error, and the reader's own questions are still resolved", () => {
  const owner = 'name: orchard\nquestions:\n  trees:\n    type: int\n';
  const box = 'name: box\nquestions:\n  lid:\n    type: str\nreads:\n  trees:\n';
  const result = render([template(box, { 'box.txt.jinja': '{{ trees }}' }), template(owner)], {});
  assert.deepEqual(where(result.errors), [
    { template: 'box', other: undefined, path: undefined, question: 'lid' },
    { template: 'orchard', other: undefined, path: undefined, question: 'trees' },
  ]);
});

const pantry = `name: pantry
questions:
  stocked:
    type: bool
  jam:
    type: str
    default: plum
    when: "{{ stocked }}"
  honey:
    type: str
    when: "{{ stocked }}"
`;

test("a read of a question its owner skips sees what the owner's files see: the default", () => {
  const reader = 'name: box\nreads:\n  jam:\n';
  const result = render([template(reader, { 'box.txt.jinja': '{{ jam }}' }), template(pantry)], { stocked: false });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.answers, { stocked: false });
  assert.deepEqual(listing(result.tree), { 'box.txt': 'plum' });
});

test('a read of a question its owner skips without a default takes the read default, and without one is an error naming the owner', () => {
  const optional = render(
    [template('name: box\nreads:\n  honey: {default: none}\n', { 'box.txt.jinja': '{{ honey }}' }), template(pantry)],
    {
      stocked: false,
    },
  );
  assert.deepEqual(optional.errors, []);
  assert.deepEqual(listing(optional.tree), { 'box.txt': 'none' });
  const required = render(
    [template('name: box\nreads:\n  honey:\n', { 'box.txt.jinja': '{{ honey }}' }), template(pantry)],
    {
      stocked: false,
    },
  );
  assert.deepEqual(where(required.errors), [
    { template: 'box', other: 'pantry', path: 'template.yml', question: 'honey' },
  ]);
  assert.equal(required.errors[0]?.message, 'box reads honey, which pantry owns and skips without a default');
});

test('a read that nothing supplies adds no error when a template of the render failed to read, and the reader renders no files', () => {
  const box = 'name: box\nreads:\n  trees:\n';
  const broken = render(
    [
      template('name: orchard\nquestions:\n  trees:\n    type: tree\n'),
      template(box, { 'box.txt.jinja': '{{ trees }}' }),
    ],
    {},
  );
  assert.deepEqual(where(broken.errors), [
    { template: 'orchard', other: undefined, path: 'template.yml', question: 'trees' },
  ]);
  const twice = render(
    [template('name: orchard\n'), template(orchard), template(box, { 'box.txt.jinja': '{{ trees }}' })],
    {},
  );
  assert.deepEqual(where(twice.errors), [
    { template: 'orchard', other: 'orchard', path: 'template.yml', question: undefined },
  ]);
});

test('a question two templates declare is owned, for reads, by the template whose name sorts first', () => {
  const walnut = template('name: walnut\nquestions:\n  trees:\n    type: str\n');
  const acorn = template('name: acorn\nquestions:\n  trees:\n    type: int\n');
  const box = template('name: box\nreads:\n  trees:\n', { 'box.txt.jinja': '{{ trees + 1 }}' });
  for (const templates of [
    [walnut, acorn, box],
    [box, acorn, walnut],
  ]) {
    const result = render(templates, { trees: 'x' });
    assert.deepEqual(where(result.errors), [
      { template: 'acorn', other: 'walnut', path: 'template.yml', question: 'trees' },
      { template: 'acorn', other: undefined, path: undefined, question: 'trees' },
    ]);
  }
});

test('a reader whose only fault is a read its owner failed to resolve renders no files', () => {
  const owner = 'name: orchard\nquestions:\n  trees:\n    type: int\n';
  const box = 'name: box\nreads:\n  trees:\n';
  const result = render([template(box, { 'box.txt.jinja': '{{ trees }}' }), template(owner)], {});
  assert.deepEqual(where(result.errors), [
    { template: 'orchard', other: undefined, path: undefined, question: 'trees' },
  ]);
});

test("an empty directory of one template at another template's file is an error naming the first by name in template", () => {
  const dir = { text: '', mode: DIRECTORY | 0o755 };
  for (const templates of [
    [template(basket, { attic: dir }), template(shelf, { '{{ book }}': 'a file' })],
    [template(shelf, { '{{ book }}': 'a file' }), template(basket, { attic: dir })],
  ]) {
    const result = render(templates, { fruit: 'pear', book: 'attic' });
    assert.deepEqual(where(result.errors), [
      { template: 'basket', other: 'shelf', path: 'files/attic', question: undefined },
    ]);
    assert.equal(result.errors[0]?.message, "basket's attic and shelf's {{ book }} both render to attic");
  }
});
