// The manifest, read through render: what each part of it does to the result,
// and every way it can be wrong.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIRECTORY, render } from './index.ts';
import { template } from './testing/trees.ts';

test('render gives each path its template and its policy, born-once where the manifest says so by source path', () => {
  const result = render(
    [
      template('name: basket\npolicies:\n  notes.md.jinja: born-once\n  README.md: merge\n', {
        'notes.md.jinja': 'notes',
        'README.md': 'read me',
        'shelf/label.txt': 'label',
      }),
    ],
    {},
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    new Map(result.files),
    new Map([
      ['notes.md', { template: 'basket', policy: 'born-once' }],
      ['README.md', { template: 'basket', policy: 'merge' }],
      ['shelf/label.txt', { template: 'basket', policy: 'merge' }],
    ]),
  );
});

test('render returns the birth commands in the manifest order, as argument vectors it does not run', () => {
  const result = render(
    [template('name: basket\nbirth:\n  - [weave, --tight]\n  - [fill, basket, "with fruit"]\n', { 'a.txt': 'a' })],
    {},
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.birth, [
    { template: 'basket', command: ['weave', '--tight'] },
    { template: 'basket', command: ['fill', 'basket', 'with fruit'] },
  ]);
});

test('render accepts a manifest that uses every field, and ignores what lies beside template.yml and files/', () => {
  const manifest = `name: fruit-basket
questions:
  fruit:
    type: str
    default: apple
    help: The fruit in the basket
    when: true
    validator: "{% if fruit == 'stone' %}not a fruit{% endif %}"
    choices: [apple, pear]
  count:
    type: int
    when: "{{ fruit == 'pear' }}"
    choices: {one: 1, two: 2}
  ripe:
  shape:
    choices: "[round, long]"
reads:
  colour:
  size: {default: small}
  weight: {default: null}
policies:
  "notes.md.jinja": born-once
birth:
  - [weave]
`;
  const tree = template(manifest, { 'notes.md.jinja': '{{ fruit }}' });
  const result = render([new Map([...tree, ['NOTES.md', { bytes: new Uint8Array(), mode: 0o100644 }]])], {
    fruit: 'pear',
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual([...result.tree.keys()], ['notes.md']);
});

const problems: [string, string | undefined, { template: string; question?: string; message: RegExp }][] = [
  ['no template.yml', undefined, { template: '#1', message: /no template\.yml/ }],
  ['YAML that does not parse', 'name: [basket\n', { template: '#1', message: /YAML/ }],
  ['a manifest that is not a map', '- basket\n', { template: '#1', message: /map/ }],
  ['no name', 'questions: {}\n', { template: '#1', message: /name/ }],
  ['a name that is not a slug', 'name: Fruit Basket\n', { template: '#1', message: /name/ }],
  ['an unknown key', 'name: basket\ncolour: red\n', { template: 'basket', message: /colour/ }],
  ['questions that are not a map', 'name: basket\nquestions: [fruit]\n', { template: 'basket', message: /questions/ }],
  [
    'a question name that is no variable',
    'name: basket\nquestions:\n  fruit-kind: {}\n',
    { template: 'basket', question: 'fruit-kind', message: /name/ },
  ],
  [
    'a question name that starts with an underscore',
    'name: basket\nquestions:\n  _fruit: {}\n',
    { template: 'basket', question: '_fruit', message: /name/ },
  ],
  [
    'a question that is not a map',
    'name: basket\nquestions:\n  fruit: apple\n',
    { template: 'basket', question: 'fruit', message: /map/ },
  ],
  [
    'an unknown field of a question',
    'name: basket\nquestions:\n  fruit: {colour: red}\n',
    { template: 'basket', question: 'fruit', message: /colour/ },
  ],
  [
    'an unknown type',
    'name: basket\nquestions:\n  fruit: {type: string}\n',
    { template: 'basket', question: 'fruit', message: /type/ },
  ],
  [
    'a help that is not a string',
    'name: basket\nquestions:\n  fruit: {help: 3}\n',
    { template: 'basket', question: 'fruit', message: /help/ },
  ],
  [
    'a when that is neither a boolean nor a string',
    'name: basket\nquestions:\n  fruit: {when: 3}\n',
    { template: 'basket', question: 'fruit', message: /when/ },
  ],
  [
    'a validator that is not a string',
    'name: basket\nquestions:\n  fruit: {validator: [a]}\n',
    { template: 'basket', question: 'fruit', message: /validator/ },
  ],
  [
    'choices that are neither a list, a map nor a string',
    'name: basket\nquestions:\n  fruit: {choices: 3}\n',
    { template: 'basket', question: 'fruit', message: /choices/ },
  ],
  ['reads that are not a map', 'name: basket\nreads: [colour]\n', { template: 'basket', message: /reads/ }],
  [
    'a read name that is no variable',
    'name: basket\nreads:\n  fruit colour:\n',
    { template: 'basket', question: 'fruit colour', message: /name/ },
  ],
  [
    'a read that is neither empty nor a map',
    'name: basket\nreads:\n  colour: red\n',
    { template: 'basket', question: 'colour', message: /default/ },
  ],
  [
    'an unknown field of a read',
    'name: basket\nreads:\n  colour: {help: hue}\n',
    { template: 'basket', question: 'colour', message: /help/ },
  ],
  [
    'a read of the template’s own question',
    'name: basket\nquestions:\n  colour: {}\nreads:\n  colour:\n',
    { template: 'basket', question: 'colour', message: /own/ },
  ],
  ['policies that are not a map', 'name: basket\npolicies: [a.txt]\n', { template: 'basket', message: /policies/ }],
  ['an unknown policy', 'name: basket\npolicies:\n  a.txt: keep\n', { template: 'basket', message: /keep/ }],
  [
    'a policy for a path that is no file below files/',
    'name: basket\npolicies:\n  b.txt: born-once\n',
    { template: 'basket', message: /b\.txt/ },
  ],
  [
    'a policy for a directory below files/',
    'name: basket\npolicies:\n  shelf: born-once\n',
    { template: 'basket', message: /shelf/ },
  ],
  ['birth that is not a list', 'name: basket\nbirth: weave\n', { template: 'basket', message: /birth/ }],
  [
    'a birth command that is a string',
    'name: basket\nbirth:\n  - weave tight\n',
    { template: 'basket', message: /birth/ },
  ],
  ['an empty birth command', 'name: basket\nbirth:\n  - []\n', { template: 'basket', message: /birth/ }],
  [
    'a birth command with an argument that is not a string',
    'name: basket\nbirth:\n  - [weave, 3]\n',
    { template: 'basket', message: /birth/ },
  ],
];

for (const [what, manifest, expected] of problems) {
  test(`render reports a manifest with ${what}, and returns no files`, () => {
    const files = { 'a.txt': 'a', shelf: { text: '', mode: DIRECTORY } };
    const tree = manifest === undefined ? new Map([...template('', files)].slice(1)) : template(manifest, files);
    const result = render([tree], {});
    assert.equal(result.errors.length, 1, JSON.stringify(result.errors));
    const [error] = result.errors;
    assert.equal(error?.template, expected.template);
    assert.equal(error?.path, 'template.yml');
    assert.equal(error?.question, expected.question);
    assert.match(error?.message ?? '', expected.message);
    assert.deepEqual([...result.tree], []);
  });
}

test('render reports every problem of a manifest at once', () => {
  const result = render(
    [template('name: basket\ncolour: red\nquestions:\n  fruit: {type: string}\n  _size: {}\nbirth: weave\n')],
    {},
  );
  assert.deepEqual(
    result.errors.map(({ question }) => question),
    [undefined, 'fruit', '_size', undefined],
  );
});
