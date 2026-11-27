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
