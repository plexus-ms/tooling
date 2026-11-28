import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedBranch, findConsumers } from './consumers.ts';
import { Context } from './context.ts';
import type { Directory } from './model.ts';
import { fakeIo } from './testing/fakeIo.ts';

const dir = (path: string, facets: Partial<Directory> = {}, children: Directory[] = []): Directory => ({
  name: path.split('/').pop() ?? path,
  path,
  children,
  ...facets,
});
const copier = (template: string) => ({ copier: { src: `gh:plexus-ms/${template}`, answers: {} } });
const marker = () => ({ declaration: { deviations: [], body: '' } });

test('expectedBranch follows what the repo is, and the answers for a package repo', () => {
  assert.equal(expectedBranch(dir('/o', { ...copier('template-repo-operations'), ...marker() })), 'main');
  assert.equal(
    expectedBranch(dir('/o', { ...copier('preset-repo-platform'), ...marker() })),
    'main',
    'an earlier name',
  );
  const https = { copier: { src: 'https://github.com/plexus-ms/template-repo-operations.git', answers: {} } };
  assert.equal(expectedBranch(dir('/o', { ...https, ...marker() })), 'main', 'another spelling of the source');
  assert.equal(expectedBranch(dir('/w', { ...copier('template-repo-turbo'), ...marker() })), 'develop');
  const packages = { copier: { src: 'gh:plexus-ms/template-repo-turbo', answers: { publishes_packages: true } } };
  assert.equal(expectedBranch(dir('/l', { ...packages, ...marker() })), 'main');
  assert.equal(expectedBranch(dir('/x', copier('template-repo-operations'))), undefined, 'no marker');
});

test('expectedBranch reads the marker of a repo that has crossed over from copier', () => {
  const config = (templates: string[], answers: Record<string, unknown> = {}) => ({
    config: { version: '0.2.0', templates, deviations: [], answers },
  });
  assert.equal(expectedBranch(dir('/o', { ...config(['repo-operations']), ...marker() })), 'main');
  assert.equal(expectedBranch(dir('/w', { ...config(['repo-turbo']), ...marker() })), 'develop');
  assert.equal(
    expectedBranch(dir('/l', { ...config(['repo-turbo'], { publishes_packages: true }), ...marker() })),
    'main',
    'a package repo, by the answer in its marker',
  );
});

test('findConsumers groups sites by repo with the branch the version lands on, and skips the templates', async () => {
  const tree = dir('/ws', {}, [
    dir('/ws/plexus-ms', {}, [
      dir('/ws/plexus-ms/preset-repo-web', { git: { branch: 'main', dirty: false }, template: {} }, [
        dir('/ws/plexus-ms/preset-repo-web/template', copier('template-app-nextjs')),
      ]),
      dir('/ws/plexus-ms/libraries', {
        git: { branch: 'main', dirty: false },
        copier: { src: 'gh:plexus-ms/preset-repo-web', answers: { publishes_packages: true } },
        ...marker(),
      }),
    ]),
    dir('/ws/acme', {}, [
      dir('/ws/acme/web', { git: { branch: 'feature/x', dirty: true }, ...copier('preset-repo-web'), ...marker() }, [
        dir('/ws/acme/web/apps', {}, [dir('/ws/acme/web/apps/site', copier('template-app-nextjs'))]),
      ]),
      dir('/ws/acme/platform', {
        git: { branch: 'main', dirty: false },
        ...copier('preset-repo-platform'),
        ...marker(),
      }),
      dir('/ws/acme/other', { git: { branch: 'trunk', dirty: false }, ...copier('preset-repo-platform') }),
      dir('/ws/acme/local', { git: { branch: 'main', dirty: false }, ...copier('preset-repo-platform') }),
    ]),
    dir('/ws/loose', copier('preset-repo-web')),
  ]);
  const ctx = new Context(
    {},
    fakeIo({}, (cwd, args) =>
      args[0] === 'remote' ? (cwd === '/ws/acme/local' ? '' : `git@github.com:${cwd.slice(4)}.git\n`) : undefined,
    ),
  );
  const consumers = await findConsumers(ctx, tree, ['preset-repo-web', 'template-app-nextjs', 'preset-repo-platform']);
  assert.deepEqual(
    consumers.map((c) => [
      c.rel,
      c.branch,
      c.expected,
      c.origin,
      c.skipped,
      c.sites.map((s) => `${s.rel}:${s.template}`),
    ]),
    [
      [
        'plexus-ms/libraries',
        'main',
        'main',
        'git@github.com:plexus-ms/libraries.git',
        undefined,
        ['plexus-ms/libraries:preset-repo-web'],
      ],
      [
        'acme/web',
        'develop',
        'develop',
        'git@github.com:acme/web.git',
        undefined,
        ['acme/web:preset-repo-web', 'acme/web/apps/site:template-app-nextjs'],
      ],
      [
        'acme/platform',
        'main',
        'main',
        'git@github.com:acme/platform.git',
        undefined,
        ['acme/platform:preset-repo-platform'],
      ],
      [
        'acme/other',
        'trunk',
        undefined,
        'git@github.com:acme/other.git',
        undefined,
        ['acme/other:preset-repo-platform'],
      ],
      ['acme/local', 'main', undefined, undefined, 'no origin remote', ['acme/local:preset-repo-platform']],
    ],
  );
});
