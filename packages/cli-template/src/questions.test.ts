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
