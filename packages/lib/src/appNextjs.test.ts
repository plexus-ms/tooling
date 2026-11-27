import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathsOf, renderBundled, textOf } from './testing/bundled.ts';

const render = (answers: Record<string, unknown> = {}) =>
  renderBundled(['app-nextjs'], { tenant: 'acme', name: '@acme/web', ...answers });

test('an app is rendered with its docker files and its source', async () => {
  const result = await render();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(pathsOf(result), [
    '.gitignore',
    'PLEXUS.md',
    'docker/Dockerfile',
    'docker/compose.ci.yaml',
    'docker/compose.yaml',
    'next.config.ts',
    'package.json',
    'postcss.config.mjs',
    'src/app/healthz/route.ts',
    'src/app/layout.tsx',
    'src/app/page.tsx',
    'tsconfig.json',
  ]);
});

test('the app’s name is in its package.json, its page and its marker', async () => {
  const result = await render({ name: '@acme/api' });
  assert.equal(JSON.parse(textOf(result, 'package.json')).name, '@acme/api');
  assert.match(textOf(result, 'src/app/page.tsx'), /<h1>@acme\/api<\/h1>/);
  assert.match(textOf(result, 'PLEXUS.md'), /^- `@acme\/api`, a Next\.js app/);
});

test('the tenant is a read: the label of the compose file carries it, and nothing owns it here', async () => {
  const result = await render({ tenant: 'initech' });
  assert.equal(textOf(result, 'docker/compose.yaml').match(/plexus\.tenant: initech/g)?.length, 2);
  assert.ok(!('tenant' in result.answers));
  assert.deepEqual(result.unused, []);
});

test('without the tenant, the render fails naming it', async () => {
  const result = await renderBundled(['app-nextjs'], { name: '@acme/web' });
  assert.ok(result.errors.some((e) => e.template === 'app-nextjs' && /tenant/.test(e.message)));
  assert.equal(result.tree.size, 0);
});

test('the name is required, and the error carries its help', async () => {
  const result = await renderBundled(['app-nextjs'], { tenant: 'acme' });
  assert.equal(result.errors[0]?.question, 'name');
  assert.match(result.errors[0]?.message ?? '', /App name/);
});

test('the profile is stateless unless the app says stateful', async () => {
  assert.equal((await render()).answers.profile, 'stateless');
  const stateless = await render({ profile: 'stateless' });
  assert.ok(!('migrate' in JSON.parse(textOf(stateless, 'package.json')).scripts));
  assert.doesNotMatch(textOf(stateless, 'docker/compose.yaml'), /migrate/);
  assert.doesNotMatch(textOf(stateless, 'PLEXUS.md'), /`migrate` and `seed`/);
  const stateful = await render({ profile: 'stateful' });
  const scripts = JSON.parse(textOf(stateful, 'package.json')).scripts;
  assert.ok('migrate' in scripts && 'seed' in scripts);
  assert.match(textOf(stateful, 'docker/compose.yaml'), /profiles: \["migrate"\]/);
  assert.match(textOf(stateful, 'PLEXUS.md'), /`migrate` and `seed`/);
  assert.notEqual(textOf(stateful, 'docker/compose.ci.yaml'), textOf(stateless, 'docker/compose.ci.yaml'));
});

test('a profile is one of the two the app contract names', async () => {
  for (const profile of ['stateless-app', 'stateful-app', 'both']) {
    assert.equal((await render({ profile })).errors[0]?.question, 'profile', profile);
  }
});

test('the source an author edits and the marker are written once, the rest is merged', async () => {
  const result = await render();
  const once = ['PLEXUS.md', 'src/app/healthz/route.ts', 'src/app/layout.tsx', 'src/app/page.tsx'];
  for (const [path, origin] of result.files)
    assert.equal(origin.policy, once.includes(path) ? 'born-once' : 'merge', path);
});

test('the marker has no frontmatter, which plx writes', async () => {
  assert.ok(!textOf(await render({ profile: 'stateful' }), 'PLEXUS.md').startsWith('---'));
});

test('no answers file is rendered, and no command is run at birth', async () => {
  const result = await render();
  assert.ok(![...result.files.keys()].some((path) => path.includes('copier')));
  assert.deepEqual(result.birth, []);
});
