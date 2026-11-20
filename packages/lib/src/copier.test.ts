import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAnswers, setAnswer } from './copier.ts';

test('setAnswer sets one key as YAML and keeps the rest of the file as it was', () => {
  const text =
    '# Changes here will be overwritten by Copier\n_commit: 0.1.0\n_src_path: gh:plexus-ms/preset-repo-web\nname: web\n';
  const set = setAnswer(text, '_src_path', 'gh:plexus-ms/template-repo-turbo');
  assert.equal(set, text.replace('preset-repo-web', 'template-repo-turbo'));
  assert.equal(parseAnswers(set).src, 'gh:plexus-ms/template-repo-turbo');
  assert.equal(parseAnswers(set).commit, '0.1.0');
  assert.equal(
    parseAnswers(setAnswer("_src_path: 'gh:x/y'\n", '_src_path', '/a path: with a colon')).src,
    '/a path: with a colon',
    'a value YAML must quote is quoted',
  );
  assert.throws(() => setAnswer('a: [', '_src_path', 'x'), /answers file is not YAML/);
});
