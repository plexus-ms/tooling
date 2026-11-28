import assert from 'node:assert/strict';
import { test } from 'node:test';
import { templateOf } from './templates.ts';

test('a consumer recorded under a template’s old name is a consumer of the current one', () => {
  assert.equal(templateOf('gh:plexus-ms/preset-repo-web', ['template-repo-turbo']), 'template-repo-turbo');
  assert.equal(
    templateOf('gh:plexus-ms/preset-repo-platform', ['template-repo-operations']),
    'template-repo-operations',
  );
  assert.equal(templateOf('gh:plexus-ms/template-repo-turbo', ['template-repo-turbo']), 'template-repo-turbo');
  // The `preset-` prefix every template carried until 0.119.0.
  assert.equal(templateOf('gh:plexus-ms/preset-repo-turbo', ['template-repo-turbo']), 'template-repo-turbo');
  assert.equal(templateOf('gh:plexus-ms/preset-app-nextjs', ['template-app-nextjs']), 'template-app-nextjs');
  assert.equal(templateOf('gh:plexus-ms/preset-repo-web', ['template-app-nextjs']), undefined);
  assert.equal(templateOf('gh:acme/template-repo-turbo', ['template-repo-turbo']), undefined);
});

test('a recorded source is read for owner and repo name, whichever way it spells them', () => {
  const ops = ['template-repo-operations'];
  for (const src of [
    'gh:plexus-ms/template-repo-operations',
    'gh:plexus-ms/template-repo-operations.git',
    'https://github.com/plexus-ms/template-repo-operations',
    'https://github.com/plexus-ms/template-repo-operations.git',
    'https://github.com/Plexus-MS/template-repo-operations/',
    'git@github.com:plexus-ms/template-repo-operations.git',
    'ssh://git@github.com/plexus-ms/template-repo-operations.git',
    'git@github.com:plexus-ms/preset-repo-platform.git',
    'https://github.com/plexus-ms/preset-repo-operations',
  ])
    assert.equal(templateOf(src, ops), 'template-repo-operations', src);
  for (const src of [
    'https://github.com/acme/template-repo-operations.git',
    'gh:plexus-ms/template-repo-operations-fork',
    'https://gitlab.com/plexus-ms/template-repo-operations',
    '/Users/me/dev/plexus-ms/template-repo-operations',
  ])
    assert.equal(templateOf(src, ops), undefined, src);
});
