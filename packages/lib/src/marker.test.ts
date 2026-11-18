import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAnswers } from './copier.ts';
import { parseMarker, reasonGiven } from './marker.ts';
import { shortRemote } from './model.ts';

test('parseMarker reads the profile and the deviations and keeps the prose', () => {
  const d = parseMarker('---\nprofile: stateful\ndeviations: [PLX-App/Stateful/Seed]\n---\n\n- Free-form prose.\n');
  assert.deepEqual(d, { profile: 'stateful', deviations: ['PLX-App/Stateful/Seed'], body: '\n- Free-form prose.\n' });
  assert.deepEqual(parseMarker('---\n{}\n---'), { deviations: [], body: '' });
  assert.deepEqual(parseMarker('---\n---\n\n- A repo.\n'), { deviations: [], body: '\n- A repo.\n' }, 'empty');
});

test('parseMarker does not read what earlier markers carried, and names it', () => {
  assert.deepEqual(parseMarker('---\nplexus: 0.62.0\nmodules: [PLX-Repo]\n---\n'), {
    deviations: [],
    body: '',
    obsolete: ['plexus', 'modules'],
  });
  assert.deepEqual(parseMarker('---\nmodules: []\n---\n').obsolete, ['modules']);
});

test('parseMarker: an empty deviations is none, a byte order mark is no matter, a profile is a string', () => {
  assert.deepEqual(parseMarker('---\ndeviations:\n---\n'), { deviations: [], body: '' });
  assert.deepEqual(parseMarker('\uFEFF---\nprofile: stateless\n---\n'), {
    profile: 'stateless',
    deviations: [],
    body: '',
  });
  assert.throws(() => parseMarker('---\nprofile: [stateful]\n---\n'), /`profile` must be a string/);
  assert.throws(() => parseMarker('---\nprofile: 1\n---\n'), /`profile` must be a string/);
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

test('reasonGiven reads list items of every marker, with the lines that continue them', () => {
  const name = 'PLX-App/Healthcheck';
  for (const body of [
    `+ \`${name}\`: the image checks itself.`,
    `1. \`${name}\`: the image checks itself.`,
    `2) ${name}: the image checks itself.`,
    `- \`${name}\`:\n  the image checks itself.`,
    `- \`${name}\`:\n\n  the image checks itself, as its maintainers document.`,
    `- \`${name}\`:\nthe image checks itself (a lazy continuation).`,
    `Intro.\n\n10. \`${name}\` the image checks itself.`,
  ])
    assert.equal(reasonGiven(body, name), true, body);
});

test('reasonGiven wants the name to open the item, whole, outside fenced code', () => {
  const name = 'PLX-App/Healthcheck';
  for (const body of [
    `- \`PLX-App/Dockerfile\`: unlike ${name}, the file is the image's.`,
    `- [${name}](https://example.org/app.md)`,
    `\`\`\`\n- \`${name}\`: inside a fence.\n\`\`\``,
    `~~~md\n- ${name}: inside a fence.\n~~~`,
    `- \`${name}-foo\`: another name.`,
    `- ${name}-foo: another name.`,
    `- \`${name}/Sub\`: another name.`,
    `- \`${name}\`:\n\nA paragraph after the list is not the item's.`,
    `- \`${name}\`:\n- \`PLX-App/Dockerfile\`: the next item's reason.`,
  ])
    assert.equal(reasonGiven(body, name), false, body);
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
