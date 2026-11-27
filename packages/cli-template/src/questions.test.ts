// The questions of a template, resolved through render: which answer a
// question takes, which questions apply, what a missing, mistyped or invalid
// answer reports, and which given answers belong to no question.
// A question's value is seen in `result.answers` and, as the template's files
// see it, in a file that prints it. Tests named after a copier original (v9.19.1,
// see LICENSE.copier) are ported from it and rewritten against `render`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { render } from './index.ts';
import { listing, template } from './testing/trees.ts';

/** Renders one template of `questions` (a YAML map of them) with a file `out.txt` printing `body`. */
function basket(questions: string, given: Record<string, unknown>, body = '') {
  const manifest = `name: basket\nquestions:\n${questions.replace(/^/gm, '  ')}\n`;
  const result = render([template(manifest, { 'out.txt.jinja': body })], given);
  return { ...result, out: listing(result.tree)['out.txt'] };
}

test('a given answer wins over the default of its question', () => {
  const result = basket('fruit:\n  default: apple', { fruit: 'pear' }, '{{ fruit }}');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.answers, { fruit: 'pear' });
  assert.equal(result.out, 'pear');
});

test('a question with no given answer takes its default, and the answers report it', () => {
  const result = basket('fruit:\n  default: apple\nripe:\n  default: true', {}, '{{ fruit }} {{ ripe }}');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.answers, { fruit: 'apple', ripe: true });
  assert.equal(result.out, 'apple True');
});

test('a default may be Jinja over the answers before it, given or defaulted', () => {
  const result = basket(
    'fruit:\n  default: apple\nlabel:\n  default: "{{ fruit | upper }} basket"\nsign:\n  default: "{{ label }}!"',
    { fruit: 'pear' },
    '{{ sign }}',
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.answers, { fruit: 'pear', label: 'PEAR basket', sign: 'PEAR basket!' });
  assert.equal(result.out, 'PEAR basket!');
});

test('a default that uses a variable nothing supplies is an error naming its question', () => {
  const result = basket('label:\n  default: "{{ fruit }} basket"', {});
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.question, 'label');
  assert.equal(result.errors[0]?.template, 'basket');
  assert.match(result.errors[0]?.message ?? '', /fruit/);
});

// Ported from tests/test_copy.py::test_validate_init_data_with_skipped_question.
test('a question whose when is false is skipped, and the question its when selects applies', () => {
  const questions = `kind:
  help: What kind do you need?
  choices: [foo, bar]
testbar:
  when: "{{ kind == 'bar' }}"
  type: str
  help: any string bar?
testfoo:
  when: "{{ kind == 'foo' }}"
  type: str
  help: any string foo?`;
  const result = basket(
    questions,
    { kind: 'foo', testfoo: 'helloworld' },
    "{{ kind }}|{{ testbar | default('') }}|{{ testfoo }}",
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.answers, { kind: 'foo', testfoo: 'helloworld' });
  assert.equal(result.out, 'foo||helloworld');
});

// Ported from tests/test_complex_questions.py::test_omit_answer_for_skipped_question, with the
// answers file replaced by the answers `render` reports.
test('a skipped question is left out of the answers, and its default, else its given answer, is what the files see', () => {
  const result = basket(
    'disabled:\n  type: str\n  when: false\ndisabled_with_default:\n  type: str\n  default: hello\n  when: false',
    { disabled: 'bye' },
    '{{ disabled }} {{ disabled_with_default }}',
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.answers, {});
  assert.equal(result.out, 'bye hello');
});

// Adapted from tests/test_copy.py::test_skipped_question_with_unset_default_value: copier marks a
// skipped question without a default by `default: "{{ UNSET }}"`; a manifest has no default instead.
test('a skipped question without a default is absent, and its validator is not rendered', () => {
  const result = basket(
    'q:\n  type: str\n  when: false\n  validator: "{% if not q %}Invalid{% endif %}"',
    {},
    "{{ q | default('<undefined>') }}",
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.answers, {});
  assert.equal(result.out, '<undefined>');
});

// Ported from tests/test_updatediff.py::test_conditional_computed_value, the copy and update steps
// as two renders. The skipped `second` is out of the answers, as in copier's answers file, and the
// files still see its default, `False`.
test('a question whose when and default read an earlier answer applies with it and vanishes without it', () => {
  const questions = 'first:\n  type: bool\nsecond:\n  type: bool\n  default: "{{ first }}"\n  when: "{{ first }}"';
  const body = "{{ first }} {{ second | default('-') }}";
  const on = basket(questions, { first: true }, body);
  assert.deepEqual(on.answers, { first: true, second: true });
  assert.equal(on.out, 'True True');
  const off = basket(questions, { first: false }, body);
  assert.deepEqual(off.errors, []);
  assert.deepEqual(off.answers, { first: false });
  assert.equal(off.out, 'False False');
});

// Ported from tests/test_updatediff.py::test_update_dont_validate_computed_value.
test('a validator is not rendered for a skipped question', () => {
  const result = basket(
    'computed:\n  type: str\n  default: foo\n  when: false\n  validator: "{{ undefined_thing }}"',
    {},
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.answers, {});
});

// Ported from tests/test_copy.py::test_required_question_without_data and
// test_required_choice_question_without_data (a required question is an error, with or without choices).
for (const [type, choices] of [
  ['str', '[one, two, three]'],
  ['int', '[1, 2, 3]'],
  ['float', '[1.0, 2.0, 3.0]'],
  ['bool', undefined],
  ['json', '["[1]", "[2]", "[3]"]'],
  ['yaml', '["- 1", "- 2", "- 3"]'],
] as const) {
  test(`a ${type} question with ${choices === undefined ? 'no choices' : 'choices'}, no answer and no default is an error`, () => {
    const result = basket(`question:\n  type: ${type}${choices === undefined ? '' : `\n  choices: ${choices}`}`, {});
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.question, 'question');
    assert.equal(result.errors[0]?.template, 'basket');
    assert.match(result.errors[0]?.message ?? '', /no answer and no default/);
    assert.deepEqual(listing(result.tree), {});
  });
}

test('every question without an answer and without a default is an error with its help, not only the first', () => {
  const questions = `fruit:
  help: Which fruit is in the basket?
size:
  type: int
  default: 3
colour:
  help: What colour is the basket?
shape:
ripe:
  when: false
  help: Is it ripe?
weave:
  default: null
  help: What is it woven of?`;
  const result = basket(questions, {});
  assert.deepEqual(
    result.errors.map(({ question, message }) => ({ question, message })),
    [
      { question: 'fruit', message: 'no answer and no default: Which fruit is in the basket?' },
      { question: 'colour', message: 'no answer and no default: What colour is the basket?' },
      { question: 'shape', message: 'no answer and no default' },
    ],
  );
  assert.deepEqual(result.answers, { size: 3, weave: null });
});

// Ported from tests/test_copy.py::test_validate_default_value: a default is cast to its question's
// type, and a default that cannot be cast is an error. Python's `TypeError` and `ValueError` are
// both an error here; where Python's `int(1.0)` and the like tell integers from floats, a YAML
// `1.0` is the number 1 here. The `path` type is not ported, and the `secret` ones neither.
const casts: [string, string, unknown][] = [
  ['str', '"string"', 'string'],
  ['str', '"1.0"', '1.0'],
  ['str', '1.5', '1.5'],
  ['str', 'null', 'ERROR'],
  ['int', '1', 1],
  ['int', '1.0', 1],
  ['int', '"1"', 1],
  ['int', '"1.0"', 'ERROR'],
  ['int', '"no-int"', 'ERROR'],
  ['int', '1.5', 'ERROR'],
  ['int', 'null', 'ERROR'],
  ['int', '{}', 'ERROR'],
  ['int', '[]', 'ERROR'],
  ['float', '1.1', 1.1],
  ['float', '1', 1],
  ['float', '"1.1"', 1.1],
  ['float', '"no-float"', 'ERROR'],
  ['float', 'null', 'ERROR'],
  ['float', '{}', 'ERROR'],
  ['float', '[]', 'ERROR'],
  ['bool', 'true', true],
  ['bool', 'false', false],
  ['bool', '"y"', true],
  ['bool', '"n"', false],
  ['bool', 'null', 'ERROR'],
  ['json', '"\\"string\\""', 'string'],
  ['json', '"1"', 1],
  ['json', '1', 1],
  ['json', '"1.1"', 1.1],
  ['json', '"true"', true],
  ['json', 'false', false],
  ['json', '"{}"', {}],
  ['json', '{}', {}],
  ['json', '"[]"', []],
  ['json', '[]', []],
  ['json', '"null"', null],
  ['json', 'null', null],
  ['json', '"{nope"', 'ERROR'],
  ['yaml', '"\\"string\\""', 'string'],
  ['yaml', '"string"', 'string'],
  ['yaml', '"1"', 1],
  ['yaml', '1.1', 1.1],
  ['yaml', '"true"', true],
  ['yaml', 'false', false],
  ['yaml', '"{}"', {}],
  ['yaml', '"[]"', []],
  ['yaml', '"null"', null],
  ['yaml', 'null', null],
];
for (const [type, source, expected] of casts) {
  test(`a ${type} default of ${source} is ${expected === 'ERROR' ? 'an error' : `the answer ${JSON.stringify(expected)}`}`, () => {
    const result = basket(`q:\n  type: ${type}\n  default: ${source}`, {});
    if (expected === 'ERROR') {
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0]?.question, 'q');
    } else {
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.answers, { q: expected });
    }
  });
}

// Ported from tests/test_complex_questions.py::test_api_str_data: answers that arrive as strings,
// as from a command line, are cast to their question's type.
test('given answers that are strings are cast to the question type', () => {
  const questions = `love_me:
  type: bool
your_name:
  type: str
your_age:
  type: int
your_height:
  type: float
more_json_info:
  type: json
anything_else:
  type: yaml`;
  const result = basket(questions, {
    love_me: 'false',
    your_name: 'LeChuck',
    your_age: '220',
    your_height: '1.9',
    more_json_info: '["bad", "guy"]',
    anything_else: "{'hates': 'all'}",
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.answers, {
    love_me: false,
    your_name: 'LeChuck',
    your_age: 220,
    your_height: 1.9,
    more_json_info: ['bad', 'guy'],
    anything_else: { hates: 'all' },
  });
});

test('a given answer that cannot be cast is an error naming its question', () => {
  const result = basket('age:\n  type: int\n  default: 1', { age: 'old' });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.question, 'age');
  assert.match(result.errors[0]?.message ?? '', /old/);
});

// Ported from tests/test_tools.py::test_cast_to_bool_treats_blank_strings_as_false and
// test_cast_to_bool_ignores_surrounding_whitespace, through a given bool answer.
for (const [text, expected] of [
  ['', false],
  [' ', false],
  ['\t', false],
  ['\n', false],
  ['  \n\t  ', false],
  [' true ', true],
  ['\nfalse\n', false],
  ['Yes', true],
  ['off', false],
  ['0', false],
  ['2', true],
] as const) {
  test(`a bool answer of ${JSON.stringify(text)} is ${expected}`, () => {
    assert.deepEqual(basket('q:\n  type: bool', { q: text }).answers, { q: expected });
  });
}

test('a question without a type takes it from its default: a number, a bool or a string stay one, anything else is YAML', () => {
  const questions =
    'count:\n  default: 10\nripe:\n  default: false\nlabel:\n  default: "3"\nshelf:\n  default: [a]\nnote:';
  const result = basket(questions, { count: '12', ripe: 'yes', label: '4', shelf: '[b, c]', note: '- 1' });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.answers, { count: 12, ripe: true, label: '4', shelf: ['b', 'c'], note: [1] });
});

// A default is rendered to text and then cast, as copier does, so an expression and a literal agree.
test('a default is rendered, then cast to the type, which without one is the raw default type', () => {
  const questions = `a:
  default: x
b:
  default: y
n:
  type: int
  default: 1
joined:
  type: str
  default: "{{ a }}-{{ b }}"
next:
  type: int
  default: "{{ n + 1 }}"
text:
  default: "{{ n + 1 }}"
ripe:
  type: bool
  default: "true"
three:
  default: "3"
list:
  type: yaml
  default: "{{ [a, b] | tojson }}"`;
  const result = basket(questions, {});
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.answers, {
    a: 'x',
    b: 'y',
    n: 1,
    joined: 'x-y',
    next: 2,
    text: '2',
    ripe: true,
    three: '3',
    list: ['x', 'y'],
  });
});

// Ported from tests/test_copy.py::test_validate_init_data, the plain choices cases.
test('choices restrict the value of a given answer and of a default', () => {
  const valid = basket('q:\n  choices: [one, two]', { q: 'two' });
  assert.deepEqual(valid.errors, []);
  assert.deepEqual(valid.answers, { q: 'two' });
  const given = basket('q:\n  type: str\n  choices: [one, two]', { q: 'three' });
  assert.equal(given.errors.length, 1);
  assert.equal(given.errors[0]?.question, 'q');
  assert.match(given.errors[0]?.message ?? '', /"three" is not one of one, two/);
  const byDefault = basket('q:\n  type: str\n  default: three\n  choices: [one, two]', {});
  assert.match(byDefault.errors[0]?.message ?? '', /"three" is not one of one, two/);
});

test('choices are cast to the question type, as the answer is, and a choice that cannot be is an error', () => {
  const ok = basket('q:\n  type: int\n  choices: [1, 2, 3]', { q: '2' });
  assert.deepEqual(ok.answers, { q: 2 });
  const bad = basket('q:\n  type: int\n  choices: [1, two]', { q: 1 });
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0]?.message ?? '', /two/);
});

test('choices given as a map of label to value restrict the value, not the label', () => {
  const questions = 'q:\n  type: int\n  choices:\n    one: 1\n    two: 2';
  assert.deepEqual(basket(questions, { q: 2 }).answers, { q: 2 });
  assert.equal(basket(questions, { q: 'two' }).errors.length, 1);
});

// Ported from tests/test_copy.py::test_multiselect_choices_preserve_order, the order part only:
// the issue's rules have no multiselect, so what is kept is that choices stay in the manifest's
// order, which a plain object would break for integer-like labels.
test('choices keep the order the manifest writes them in', () => {
  const result = basket('q:\n  type: int\n  choices:\n    "3": 3\n    "1": 1\n    "2": 2', { q: 4 });
  assert.match(result.errors[0]?.message ?? '', /is not one of 3, 1, 2/);
});

// Ported from tests/test_copy.py::test_templated_choices, the list and map forms: the pair and
// {value, validator} forms of copier's extended syntax are not part of the engine.
const templated = [
  ['a string holding a list', 'choices: \'["one", "two", "three"]\''],
  [
    'a string of Jinja that renders a list',
    'choices: \'[{% for c in ["one", "two", "three"] %}{{ c }}{% if not loop.last %},{% endif %}{% endfor %}]\'',
  ],
  [
    'a block of Jinja that renders a YAML list',
    "choices: |\n  {%- for c in ['one', 'two', 'three'] %}\n  - {{ c }}\n  {%- endfor %}",
  ],
  [
    'a block of Jinja that renders a map of label to value',
    "choices: |\n  {%- for c in ['one', 'two', 'three'] %}\n  {{ c | upper }}: {{ c }}\n  {%- endfor %}",
  ],
  ['a list of Jinja items', 'choices: ["{{ \'one\' }}", "{{ \'two\' | lower }}", three]'],
] as const;
for (const [what, spec] of templated) {
  test(`choices may be ${what}`, () => {
    const result = basket(`q:\n  type: str\n${spec.replace(/^/gm, '  ')}`, { q: 'two' }, '{{ q }}');
    assert.deepEqual(result.errors, []);
    assert.equal(result.out, 'two');
    assert.equal(basket(`q:\n  type: str\n${spec.replace(/^/gm, '  ')}`, { q: 'four' }).errors.length, 1);
  });
}

test('choices may use the answers before their question', () => {
  const questions = 'kind:\n  default: fruit\nq:\n  choices: "{{ [kind, kind ~ \'s\'] | tojson }}"';
  assert.deepEqual(basket(questions, { q: 'fruits' }).errors, []);
  assert.equal(basket(questions, { q: 'nuts' }).errors.length, 1);
});

// Ported from tests/test_complex_questions.py::test_selection_type_cast, as given answers, with
// the pair syntax written as a map; the choices' values are cast as the answer is.
test('yaml choices compare the cast values, so null, numbers and lists can be choices', () => {
  const questions = `postgres:
  type: yaml
  default: 10
  choices:
    I will use an external PostgreSQL server: null
    "9.6": 9.6
    "10": 10
nulls:
  type: yaml
  choices:
    same as key: same as key
    yaml-casted to a real null: "null"
    becomes array: "[one, 2, -3.0]"`;
  const none = basket(questions, { nulls: 'null' });
  assert.deepEqual(none.errors, []);
  assert.deepEqual(none.answers, { postgres: 10, nulls: null });
  const picked = basket(questions, { postgres: null, nulls: '[one, 2, -3.0]' });
  assert.deepEqual(picked.answers, { postgres: null, nulls: ['one', 2, -3] });
  assert.equal(basket(questions, { postgres: 11, nulls: 'null' }).errors.length, 1);
});
