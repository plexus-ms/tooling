// The sites of a repo are found by git, so these tests run git on scratch
// repos: what "tracked" means is git's, not a fake's.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { Context, findSites, realIo } from './index.ts';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'plx-sites-')));
after(() => rmSync(TMP, { recursive: true, force: true }));

const ctx = new Context({}, { ...realIo(), stderr: new PassThrough() });

/** git in a scratch repo, with no configuration of the machine's and no hooks. */
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdio: 'pipe',
  }).toString();

const write = (repo: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
};

const repoWith = (name: string, files: Record<string, string>): string => {
  const repo = join(TMP, name);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
};

const ROOT = '---\nversion: 0.131.0\ntemplates: [repo-turbo, updates]\ntenant: plexus\n---\n\n- A repo.\n';
const WEB = '---\ntemplates: [app-nextjs]\nprofile: stateless\n---\n';

test('findSites finds every tracked marker at any depth in the working tree, the root first', async () => {
  const repo = repoWith('worktree', {
    'PLEXUS.md': ROOT,
    'A/PLEXUS.md': '---\n---\n',
    'apps/web/PLEXUS.md': WEB,
    'apps/vendor/PLEXUS.md': '---\nprofile: stateful\n---\n',
    'deep/er/still/PLEXUS.md': '---\ntemplates: []\n---\n',
    'gone/PLEXUS.md': '---\n---\n',
    'templates/app/files/PLEXUS.md.jinja': '---\nprofile: {{ profile }}\n---\n',
    'docs/NOT-PLEXUS.md': '---\n---\n',
  });
  write(repo, {
    'apps/web/PLEXUS.md': '---\ntemplates: [app-nextjs]\nprofile: stateful\n---\n',
    'apps/new/PLEXUS.md': '---\ntemplates: [app-nextjs]\n---\n',
  });
  rmSync(join(repo, 'gone/PLEXUS.md'));

  assert.deepEqual(await findSites(ctx, repo), [
    {
      dir: '.',
      config: {
        version: '0.131.0',
        templates: ['repo-turbo', 'updates'],
        deviations: [],
        answers: { tenant: 'plexus' },
      },
    },
    { dir: 'A', config: { deviations: [], answers: {} } },
    { dir: 'apps/vendor', config: { deviations: [], answers: { profile: 'stateful' } } },
    { dir: 'apps/web', config: { templates: ['app-nextjs'], deviations: [], answers: { profile: 'stateful' } } },
    { dir: 'deep/er/still', config: { templates: [], deviations: [], answers: {} } },
  ]);
});

test('findSites reads the markers of a git ref, as committed there', async () => {
  const repo = repoWith('ref', { 'PLEXUS.md': ROOT, 'apps/web/PLEXUS.md': WEB });
  git(repo, 'branch', 'base');
  write(repo, { 'PLEXUS.md': ROOT.replace('tenant: plexus', 'tenant: acme'), 'apps/api/PLEXUS.md': WEB });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'later');
  write(repo, { 'apps/web/PLEXUS.md': '---\ntemplates: [app-nextjs]\nprofile: stateful\n---\n' });

  const base = await findSites(ctx, repo, 'base');
  assert.deepEqual(
    base.map((s) => [s.dir, s.config?.answers]),
    [
      ['.', { tenant: 'plexus' }],
      ['apps/web', { profile: 'stateless' }],
    ],
  );
  const head = await findSites(ctx, repo, 'HEAD');
  assert.deepEqual(
    head.map((s) => [s.dir, s.config?.answers]),
    [
      ['.', { tenant: 'acme' }],
      ['apps/api', { profile: 'stateless' }],
      ['apps/web', { profile: 'stateless' }],
    ],
    'what is committed, not the working tree',
  );
  await assert.rejects(findSites(ctx, repo, 'no-such-ref'));
});

test('findSites gives a nested marker with a version, or one that does not parse, a problem', async () => {
  const repo = repoWith('problems', {
    'PLEXUS.md': ROOT,
    'apps/web/PLEXUS.md': '---\nversion: 0.131.0\ntemplates: [app-nextjs]\n---\n',
    'apps/api/PLEXUS.md': '---\n<<<<<<< ours\nprofile: stateless\n=======\nprofile: stateful\n>>>>>>> theirs\n---\n',
    'apps/docs/PLEXUS.md': '- No frontmatter.\n',
  });
  for (const ref of [undefined, 'HEAD']) {
    const sites = await findSites(ctx, repo, ref);
    assert.deepEqual(
      sites.map((s) => s.dir),
      ['.', 'apps/api', 'apps/docs', 'apps/web'],
    );
    const [root, api, docs, web] = sites;
    assert.equal(root?.problem, undefined);
    assert.equal(api?.config, undefined);
    assert.match(api?.problem ?? '', /./);
    assert.match(docs?.problem ?? '', /no frontmatter/);
    assert.equal(web?.config, undefined);
    assert.match(web?.problem ?? '', /`version` belongs in the repo's root marker only/);
  }
});
