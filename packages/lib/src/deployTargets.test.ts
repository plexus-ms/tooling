import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from './context.ts';
import {
  deployLegs,
  deploymentSlug,
  parseInventoryFile,
  readDeployTargets,
  selectDeployTargets,
  targetsIn,
} from './deployTargets.ts';
import { fakeIo } from './testing/fakeIo.ts';
import { UsageError } from './version.ts';

const hostA = `---
plexus_deploy_target: "ssh://deploy@host-a.example:22"
plexus_apps:
  - name: beszel
    source: plexus-ms-tenant/platform
    port: 3011
  - name: 'pocket-id'
    port: 3012
other_key: x
`;

test('parseInventoryFile reads the target, the app names and their environments, production by default', () => {
  assert.deepEqual(parseInventoryFile('inventory/host_vars/host-a.yml', hostA), {
    path: 'inventory/host_vars/host-a.yml',
    target: 'ssh://deploy@host-a.example:22',
    apps: [
      { app: 'beszel', environment: 'production' },
      { app: 'pocket-id', environment: 'production' },
    ],
  });
  assert.deepEqual(
    parseInventoryFile(
      's.yml',
      'plexus_deploy_target: ssh://s\nplexus_apps:\n  - name: website\n    environment: staging\n',
    ).apps,
    [{ app: 'website', environment: 'staging' }],
  );
  assert.deepEqual(parseInventoryFile('g.yml', 'ansible_user: root\n'), { path: 'g.yml', target: undefined, apps: [] });
  assert.deepEqual(parseInventoryFile('e.yml', ''), { path: 'e.yml', target: undefined, apps: [] });
});

const prod = (app: string) => ({ app, environment: 'production' });

test('selectDeployTargets maps the deployments of files with a target, sorted, and skips files without one', () => {
  const map = selectDeployTargets([
    { path: 'inventory/host_vars/host-b.yml', target: 'ssh://deploy@host-b', apps: [prod('website')] },
    { path: 'inventory/group_vars/all.yml', apps: [prod('beszel')] },
    {
      path: 'inventory/host_vars/host-a.yml',
      target: 'ssh://deploy@host-a',
      apps: [prod('beszel'), prod('pocket-id')],
    },
  ]);
  assert.deepEqual(Object.entries(map), [
    ['beszel', { production: 'ssh://deploy@host-a' }],
    ['pocket-id', { production: 'ssh://deploy@host-a' }],
    ['website', { production: 'ssh://deploy@host-b' }],
  ]);
});

test('one app, two environments: two records, on one VM or on two, and targetsIn picks one environment', () => {
  const map = selectDeployTargets([
    {
      path: 'inventory/host_vars/host-a.yml',
      target: 'ssh://deploy@host-a',
      apps: [prod('website'), { app: 'website', environment: 'staging' }],
    },
    {
      path: 'inventory/host_vars/host-b.yml',
      target: 'ssh://deploy@host-b',
      apps: [{ app: 'my-app', environment: 'staging' }],
    },
    { path: 'inventory/host_vars/host-c.yml', target: 'ssh://deploy@host-c', apps: [prod('my-app')] },
  ]);
  assert.deepEqual(map, {
    'my-app': { production: 'ssh://deploy@host-c', staging: 'ssh://deploy@host-b' },
    website: { production: 'ssh://deploy@host-a', staging: 'ssh://deploy@host-a' },
  });
  assert.deepEqual(targetsIn(map, 'staging'), { 'my-app': 'ssh://deploy@host-b', website: 'ssh://deploy@host-a' });
  assert.deepEqual(targetsIn(map, 'preview'), {});
});

test('an app declared with a target in two files for the same environment is an error that names both', () => {
  assert.throws(
    () =>
      selectDeployTargets([
        { path: 'inventory/host_vars/host-a.yml', target: 'a', apps: [prod('beszel')] },
        { path: 'inventory/group_vars/apphosts.yml', target: 'b', apps: [prod('beszel')] },
      ]),
    /"beszel" in production.*inventory\/group_vars\/apphosts\.yml and inventory\/host_vars\/host-a\.yml/,
  );
});

test('the deployment slug is the app in production and app-environment elsewhere', () => {
  assert.equal(deploymentSlug('website'), 'website');
  assert.equal(deploymentSlug('website', 'production'), 'website');
  assert.equal(deploymentSlug('website', 'staging'), 'website-staging');
});

test('readDeployTargets reads group_vars and host_vars, .yml and .yaml, and nothing else', async () => {
  const io = fakeIo({
    inv: {
      group_vars: { 'all.yml': 'ansible_user: deploy\n', 'README.md': 'not yaml' },
      host_vars: { 'host-a.yml': hostA, 'host-b.yaml': 'plexus_deploy_target: ssh://x\nplexus_apps: [{name: web}]\n' },
    },
  });
  assert.deepEqual(await readDeployTargets(new Context({}, io), '/inv'), {
    beszel: { production: 'ssh://deploy@host-a.example:22' },
    'pocket-id': { production: 'ssh://deploy@host-a.example:22' },
    web: { production: 'ssh://x' },
  });
});

test('readDeployTargets: an inventory without vars dirs is empty, a missing one is a usage error', async () => {
  assert.deepEqual(await readDeployTargets(new Context({}, fakeIo({ inv: { 'hosts.yml': '' } })), '/inv'), {});
  await assert.rejects(readDeployTargets(new Context({}, fakeIo({})), '/nowhere'), UsageError);
});

test('deployLegs: a leg per app of the repo with a target, sorted; the rest are named, and foreign records start nothing', () => {
  const targets = { beszel: 'ssh://plexus@host-c', website: 'ssh://plexus@host-a' };
  assert.deepEqual(deployLegs(targets, ['pocket-id', 'beszel']), {
    legs: [{ app: 'beszel', host: 'ssh://plexus@host-c' }],
    without: ['pocket-id'],
  });
  assert.deepEqual(deployLegs(targets, []), { legs: [], without: [] });
});
