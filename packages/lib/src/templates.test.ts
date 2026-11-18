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
