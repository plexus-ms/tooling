import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeSpan } from './ship.ts';

test('a commit subject in the release notes is a code span: no mention, reference or markup is live', () => {
  assert.equal(codeSpan('fix(deps): bump @plexus-ms/lib'), '`fix(deps): bump @plexus-ms/lib`');
  assert.equal(codeSpan('# not a heading, *not* emphasis, #12'), '`# not a heading, *not* emphasis, #12`');
  // A backtick in the subject: the fence is longer than any run in it.
  assert.equal(codeSpan('run `plx update` now'), '``run `plx update` now``');
  assert.equal(codeSpan('a ``double`` run'), '```a ``double`` run```');
  // At either end, a space keeps the fence apart from it; CommonMark strips one space on each side.
  assert.equal(codeSpan('`mise ship` refuses'), '`` `mise ship` refuses ``');
});
