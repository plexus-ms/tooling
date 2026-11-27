import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMarkerConfig, RESERVED_KEYS } from './index.ts';

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
