import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMarkerConfig, RESERVED_KEYS, setMarkerKeys } from './index.ts';

test('parseMarkerConfig reads version, templates and deviations, and every other key as an answer', () => {
  const text = [
    '---',
    'version: 0.131.0',
    'templates: [repo-turbo, updates]',
    'deviations: []',
    'tenant: plexus',
    'ci_strategy: github',
    'update_max_age: 7',
    '---',
    '',
    '- Free-form prose.',
    '',
  ].join('\n');
  assert.deepEqual(parseMarkerConfig(text), {
    version: '0.131.0',
    templates: ['repo-turbo', 'updates'],
    deviations: [],
    answers: { tenant: 'plexus', ci_strategy: 'github', update_max_age: 7 },
  });
  assert.deepEqual(RESERVED_KEYS, ['version', 'templates', 'deviations']);
});

test('parseMarkerConfig: a marker without version or templates is valid, and profile and major are answers', () => {
  assert.deepEqual(parseMarkerConfig('---\n---\n\n- A repo.\n'), { deviations: [], answers: {} });
  assert.deepEqual(parseMarkerConfig('---\nprofile: stateful\nmajor: 1\ndeviations: [PLX-App/Stateful/Seed]\n---\n'), {
    deviations: ['PLX-App/Stateful/Seed'],
    answers: { profile: 'stateful', major: 1 },
  });
  assert.deepEqual(
    parseMarkerConfig('---\ntemplates:\ndeviations:\n---\n'),
    { templates: [], deviations: [], answers: {} },
    'an empty list is written as no value',
  );
  assert.deepEqual(parseMarkerConfig('﻿---\r\ntenant: acme\r\n---\r\n'), {
    deviations: [],
    answers: { tenant: 'acme' },
  });
});

test('parseMarkerConfig rejects a reserved key of the wrong shape, and what is not a marker', () => {
  assert.throws(() => parseMarkerConfig('---\nversion: 1.2\n---\n'), /`version` must be a Plexus version/);
  assert.throws(() => parseMarkerConfig('---\nversion: v0.131.0\n---\n'), /`version` must be a Plexus version/);
  assert.throws(() => parseMarkerConfig('---\ntemplates: repo-turbo\n---\n'), /`templates` must be a list/);
  assert.throws(() => parseMarkerConfig('---\ntemplates: [1]\n---\n'), /`templates` must be a list/);
  assert.throws(() => parseMarkerConfig('---\ndeviations: PLX-Repo/Verbs\n---\n'), /`deviations` must be a list/);
  assert.throws(() => parseMarkerConfig('# just prose'), /no frontmatter/);
  assert.throws(() => parseMarkerConfig('---\n- a list\n---\n'), /not a mapping/);
  assert.throws(() => parseMarkerConfig('---\na: 1\na: 2\n---\n'), /unique/);
});

test('setMarkerKeys changes only the keys it sets: comments, order, quoting, spacing, blank lines and the body survive', () => {
  const body = ['', '- `PLX-Repo/Verbs`: a reason.', '', '---', 'A rule in the body, not frontmatter.', ''];
  const text = [
    '---',
    '# Written by hand; plx keeps what it does not set.',
    'version:   "0.131.0"   # moved by plx update only',
    'templates:',
    '    - repo-turbo   # the base',
    '',
    "tenant: 'plexus'",
    'ci_strategy:    github',
    'deviations: [ PLX-Repo/Verbs ]   # see below',
    'extra:',
    '  nested: {a: 1}',
    '---',
    ...body,
  ].join('\n');
  const written = setMarkerKeys(text, {
    version: '0.132.0',
    templates: ['repo-turbo', 'updates'],
    tenant: 'acme',
    update_max_age: 7,
  });
  assert.equal(
    written,
    [
      '---',
      '# Written by hand; plx keeps what it does not set.',
      'version:   "0.132.0"   # moved by plx update only',
      'templates:',
      '    - repo-turbo',
      '    - updates',
      '',
      "tenant: 'acme'",
      'ci_strategy:    github',
      'deviations: [ PLX-Repo/Verbs ]   # see below',
      'extra:',
      '  nested: {a: 1}',
      'update_max_age: 7',
      '---',
      ...body,
    ].join('\n'),
  );
  assert.deepEqual(parseMarkerConfig(written), {
    version: '0.132.0',
    templates: ['repo-turbo', 'updates'],
    deviations: ['PLX-Repo/Verbs'],
    answers: { tenant: 'acme', ci_strategy: 'github', extra: { nested: { a: 1 } }, update_max_age: 7 },
  });
  assert.equal(setMarkerKeys(written, { version: '0.132.0', extra: { nested: { a: 1 } } }), written, 'already so');
});

test('setMarkerKeys puts a new reserved key in the reserved order ahead of the answers, and a new answer last', () => {
  assert.equal(
    setMarkerKeys('---\n---\n', { version: '0.131.0', templates: ['repo-turbo', 'updates'], tenant: 'plexus' }),
    '---\nversion: 0.131.0\ntemplates: [repo-turbo, updates]\ntenant: plexus\n---\n',
  );
  assert.equal(
    setMarkerKeys('---\n# An app.\nprofile: stateful\n---\n\n- An app.\n', { templates: ['app-nextjs'], port: 3000 }),
    '---\ntemplates: [app-nextjs]\n# An app.\nprofile: stateful\nport: 3000\n---\n\n- An app.\n',
  );
  assert.equal(
    setMarkerKeys('---\ntemplates: [repo-turbo]\ndeviations: []\nmajor: 1\n---\n', { version: '0.131.0' }),
    '---\nversion: 0.131.0\ntemplates: [repo-turbo]\ndeviations: []\nmajor: 1\n---\n',
  );
  assert.equal(
    setMarkerKeys('---\nversion: 0.131.0\ndeviations: []\n---\n', { templates: ['repo-turbo'] }),
    '---\nversion: 0.131.0\ntemplates: [repo-turbo]\ndeviations: []\n---\n',
  );
  assert.equal(
    setMarkerKeys('\uFEFF---\r\ntenant: acme\r\n---\r\n', { ci_strategy: 'github' }),
    '\uFEFF---\r\ntenant: acme\r\nci_strategy: github\r\n---\r\n',
    'a byte order mark and CRLF line endings stay',
  );
});

test('setMarkerKeys writes a value in the style of the one it replaces', () => {
  assert.equal(
    setMarkerKeys('---\ntemplates:\n- repo-turbo\n---\n', { templates: ['repo-turbo', 'updates'] }),
    '---\ntemplates:\n- repo-turbo\n- updates\n---\n',
  );
  assert.equal(
    setMarkerKeys('---\ntemplates: [repo-turbo]   # what renders\n---\n', { templates: ['repo-turbo', 'updates'] }),
    '---\ntemplates: [repo-turbo, updates]   # what renders\n---\n',
  );
  assert.equal(setMarkerKeys('---\ntemplates:\n---\n', { templates: ['updates'] }), '---\ntemplates: [updates]\n---\n');
  assert.equal(setMarkerKeys('---\nname: "web"\n---\n', { name: 'site' }), '---\nname: "site"\n---\n');
  assert.equal(setMarkerKeys('---\nname: "web"\n---\n', { name: 3 }), '---\nname: 3\n---\n');
});

test('setMarkerKeys refuses what it cannot write without reformatting', () => {
  assert.throws(() => setMarkerKeys('# just prose', { tenant: 'acme' }), /no frontmatter/);
  assert.throws(() => setMarkerKeys('---\n{tenant: acme}\n---\n', { major: 1 }), /block mapping/);
  assert.throws(() => setMarkerKeys('---\n- a list\n---\n', { major: 1 }), /not a mapping/);
  assert.throws(() => setMarkerKeys('---\na: [\n---\n', { major: 1 }), /frontmatter/);
  assert.throws(() => setMarkerKeys('---\n---\n', { major: undefined }), /`major`/);
});

test('setMarkerKeys writes a value for a key written without one before the comment on its line', () => {
  const written = setMarkerKeys('---\na: # c\nb: 1\n---\n', { a: 'x' });
  assert.equal(written, '---\na: x # c\nb: 1\n---\n');
  assert.equal(parseMarkerConfig(written).answers.a, 'x');
  assert.equal(setMarkerKeys('---\na: \nb: 1\n---\n', { a: 'x' }), '---\na: x\nb: 1\n---\n', 'a trailing space');
  assert.equal(setMarkerKeys('---\r\na:\r\nb: 1\r\n---\r\n', { a: 'x' }), '---\r\na: x\r\nb: 1\r\n---\r\n');
});

test('setMarkerKeys inserts a new reserved key above the comment lines that directly precede the next key', () => {
  assert.equal(
    setMarkerKeys('---\n# about tenant\ntenant: x\n---\n', { templates: ['a'] }),
    '---\ntemplates: [a]\n# about tenant\ntenant: x\n---\n',
  );
  assert.equal(
    setMarkerKeys('---\n# The repo.\n\n# about tenant\n  # and more\ntenant: x\n---\n', { templates: ['a'] }),
    '---\n# The repo.\n\ntemplates: [a]\n# about tenant\n  # and more\ntenant: x\n---\n',
    'a blank line ends the comment that belongs to the key',
  );
});

test('setMarkerKeys keeps the comment on the key line of a block value it replaces', () => {
  const list = '---\ntemplates: # which\n  - a\n  # inside\n  - b\nnext: 1\n---\n';
  assert.equal(
    setMarkerKeys(list, { templates: ['c', 'd'] }),
    '---\ntemplates: # which\n  - c\n  - d\nnext: 1\n---\n',
    'a comment between the items goes with them',
  );
  const answer = '---\nextra: # which\n  - a\nnext: 1\n---\n';
  assert.equal(setMarkerKeys(answer, { extra: 'x' }), '---\nextra: x # which\nnext: 1\n---\n');
  assert.equal(setMarkerKeys(answer, { extra: [] }), '---\nextra: [] # which\nnext: 1\n---\n');
  assert.deepEqual(parseMarkerConfig(setMarkerKeys(answer, { extra: [] })).answers.extra, []);
  assert.equal(setMarkerKeys('---\na: | # c\n  text\nb: 1\n---\n', { a: 'y' }), '---\na: y # c\nb: 1\n---\n');
});

test('setMarkerKeys leaves the line breaks of lines it does not set as they are', () => {
  assert.equal(setMarkerKeys('---\na: 1\r\nb: 2\n---\n', { b: 3 }), '---\na: 1\r\nb: 3\n---\n');
  assert.equal(
    setMarkerKeys('---\r\na: 1\nb: 2\r\n---\r\n', { c: [1] }),
    '---\r\na: 1\nb: 2\r\nc: [1]\r\n---\r\n',
    "a new line takes the page's line break",
  );
});

test('setMarkerKeys refuses a key that is not written as `key: value`, and takes a quoted one', () => {
  assert.throws(() => setMarkerKeys('---\n? a\n:\n  - 1\n---\n', { a: [2] }), /`a` is not written as `a: value`/);
  assert.throws(() => setMarkerKeys('---\n? a\n: 1\nb: 2\n---\n', { a: 3 }), /`a` is not written as `a: value`/);
  assert.equal(setMarkerKeys('---\n"a" : 1\n---\n', { a: 2 }), '---\n"a" : 2\n---\n');
  assert.equal(setMarkerKeys('---\n? a\n: 1\n---\n', { b: 2 }), '---\n? a\n: 1\nb: 2\n---\n', 'another key');
});

test('setMarkerKeys refuses a value another key refers to, and a value that refers to another', () => {
  const shared = '---\na: &x [1]\nb: *x\n---\n';
  assert.throws(() => setMarkerKeys(shared, { a: [2] }), /`a` carries the anchor `x`/);
  assert.throws(() => setMarkerKeys('---\na: [&x 1, 2]\nb: *x\n---\n', { a: [3] }), /`a` carries the anchor `x`/);
  assert.throws(() => setMarkerKeys(shared, { b: [3] }), /`b` is an alias/);
  assert.equal(setMarkerKeys('---\na: &x 1\n---\n', { a: 2 }), '---\na: &x 2\n---\n', 'an anchor nothing uses');
  assert.equal(setMarkerKeys('---\na: &x 1\nb: [*x, 2]\n---\n', { b: [3] }), '---\na: &x 1\nb: [3]\n---\n');
});
