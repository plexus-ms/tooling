import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathsOf, renderBundled, textOf } from './testing/bundled.ts';

const render = (answers: Record<string, unknown> = {}) =>
  renderBundled(['repo-operations'], { tenant: 'acme', ...answers });

const COMMON = [
  '.github/workflows/deploy.yml',
  '.github/workflows/on_commit.yml',
  '.github/workflows/on_pr.yml',
  '.github/workflows/plx-update.yml',
  '.gitignore',
  'PLEXUS.md',
  'ansible-playbookw',
  'ansible.cfg',
  'apps/.gitkeep',
  'hk.pkl',
  'inventory/group_vars/all.yml',
  'inventory/group_vars/platform.yml',
  'inventory/hosts.yml',
  'mise.toml',
  'platform.yml',
  'renovate.json',
  'requirements.yml',
  'secrets.env',
];

test('an operations repo that buys its hosts and runs CI on the forge has the common files only', async () => {
  const result = await render();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(pathsOf(result), [...COMMON].sort());
});

test('an infrastructure layer adds its playbook', async () => {
  const result = await render({ infrastructure: true });
  assert.deepEqual(pathsOf(result), [...COMMON, 'infrastructure.yml'].sort());
  assert.match(textOf(result, 'inventory/hosts.yml'), /^proxmox:$/m);
});

test('runners of the tenant’s own add the CI playbook and its housekeeping', async () => {
  for (const ci_strategy of ['on-prem', 'hybrid']) {
    const result = await render({ ci_strategy });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(pathsOf(result), [...COMMON, '.github/workflows/housekeeping.yml', 'ci.yml'].sort(), ci_strategy);
  }
});

test('a registry of its own adds the housekeeping alone', async () => {
  const result = await render({ ci_registry: 'own' });
  assert.deepEqual(pathsOf(result), [...COMMON, '.github/workflows/housekeeping.yml'].sort());
});

test('the answers are the questions’ defaults, and the org follows the tenant', async () => {
  assert.deepEqual((await render()).answers, {
    tenant: 'acme',
    github_org: 'acme',
    infrastructure: false,
    ci_strategy: 'github',
    ci_registry: 'ghcr',
    ci_overlay: 'none',
    pr_reviewers: '',
    update_max_age: 7,
  });
  const hybrid = await render({ ci_strategy: 'hybrid', github_org: 'acme-gh', alerts_email: 'ops@acme.example' });
  assert.equal(hybrid.answers.github_org, 'acme-gh');
  assert.equal(hybrid.answers.ci_registry, 'own');
  assert.equal(hybrid.answers.alerts_email, 'ops@acme.example');
});

test('the tenant is required, and the error carries its help', async () => {
  const result = await renderBundled(['repo-operations'], {});
  // The org defaults to the tenant, so its question fails with it.
  assert.deepEqual(
    result.errors.map((e) => e.question),
    ['tenant', 'github_org'],
  );
  assert.match(result.errors[0]?.message ?? '', /Tenant slug/);
});

test('the days before a minor version is taken are zero or more', async () => {
  assert.deepEqual((await render({ update_max_age: 0 })).errors, []);
  assert.equal((await render({ update_max_age: -1 })).errors[0]?.question, 'update_max_age');
});

test('only a choice of the question is an answer', async () => {
  for (const answers of [{ ci_strategy: 'cloud' }, { ci_overlay: 'wireguard' }, { ci_registry: 'docker' }]) {
    assert.equal((await render(answers)).errors.length, 1);
  }
});

test('the playbook wrapper stays executable', async () => {
  assert.equal((await render()).tree.get('ansible-playbookw')?.mode, 0o100755);
  assert.equal((await render()).tree.get('ansible.cfg')?.mode, 0o100644);
});

test('the marker is written once, and without frontmatter, which plx writes', async () => {
  const result = await render();
  assert.equal(result.files.get('PLEXUS.md')?.policy, 'born-once');
  assert.match(textOf(result, 'PLEXUS.md'), /^- The operations repo of `acme`/);
  for (const [path, origin] of result.files) if (path !== 'PLEXUS.md') assert.equal(origin.policy, 'merge', path);
});

test('no answers file is rendered', async () => {
  assert.ok(![...(await render()).files.keys()].some((path) => path.includes('copier')));
});

test('a new repo is born with git and mise', async () => {
  assert.deepEqual(
    (await render()).birth.map((b) => b.command),
    [
      ['git', 'init'],
      ['mise', 'trust'],
      ['mise', 'install'],
    ],
  );
});
