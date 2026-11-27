import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathsOf, renderBundled, textOf } from './testing/bundled.ts';

const render = (answers: Record<string, unknown> = {}) => renderBundled(['repo-turbo'], { tenant: 'acme', ...answers });

const COMMON = [
  '.github/workflows/on_pr.yml',
  '.github/workflows/on_push.yml',
  '.github/workflows/plx-update.yml',
  '.gitignore',
  'PLEXUS.md',
  'biome.json',
  'hk.pkl',
  'mise.toml',
  'package.json',
  'packages/.gitkeep',
  'pnpm-workspace.yaml',
  'renovate.json',
  'turbo.json',
];

test('an app repo is rendered with its apps directory and its commit workflows', async () => {
  const result = await render();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    pathsOf(result),
    [
      ...COMMON,
      '.dockerignore',
      '.github/workflows/housekeeping.yml',
      '.github/workflows/on_commit.yml',
      'apps/.gitkeep',
    ].sort(),
  );
});

test('a package repo has changesets instead of apps and the commit workflows', async () => {
  const result = await render({ publishes_packages: true });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(pathsOf(result), [...COMMON, '.changeset/config.json'].sort());
});

test('the housekeeping workflow follows the registry, which follows the strategy', async () => {
  const github = await render({ ci_strategy: 'github' });
  assert.equal(github.answers.ci_registry, 'ghcr');
  assert.ok(github.files.has('.github/workflows/housekeeping.yml'));
  const hybrid = await render({ ci_strategy: 'hybrid', alerts_email: 'ops@acme.example' });
  assert.equal(hybrid.answers.ci_registry, 'own');
  assert.equal(hybrid.answers.alerts_email, 'ops@acme.example');
  assert.ok(!hybrid.files.has('.github/workflows/housekeeping.yml'));
});

test('the answers of a plain app repo are the questions’ defaults', async () => {
  const result = await render();
  assert.deepEqual(result.answers, {
    tenant: 'acme',
    publishes_packages: false,
    private_packages_scope: '',
    ci_strategy: 'github',
    ci_registry: 'ghcr',
    ci_overlay: 'none',
    display_versions: false,
    pr_reviewers: '',
    update_max_age: 7,
  });
});

test('a package repo is asked where it publishes and nothing about CI registries', async () => {
  const result = await render({ publishes_packages: true });
  assert.equal(result.answers.package_registry, 'npm');
  assert.ok(!('ci_registry' in result.answers));
  assert.ok(!('display_versions' in result.answers));
  const github = await render({ publishes_packages: true, package_registry: 'github' });
  assert.match(textOf(github, 'PLEXUS.md'), /the forge's package registry, private to the tenant,/);
});

test('the tenant is required, and the error carries its help', async () => {
  const result = await renderBundled(['repo-turbo'], {});
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.question, 'tenant');
  assert.match(result.errors[0]?.message ?? '', /Tenant slug/);
});

test('a private packages scope is empty or like @acme', async () => {
  for (const scope of ['', '@acme', '@a0._-b'])
    assert.deepEqual((await render({ private_packages_scope: scope })).errors, []);
  for (const scope of ['acme', '@', '@-acme', '@Acme', '@ac me', '@acme/x']) {
    const { errors } = await render({ private_packages_scope: scope });
    assert.equal(errors.length, 1, scope);
    assert.equal(errors[0]?.question, 'private_packages_scope', scope);
    assert.match(errors[0]?.message ?? '', /A scope, as in @acme-corp, or empty/);
  }
});

test('a scope with a trailing newline is refused, which copier’s regex accepts', async () => {
  const { errors } = await render({ private_packages_scope: '@acme\n' });
  assert.equal(errors[0]?.question, 'private_packages_scope');
});

test('the days before a minor version is taken are zero or more', async () => {
  assert.deepEqual((await render({ update_max_age: 0 })).errors, []);
  const { errors } = await render({ update_max_age: -1 });
  assert.equal(errors[0]?.question, 'update_max_age');
});

test('only a choice of the question is an answer', async () => {
  for (const answers of [{ ci_strategy: 'cloud' }, { ci_overlay: 'wireguard' }, { ci_registry: 'docker' }]) {
    assert.equal((await render(answers)).errors.length, 1);
  }
});

test('the marker is written once, and without frontmatter, which plx writes', async () => {
  const result = await render({ display_versions: true });
  assert.equal(result.files.get('PLEXUS.md')?.policy, 'born-once');
  assert.ok(!textOf(result, 'PLEXUS.md').startsWith('---'));
  assert.match(textOf(result, 'PLEXUS.md'), /^- An app repo of `acme`/);
  assert.match(textOf(result, 'PLEXUS.md'), /Display versions \(PLX-Releases\)/);
  for (const [path, origin] of result.files) if (path !== 'PLEXUS.md') assert.equal(origin.policy, 'merge', path);
});

test('no answers file is rendered', async () => {
  assert.ok(![...(await render()).files.keys()].some((path) => path.includes('copier')));
});

test('a new repo is born with git, mise and the two exact toolchain pins', async () => {
  assert.deepEqual(
    (await render()).birth.map((b) => b.command),
    [
      ['git', 'init'],
      ['mise', 'trust'],
      ['mise', 'install'],
      ['mise', 'exec', '--', 'npx', 'corepack', 'use', 'pnpm@12'],
      ['mise', 'exec', '--', 'pnpm', 'add', '--workspace-root', '--save-dev', '--save-exact', '@biomejs/biome'],
    ],
  );
});
