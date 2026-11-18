import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAnswers } from './copier.ts';
import { parseMarker, reasonGiven } from './marker.ts';
import { type Directory, shortRemote, unitsOf } from './model.ts';

test('parseMarker reads the profile and the deviations and keeps the prose', () => {
  const d = parseMarker('---\nprofile: stateful\ndeviations: [PLX-App/Stateful/Seed]\n---\n\n- Free-form prose.\n');
  assert.deepEqual(d, { profile: 'stateful', deviations: ['PLX-App/Stateful/Seed'], body: '\n- Free-form prose.\n' });
  assert.deepEqual(parseMarker('---\n{}\n---'), { deviations: [], body: '' });
  assert.deepEqual(parseMarker('---\n---\n\n- A repo.\n'), { deviations: [], body: '\n- A repo.\n' }, 'empty');
});

test('parseMarker does not read what earlier markers carried', () => {
  assert.deepEqual(parseMarker('---\nplexus: 0.62.0\nmodules: [PLX-Repo]\n---\n'), { deviations: [], body: '' });
});

test('parseMarker rejects what is not a marker', () => {
  assert.throws(() => parseMarker('# just prose'), /no frontmatter/);
  assert.throws(() => parseMarker('---\n- a list\n---\n'), /not a mapping/);
  assert.throws(() => parseMarker('---\ndeviations: PLX-Repo/Verbs\n---\n'), /`deviations`/);
});

test('reasonGiven wants a bullet that names the deviation and says why', () => {
  const name = 'PLX-App/Stateful/MigrateService';
  assert.equal(reasonGiven(`- \`${name}\`: the image migrates on startup.\n`, name), true);
  assert.equal(reasonGiven(`Prose naming ${name} outside a bullet.\n`, name), false);
  assert.equal(reasonGiven(`- \`${name}\`:\n`, name), false, 'a bullet with the name alone gives no reason');
  assert.equal(reasonGiven(`- \`${name}X\`: another name.\n`, name), false);
  assert.equal(reasonGiven(`  * ${name} because the image migrates itself\n`, name), true);
});

test('parseAnswers separates copier bookkeeping from the answers', () => {
  const a = parseAnswers(
    '# Maintained by Copier\n_commit: 0.62.0\n_src_path: gh:plexus-ms/template-app-nextjs\nname: web\nprofile: stateless-app\n',
  );
  assert.deepEqual(a, {
    commit: '0.62.0',
    src: 'gh:plexus-ms/template-app-nextjs',
    answers: { name: 'web', profile: 'stateless-app' },
  });
});

test('shortRemote shortens GitHub remotes in every spelling', () => {
  for (const url of [
    'git@github.com:plexus-ms/packages.git',
    'ssh://git@github.com/plexus-ms/packages',
    'https://github.com/plexus-ms/packages/',
  ])
    assert.equal(shortRemote(url), 'gh:plexus-ms/packages');
  assert.equal(shortRemote('https://codeberg.org/x/y.git'), 'https://codeberg.org/x/y');
});
