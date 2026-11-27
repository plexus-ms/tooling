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

// Adapted from tests/test_jinja2_undefined.py::test_default, test_undefined and
// test_strictundefined_undefined_variable: copier's default Jinja writes an empty string for an
// undefined variable, and its StrictUndefined fails; the engine always fails. test_invalid_value
// tests copier's `_envops`, which the engine has no counterpart of.
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
test('a skipped question is left out of the answers, and its given answer, else its default, is what the files see', () => {
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
  assert.deepEqual(on.errors, []);
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

// Ported from tests/test_complex_questions.py::test_selection_type_cast, as given answers and with
// the label-and-value pairs written as a map. As in copier, a choice whose value is null is chosen
// by its label, and the answer is that label (`postgres` and `nulls` below); a choice of the
// string "null" is the value null.
test('a yaml choice with a null value is its label, and one of the string null is the value null', () => {
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
    same as key: null
    yaml-casted to a real null: "null"
    becomes array: "[one, 2, -3.0]"`;
  const result = basket(questions, { postgres: 'I will use an external PostgreSQL server', nulls: 'null' });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.answers, { postgres: 'I will use an external PostgreSQL server', nulls: null });
  assert.deepEqual(basket(questions, { nulls: 'same as key' }).answers, { postgres: 10, nulls: 'same as key' });
  assert.deepEqual(basket(questions, { postgres: 9.6, nulls: '[one, 2, -3.0]' }).answers, {
    postgres: 9.6,
    nulls: ['one', 2, -3],
  });
  assert.equal(basket(questions, { postgres: null, nulls: 'null' }).errors.length, 1);
  assert.equal(basket(questions, { postgres: 11, nulls: 'null' }).errors.length, 1);
});

// Ported from tests/test_copy.py::test_validate_init_data, the yaml choices with a null value.
for (const [answer, valid] of [
  ['one', true],
  ['2', true],
  ['null', true],
  ['two', false],
  ['three', false],
] as const) {
  test(`a yaml choice {one: null, two: 2, three: "null"} ${valid ? 'allows' : 'refuses'} the answer ${answer}`, () => {
    const result = basket('q:\n  type: yaml\n  choices:\n    one: null\n    two: 2\n    three: "null"', { q: answer });
    assert.equal(result.errors.length, valid ? 0 : 1);
  });
}

// Ported from tests/test_copy.py::test_validate_init_data, the str choices of null values.
test('a str choice with a null value is its label', () => {
  const questions = 'q:\n  type: str\n  choices:\n    one: null\n    two: null\n    three: null';
  assert.deepEqual(basket(questions, { q: 'one' }).answers, { q: 'one' });
  assert.equal(basket(questions, { q: 'four' }).errors.length, 1);
});

// Ported from tests/test_copy.py::test_validate_init_data, the yaml choices of collections.
for (const [what, spec, answer] of [
  ['a string holding a list', 'choices:\n  array: "[a, b]"', '[a, b]'],
  ['a string holding a map', 'choices:\n  object: "k: v"', 'k: v'],
  ['a map as an item', 'choices:\n  - {one: 1, two: 2}', 'one: 1\ntwo: 2'],
] as const) {
  test(`a yaml choice of ${what} is chosen by its value`, () => {
    assert.deepEqual(basket(`q:\n  type: yaml\n${spec.replace(/^/gm, '  ')}`, { q: answer }).errors, []);
  });
}

test('templated choices that hold maps or lists match the answer deeply and print as they are', () => {
  const questions = 'q:\n  type: yaml\n  choices: "[{a: 1}, {b: 2}, [c]]"';
  assert.deepEqual(basket(questions, { q: 'a: 1' }).answers, { q: { a: 1 } });
  assert.deepEqual(basket(questions, { q: '[c]' }).answers, { q: ['c'] });
  const wrong = basket(questions, { q: 'd: 3' });
  assert.match(wrong.errors[0]?.message ?? '', /is not one of {"a":1}, {"b":2}, \["c"\]/);
});

test('the top level of templated choices keeps its order, with integer-like labels', () => {
  const result = basket('q:\n  type: int\n  choices: "{3: 3, 1: 1, 2: 2}"', { q: 4 });
  assert.match(result.errors[0]?.message ?? '', /is not one of 3, 1, 2/);
});

test('a choice outside the allowed ones that casts is an error listing them', () => {
  const result = basket('q:\n  type: int\n  choices:\n    one: 1\n    two: 2', { q: 3 });
  assert.match(result.errors[0]?.message ?? '', /3 is not one of 1, 2/);
});

test('choices of an empty list restrict nothing', () => {
  assert.deepEqual(basket('q:\n  choices: []', { q: 'any' }).answers, { q: 'any' });
  assert.deepEqual(basket('q:\n  choices: "[]"', { q: 'any' }).answers, { q: 'any' });
});

test('templated choices that render to a scalar or to nothing are an error naming the question', () => {
  for (const choices of ['"one"', '""', '"{{ \'\' }}"', '"null"']) {
    const result = basket(`q:\n  default: one\n  choices: ${choices}`, {});
    assert.equal(result.errors.length, 1, choices);
    assert.equal(result.errors[0]?.question, 'q');
    assert.match(result.errors[0]?.message ?? '', /choices/);
  }
});

test('choices are compared strictly: true is not a choice of 1, nor 1 one of true', () => {
  assert.equal(basket('q:\n  type: yaml\n  choices: [1, two]', { q: true }).errors.length, 1);
  assert.equal(basket('q:\n  type: yaml\n  choices: [true]', { q: 1 }).errors.length, 1);
  assert.deepEqual(basket('q:\n  type: yaml\n  choices: [1, two]', { q: 1 }).errors, []);
});

// Deliberate difference from copier: a two-item list among choices is a value, not a label and a value.
test('a two-item list among choices is a list value', () => {
  const questions = 'q:\n  type: yaml\n  choices:\n    - [a, b]\n    - c';
  assert.deepEqual(basket(questions, { q: '[a, b]' }).answers, { q: ['a', 'b'] });
  assert.equal(basket(questions, { q: 'a' }).errors.length, 1);
});

// Deliberate difference from copier: in a list a null item is the value null; a label stands in for
// null only in a map.
test('a null item of a list of choices is the value null', () => {
  const questions = 'q:\n  type: yaml\n  choices: [~, two]';
  assert.deepEqual(basket(questions, { q: null }).answers, { q: null });
  assert.deepEqual(basket(questions, { q: 'two' }).answers, { q: 'two' });
});

// The choices below a yaml string are read as YAML 1.1, as copier reads them.
test('templated choices are read as YAML 1.1', () => {
  assert.deepEqual(basket('q:\n  type: yaml\n  choices: "[yes, 010]"', { q: 'yes' }).answers, { q: true });
  assert.deepEqual(basket('q:\n  type: yaml\n  choices: "[yes, 010]"', { q: '010' }).answers, { q: 8 });
});

// Ported from tests/test_copy.py::test_validate_default_value (the str validator case) and
// tests/test_complex_questions.py's `your_age` validator.
test('a validator is rendered with the answer, and its non-empty output is the error', () => {
  const questions = 'age:\n  type: int\n  validator: |-\n    {% if age <= 0 %}\n      Must be +\n    {% endif %}';
  assert.deepEqual(basket(questions, { age: 22 }).errors, []);
  const result = basket(questions, { age: 0 });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.question, 'age');
  assert.match(result.errors[0]?.message ?? '', /Must be \+/);
});

test('a validator checks a default as it checks a given answer', () => {
  const questions = 'q:\n  type: str\n  default: ""\n  validator: "{% if q | length < 3 %}too short{% endif %}"';
  assert.match(basket(questions, {}).errors[0]?.message ?? '', /too short/);
  assert.deepEqual(basket(questions, { q: 'long' }).errors, []);
});

test('a validator sees the cast answer and the answers before its question, and not the questions after it', () => {
  const questions = `low:
  type: int
  default: 1
high:
  type: int
  validator: "{% if high <= low %}{{ high }} is not above {{ low }}{% endif %}"
after:
  default: x`;
  assert.deepEqual(basket(questions, { high: '5' }).errors, []);
  assert.match(basket(questions, { high: '1' }).errors[0]?.message ?? '', /1 is not above 1/);
  const unknown = basket('q:\n  default: x\n  validator: "{{ later }}"\nlater:\n  default: y', {});
  assert.equal(unknown.errors.length, 1);
});

test('a validator that renders only whitespace accepts the answer', () => {
  assert.deepEqual(basket('q:\n  default: x\n  validator: "  \\n{% if false %}no{% endif %}\\n"', {}).errors, []);
});

test('a validator that fails to render is an error with the failure as its message', () => {
  const result = basket('q:\n  default: x\n  validator: "{% if %}"', {});
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.question, 'q');
});

test('a given answer that belongs to no question is not an error, and the result lists it as unused', () => {
  const result = basket('fruit:\n  default: apple', { fruit: 'pear', colour: 'red', size: 3 }, '{{ fruit }}');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.unused, ['colour', 'size']);
  assert.deepEqual(result.answers, { fruit: 'pear' });
  assert.equal(result.out, 'pear');
});

test('a given answer for a skipped question is used, not unused, and nothing is unused when every answer has a question', () => {
  const result = basket('fruit:\n  when: false\n  default: apple', { fruit: 'pear' });
  assert.deepEqual(result.unused, []);
});

test('the unused answers are listed even when the render has errors', () => {
  const result = basket('fruit:', { colour: 'red' });
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.unused, ['colour']);
});

// Ported from tests/test_copy.py::test_validate_init_data: given answers cast to their type, with
// the validators and the choices of its plain cases. The Python-only values (bytes, Decimal, Enum,
// object) have no JSON counterpart. A number carries no `.0` here (1.0 is 1), so a float prints as
// the shortest number.
const givens: [string, unknown, unknown][] = [
  ['type: int', 'no-int', 'ERROR'],
  ['type: int', '0', 0],
  ['type: int\nvalidator: "{% if q <= 0 %}must be positive{% endif %}"', '0', 'ERROR'],
  ['type: int\nvalidator: "{% if q <= 0 %}must be positive{% endif %}"', '1', 1],
  ['type: str', 'string', 'string'],
  ['type: str', 1, '1'],
  ['type: str', 1.1, '1.1'],
  ['type: str', true, 'True'],
  ['type: str', false, 'False'],
  ['type: str', {}, 'ERROR'],
  ['type: str', [], 'ERROR'],
  ['type: str', ['a'], 'ERROR'],
  ['type: str', { a: 1 }, 'ERROR'],
  ['type: str\nvalidator: "{% if q|length < 3 %}too short{% endif %}"', 'ab', 'ERROR'],
  ['type: str\nvalidator: "{% if q|length < 3 %}too short{% endif %}"', 'abc', 'abc'],
  ['type: bool', 'true', true],
  ['type: bool', 'false', false],
  ['type: int\nchoices: [1, 2, 3]', '1', 1],
  ['type: int\nchoices: [1, 2, 3]', '4', 'ERROR'],
];
for (const [spec, given, expected] of givens) {
  test(`${JSON.stringify(spec)} given ${JSON.stringify(given)} is ${expected === 'ERROR' ? 'an error' : JSON.stringify(expected)}`, () => {
    const result = basket(`q:\n${spec.replace(/^/gm, '  ')}`, { q: given });
    if (expected === 'ERROR')
      assert.deepEqual(
        result.errors.map(({ question }) => question),
        ['q'],
      );
    else assert.deepEqual([result.errors, result.answers], [[], { q: expected }]);
  });
}

// Ported from tests/test_copy.py::test_validate_default_value, the cases the first table leaves out.
// Deliberate differences from copier, each stated in the header of questions.ts: a number carries no
// `.0`, so a `str` of 1.0 is "1".
const moreCasts: [string, string, unknown][] = [
  ['str', '1.0', '1'],
  ['str', 'true', 'True'],
  ['str', '{}', 'ERROR'],
  ['str', '[]', 'ERROR'],
  ['float', '1.0', 1],
  ['json', '"1"', 1],
  ['json', '"false"', false],
  ['json', 'true', true],
  ['json', '1.1', 1.1],
  ['yaml', '1', 1],
  ['yaml', '"1.1"', 1.1],
  ['yaml', 'true', true],
  ['yaml', '"false"', false],
  ['yaml', '{}', {}],
  ['yaml', '[]', []],
  ['yaml', '"{}"', {}],
];
for (const [type, source, expected] of moreCasts) {
  test(`a ${type} default of ${source} is ${expected === 'ERROR' ? 'an error' : `the answer ${JSON.stringify(expected)}`} (more)`, () => {
    const result = basket(`q:\n  type: ${type}\n  default: ${source}`, {});
    if (expected === 'ERROR')
      assert.deepEqual(
        result.errors.map(({ question }) => question),
        ['q'],
      );
    else assert.deepEqual([result.errors, result.answers], [[], { q: expected }]);
  });
}

// Deliberate difference from copier, which truncates 1.5 and takes a bool as 1.
test('an int from a fraction or a bool is an error', () => {
  for (const given of [1.5, '1.5', true, false, '1e3', '', ' ', '--1', '1_000']) {
    assert.equal(basket('q:\n  type: int', { q: given }).errors.length, 1, JSON.stringify(given));
  }
});

// Deliberate difference from copier, which takes Python's `float` syntax: no underscores, no nan, no inf.
test('a float from nan, inf, an underscore, a bool or nothing is an error', () => {
  for (const given of ['nan', 'inf', '-Infinity', '1_000', '1_0.5', true, '', ' ', '.', '1e', 'e5']) {
    assert.equal(basket('q:\n  type: float', { q: given }).errors.length, 1, JSON.stringify(given));
  }
});

// Deliberate difference from copier, whose int has no limit: JavaScript's integers are exact up to 2^53 - 1.
test('an int beyond the safe integers is an error, and the last safe one is not', () => {
  assert.deepEqual(basket('q:\n  type: int', { q: '9007199254740991' }).answers, { q: 9007199254740991 });
  assert.deepEqual(basket('q:\n  type: int', { q: '-9007199254740991' }).answers, { q: -9007199254740991 });
  for (const given of ['9007199254740992', '9007199254740993', '-9007199254740993']) {
    assert.equal(basket('q:\n  type: int', { q: given }).errors.length, 1, given);
  }
});

test('an int and a float read a sign, surrounding whitespace, an exponent and a leading or trailing dot as Python does', () => {
  for (const [given, expected] of [
    [' 7 ', 7],
    ['+5', 5],
    ['-5', -5],
    ['\n12\t', 12],
    ['007', 7],
  ] as const) {
    assert.deepEqual(basket('q:\n  type: int', { q: given }).answers, { q: expected }, given);
  }
  for (const [given, expected] of [
    [' 1.5 ', 1.5],
    ['+2', 2],
    ['-.5', -0.5],
    ['.5', 0.5],
    ['5.', 5],
    ['1e3', 1000],
    ['1.5E-2', 0.015],
    ['2e+2', 200],
  ] as const) {
    assert.deepEqual(basket('q:\n  type: float', { q: given }).answers, { q: expected }, given);
  }
});

// Deliberate difference from copier: JavaScript has one number type, so a whole number written 1.0
// is the number 1, and an untyped default written that way is inferred as int.
test('a float prints without .0, and an untyped default written 1.0 is an int', () => {
  const printed = basket('q:\n  type: float\n  default: 1.0', {}, '{{ q }}');
  assert.deepEqual(printed.answers, { q: 1 });
  assert.equal(printed.out, '1');
  assert.deepEqual(basket('q:\n  default: 1.0', { q: '7' }).answers, { q: 7 });
  assert.equal(basket('q:\n  default: 1.0', { q: '7.5' }).errors.length, 1);
});

test('an untyped default infers int for a whole number and float for a fraction', () => {
  const whole = 'q:\n  default: 2';
  assert.deepEqual(basket(whole, { q: '3' }).answers, { q: 3 });
  assert.equal(basket(whole, { q: '3.5' }).errors.length, 1);
  assert.equal(basket(whole, { q: 'x' }).errors.length, 1);
  const fraction = 'q:\n  default: 2.5';
  assert.deepEqual(basket(fraction, { q: '3' }).answers, { q: 3 });
  assert.deepEqual(basket(fraction, { q: '3.5' }).answers, { q: 3.5 });
  assert.deepEqual(basket(fraction, {}).answers, { q: 2.5 });
});

// Ported from tests/test_tools.py::test_cast_to_bool_*, completed after copier's function: a string
// that Python's float() reads is a number, by its value, and nothing else is, so `0x0` is true.
for (const [given, expected] of [
  [0, false],
  [1, true],
  [-2, true],
  [[], false],
  [{}, false],
  [[0], true],
  [{ a: 0 }, true],
  ['0', false],
  [' 0 ', false],
  ['0.0', false],
  ['-0', false],
  ['.0', false],
  ['0e5', false],
  ['0_0', false],
  ['1e0', true],
  ['0x0', true],
  ['0b0', true],
  ['0o0', true],
  ['nan', true],
  ['inf', true],
  ['y', true],
  ['yes', true],
  ['t', true],
  ['TRUE', true],
  ['on', true],
  ['n', false],
  ['no', false],
  ['f', false],
  ['False', false],
  ['OFF', false],
  ['~', false],
  ['null', false],
  ['None', false],
  ['maybe', true],
] as const) {
  test(`a bool answer of ${JSON.stringify(given)} is ${expected}`, () => {
    assert.deepEqual(basket('q:\n  type: bool', { q: given }).answers, { q: expected });
  });
}

test('a bool from null is an error', () => {
  assert.equal(basket('q:\n  type: bool', { q: null }).errors.length, 1);
});

test('a json answer is parsed as JSON, not as YAML', () => {
  assert.deepEqual(basket('q:\n  type: json', { q: '{"a": [1, null]}' }).answers, { q: { a: [1, null] } });
  for (const given of ['{a: 1}', 'yes', '010', "'x'", '[1, 2', '']) {
    assert.equal(basket('q:\n  type: json', { q: given }).errors.length, 1, given);
  }
  assert.deepEqual(basket('q:\n  type: json', { q: { a: 1 } }).answers, { q: { a: 1 } });
});

// Copier reads YAML 1.1.
test('a yaml answer is read as YAML 1.1', () => {
  for (const [given, expected] of [
    ['yes', true],
    ['on', true],
    ['No', false],
    ['010', 8],
    ['1:30', 90],
    ['{a: 1}', { a: 1 }],
    ['- 1\n- b', [1, 'b']],
    ['', null],
  ] as const) {
    assert.deepEqual(basket('q:\n  type: yaml', { q: given }).answers, { q: expected }, given);
  }
  assert.equal(basket('q:\n  type: yaml', { q: '[1, 2' }).errors.length, 1);
});

test('a question named like an inherited property has no answer until one is given', () => {
  for (const name of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
    const missing = basket(`${name}:`, {});
    assert.deepEqual(
      missing.errors.map(({ question }) => question),
      [name],
    );
    const given = basket(`${name}:\n  type: str`, JSON.parse(`{"${name}": "x"}`));
    assert.deepEqual(given.errors, []);
    assert.equal(Object.getOwnPropertyDescriptor(given.answers, name)?.value, 'x');
  }
});

test('a default that is a list renders each item, and the other items stay as they are', () => {
  const questions = 'a:\n  default: x\nq:\n  type: yaml\n  default: ["{{ a }}-1", 2, true, "plain"]';
  assert.deepEqual(basket(questions, {}).answers, { a: 'x', q: ['x-1', 2, true, 'plain'] });
});

// Adapted from tests/test_jinja2_undefined.py (see the default's test above): an undefined variable in
// a `when`, a validator or choices fails where copier's default Jinja renders an empty string.
test('a when, a validator or choices that use an undefined variable are an error naming the question', () => {
  for (const [field, source] of [
    ['when', '"{{ nothing }}"'],
    ['validator', '"{{ nothing }}"'],
    ['choices', '"[{{ nothing }}]"'],
  ] as const) {
    const result = basket(`q:\n  default: x\n  ${field}: ${source}`, {});
    assert.equal(result.errors.length, 1, field);
    assert.equal(result.errors[0]?.question, 'q', field);
    assert.match(result.errors[0]?.message ?? '', new RegExp(field), field);
  }
});

// Ported from copier/_main.py `_ask`: the init branch validates a given answer whatever `when` says,
// once the question has a default; without one copier skips the question before it looks at the answer.
test('a given answer for a skipped question with a default is cast, checked against choices and validated', () => {
  const base = 'q:\n  type: int\n  default: 1\n  when: false\n';
  assert.deepEqual(basket(base, { q: '5' }).answers, {});
  assert.equal(basket(`${base}  validator: "{% if q > 3 %}too big{% endif %}"`, { q: '5' }).errors.length, 1);
  assert.deepEqual(basket(`${base}  validator: "{% if q > 3 %}too big{% endif %}"`, { q: '2' }).errors, []);
  assert.equal(basket(`${base}  choices: [1, 2]`, { q: '5' }).errors.length, 1);
  assert.equal(basket(base, { q: 'five' }).errors.length, 1);
});

test('a skipped question without a default takes its given answer as it is, uncast and unchecked', () => {
  const base = 'q:\n  type: int\n  when: false\n  choices: [1, 2]\n  validator: "no"';
  const result = basket(base, { q: 'five' }, '{{ q }}');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.answers, {});
  assert.equal(result.out, 'five');
});

// Ported from copier's `_ask`, where `answers.combined` holds every given answer from the start: a
// question sees the raw given answers of the template's other questions, later ones included, and
// each question's resolved answer replaces its raw one for the questions after it.
test('a default, a when, choices and a validator see the raw given answers of the later questions', () => {
  const questions = `a:
  default: "[{{ b }}]"
c:
  default: x
  when: "{{ b == ' 5 ' }}"
d:
  default: x
  choices: "[x, '{{ b }}']"
e:
  default: x
  validator: "{% if b != ' 5 ' %}raw {{ b }}{% endif %}"
b:
  type: int
  default: 1`;
  const result = basket(questions, { b: ' 5 ' }, '{{ b }}');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.answers, { a: '[ 5 ]', c: 'x', d: 'x', e: 'x', b: 5 });
});

test('a question sees the cast answer of an earlier question, not its raw given answer', () => {
  const questions = 'b:\n  type: int\nc:\n  type: int\n  default: "{{ b + 1 }}"';
  assert.deepEqual(basket(questions, { b: '5' }).answers, { b: 5, c: 6 });
});

test('a question does not see the default of a later question, nor a given answer that no question of its template owns', () => {
  const later = basket('a:\n  default: "{{ b }}"\nb:\n  default: y', {});
  assert.equal(later.errors.length, 1);
  assert.equal(later.errors[0]?.question, 'a');
  const stranger = basket('a:\n  default: "{{ other }}"', { other: 'z' });
  assert.equal(stranger.errors.length, 1);
  assert.deepEqual(stranger.unused, ['other']);
});

test('a validator that fails to render names its field, as a default and a when do', () => {
  const result = basket('q:\n  default: x\n  validator: "{% if %}"', {});
  assert.match(result.errors[0]?.message ?? '', /^validator `\{% if %\}`: /);
  assert.match(basket('q:\n  when: "{% if %}"', {}).errors[0]?.message ?? '', /^when `/);
});
