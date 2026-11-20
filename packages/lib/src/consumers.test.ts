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

test("a tree read from git has the sites the walk would find in its checkout, by the walk's rule", async () => {
  const answers = (template: string, commit = '0.2.0') => `_commit: ${commit}\n_src_path: gh:plexus-ms/${template}\n`;
  // The repo as its files: answers files the walk reaches, and those it never does.
  const files: Record<string, string> = {
    '.copier-answers.yml': answers('template-repo-turbo'),
    'package.json': '{}',
    'apps/site/.copier-answers.yml': answers('template-app-nextjs'),
    'apps/site/page.tsx': 'x',
    'apps/build/.copier-answers.yml': answers('template-app-nextjs'),
    'apps/build/page.tsx': 'an app named like a pruned directory',
    'apps/dist/.copier-answers.yml': answers('template-app-nextjs'),
    'vendor/lib/.copier-answers.yml': answers('template-app-nextjs'),
    'packages/build/.copier-answers.yml': answers('template-app-nextjs'),
    'kit/copier.yml': 'x: 1',
    'kit/template/.copier-answers.yml': answers('template-app-nextjs'),
    'other/.copier-answers.yml': '_commit: 1.0.0\n_src_path: gh:someone/else\n',
    'broken/.copier-answers.yml': '<<<<<<< ours\n_commit: 0.1.0\n=======\n_commit: 0.2.0\n>>>>>>> theirs\n',
  };
  const tree: Record<string, unknown> = { '.git': {} };
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split('/');
    let node = tree;
    for (const p of parts.slice(0, -1)) {
      node[p] ??= {};
      node = node[p] as Record<string, unknown>;
    }
    node[parts.at(-1) ?? ''] = text;
  }
  const git = (_cwd: string, args: string[]) => {
    if (args[0] === 'ls-tree') return `${Object.keys(files).sort().join('\0')}\0`;
    if (args[0] === 'cat-file') return files[(args[2] ?? '').split(':')[1] ?? ''];
    return undefined;
  };
  const ctx = new Context({ quiet: true }, fakeIo({ r: tree } as never, git));
  const { overview } = await import('./overview.ts');
  const { TEMPLATES } = await import('./templates.ts');
  const walked = (await findConsumers(ctx, await overview(ctx, '/r'), TEMPLATES))[0]?.sites.map(
    (s) => s.path.slice('/r/'.length) || '.',
  );
  const { sitesOfTree } = await import('./consumers.ts');
  const { sites } = await sitesOfTree(ctx, '/r', 'tip');
  assert.deepEqual(
    walked,
    ['.', 'apps/build', 'apps/site', 'broken'].filter((d) => d !== 'broken'),
  );
  assert.deepEqual(
    sites.map((s) => s.dir),
    ['.', 'apps/build', 'apps/site', 'broken'],
    'the same, and the one whose answers do not parse, which the walk cannot name a template for',
  );
  assert.equal(sites.find((s) => s.dir === 'broken')?.answers, undefined);
});
