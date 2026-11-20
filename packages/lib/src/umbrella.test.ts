import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { Context } from './context.ts';
import { fakeIo, type Tree } from './testing/fakeIo.ts';
import {
  linksOf,
  mergeWorkspaces,
  newestPnpm,
  planDown,
  planUp,
  pnpmDifference,
  readUmbrella,
  readUmbrellaDown,
  UMBRELLA_MARK,
  type UmbrellaRepo,
} from './umbrella.ts';
import { UsageError } from './version.ts';

const shelf: UmbrellaRepo = {
  name: 'shelf',
  workspace: 'packages:\n  - "packages/*"\ncatalog:\n  typescript: ^6\nminimumReleaseAge: 4320\n',
  packageManager: 'pnpm@12.22.0+sha512.abc',
  packages: [
    {
      repo: 'shelf',
      dir: 'shelf/packages/kit',
      name: '@x/kit',
      version: '0.2.0',
      scripts: ['build', 'dev'],
      dependencies: {},
    },
    { repo: 'shelf', dir: 'shelf/packages/raw', name: '@x/raw', version: '1.0.0', scripts: [], dependencies: {} },
  ],
};
const shop: UmbrellaRepo = {
  name: 'shop',
  workspace:
    'packages:\n  - "apps/*"\n  - "!apps/old"\ncatalog:\n  typescript: ^6.0.3\n  "@x/raw": ^1\nallowBuilds:\n  sharp: true\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - "@x/*"\n',
  packageManager: 'pnpm@12.21.0',
  packages: [
    {
      repo: 'shop',
      dir: 'shop/apps/web',
      name: '@x/web',
      version: '0.0.0',
      scripts: ['dev'],
      dependencies: { '@x/kit': '^0.1.0', '@x/raw': 'catalog:', react: '^19' },
    },
  ],
};

test('the repos merge under their names; a range within the other and the longer age win', () => {
  assert.deepEqual(mergeWorkspaces([shelf, shop]), {
    packages: ['shelf', 'shelf/packages/*', 'shop', 'shop/apps/*', '!shop/apps/old'],
    catalog: { typescript: '^6.0.3', '@x/raw': '^1' },
    minimumReleaseAge: 4320,
    allowBuilds: { sharp: true },
    minimumReleaseAgeExclude: ['@x/*'],
    linkWorkspacePackages: true,
  });
});

test('ranges that do not lie within each other, and differing settings, are an error naming both repos', () => {
  const other = (workspace: string): UmbrellaRepo => ({ name: 'old', workspace, packages: [] });
  assert.throws(
    () => mergeWorkspaces([shelf, other('catalog:\n  typescript: ^5\n')]),
    (e: Error) =>
      e instanceof UsageError && /shelf and old disagree on catalog\.typescript \("\^6" and "\^5"\)/.test(e.message),
  );
  assert.throws(
    () => mergeWorkspaces([shop, other('allowBuilds:\n  sharp: false\n')]),
    /shop and old disagree on allowBuilds\.sharp/,
  );
});

test('a dependency across repos is linked when its range admits the local version', () => {
  const links = linksOf([shelf, shop], mergeWorkspaces([shelf, shop]));
  assert.deepEqual(
    links.map((l) => [l.from, l.to, l.range, l.version, l.linked]),
    [
      ['@x/web', '@x/kit', '^0.1.0', '0.2.0', false],
      ['@x/web', '@x/raw', '^1', '1.0.0', true],
    ],
  );
});

test('pnpm runs from the repo that pins the newest one', () => {
  assert.equal(newestPnpm([shop, shelf]), 'shelf');
  assert.equal(newestPnpm([{ ...shop, packageManager: undefined }]), 'shop');
});

test('different pnpm versions are said, different majors refused, equal ones pass silently', () => {
  assert.equal(
    pnpmDifference([shelf, shop]),
    'the repos pin different pnpm versions (shelf 12.22.0, shop 12.21.0); the umbrella installs from shelf',
  );
  assert.equal(pnpmDifference([shelf, { ...shop, packageManager: 'pnpm@12.22.0' }]), undefined);
  assert.throws(
    () => planUp('/u', [shelf, { ...shop, packageManager: 'pnpm@11.28.9' }]),
    (e: Error) =>
      e instanceof UsageError && /different majors of pnpm \(shelf 12\.22\.0, shop 11\.28\.9\)/.test(e.message),
  );
});

test('up writes the marked files, installs, and builds and watches what was linked', () => {
  const up = planUp('/u', [
    shelf,
    { ...shop, packages: shop.packages.map((p) => ({ ...p, dependencies: { '@x/kit': '^0.2.0', '@x/raw': '^1' } })) },
  ]);
  assert.deepEqual(up.watched, ['@x/kit']);
  assert.deepEqual(up.unwatched, ['@x/raw']);
  const described = up.plan.map((s) =>
    s.kind === 'write' ? `> ${s.path}` : `${s.cwd ?? ''}$ ${s.command} ${s.args.join(' ')}`,
  );
  assert.deepEqual(described.slice(1, 8), [
    '$ mkdir -p /u/.plx-umbrella',
    '> /u/pnpm-workspace.yaml',
    '> /u/mise.local.toml',
    '/u$ mise trust --quiet mise.local.toml',
    '/u/shelf$ pnpm install --force',
    '/u/shelf$ pnpm --filter @x/kit run build',
    "/u/shelf$ sh -c set -m; nohup pnpm --filter @x/kit --parallel run dev > '/u/.plx-umbrella/watch.log' 2>&1 & echo $! > '/u/.plx-umbrella/watch.pid'",
  ]);
  const [workspace, mise] = up.plan.flatMap((s) => (s.kind === 'write' ? [s.content] : []));
  assert.ok(workspace?.startsWith(`# ${UMBRELLA_MARK}\n`));
  assert.equal((parse(workspace ?? '') as { linkWorkspacePackages: boolean }).linkWorkspacePackages, true);
  assert.match(
    mise ?? '',
    /PLX_UMBRELLA_ROOT = "\{\{config_root\}\}"\nNPM_CONFIG_WORKSPACE_DIR = "\{\{config_root\}\}"/,
  );
  const install = up.plan.find((s) => s.kind === 'run' && s.command === 'pnpm');
  assert.deepEqual(install?.kind === 'run' && install.env, { NPM_CONFIG_WORKSPACE_DIR: '/u' });
});

test('down deletes what up wrote and installs each repo as its own workspace', () => {
  const plan = planDown('/u', ['shelf', 'shop']);
  assert.deepEqual(
    plan.slice(1).map((s) => s.kind === 'run' && [s.cwd, s.command, ...s.args, s.env?.NPM_CONFIG_WORKSPACE_DIR]),
    [
      [
        '/u',
        'rm',
        '-rf',
        '.plx-umbrella',
        'node_modules',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'mise.local.toml',
        undefined,
      ],
      ['/u/shelf', 'pnpm', 'install', '--force', '/u/shelf'],
      ['/u/shop', 'pnpm', 'install', '--force', '/u/shop'],
    ],
  );
});

const pkg = (manifest: object) => JSON.stringify(manifest);
const tree = (extra: Tree = {}): Tree => ({
  u: {
    shelf: {
      '.git': {},
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
      'package.json': pkg({ packageManager: 'pnpm@12.22.0' }),
      packages: { kit: { 'package.json': pkg({ name: '@x/kit', version: '0.2.0', scripts: { dev: 'tsc -w' } }) } },
    },
    shop: {
      '.git': 'gitdir: elsewhere',
      'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n',
      'package.json': pkg({ packageManager: 'pnpm@12.21.0' }),
      apps: { web: { 'package.json': pkg({ name: '@x/web', dependencies: { '@x/kit': '^0.2.0' } }) } },
    },
    notes: { 'pnpm-workspace.yaml': 'packages: []\n' },
    plain: { '.git': {} },
    ...extra,
  },
});

test('readUmbrella takes the git roots that are pnpm workspaces, narrowed by only', async () => {
  const up = await readUmbrella(new Context({}, fakeIo(tree())), '/u');
  assert.deepEqual(up.repos, ['shelf', 'shop']);
  assert.deepEqual(
    up.links.map((l) => [l.from, l.to, l.linked]),
    [['@x/web', '@x/kit', true]],
  );
  await assert.rejects(
    readUmbrella(new Context({}, fakeIo(tree())), '/u', ['shelf', 'nowhere']),
    /no pnpm workspace in a git repo at nowhere/,
  );
  await assert.rejects(readUmbrella(new Context({}, fakeIo(tree())), '/u', ['shelf']), /at least two repos/);
});

test('files plx umbrella did not generate are left alone, by up and by down', async () => {
  const foreign = () => new Context({}, fakeIo(tree({ 'pnpm-workspace.yaml': 'packages: []\n' })));
  await assert.rejects(readUmbrella(foreign(), '/u'), /holds pnpm-workspace\.yaml that plx umbrella did not generate/);
  await assert.rejects(readUmbrellaDown(foreign(), '/u'), UsageError);
});

test('down reads its repos from the generated workspace file, and plans nothing when none is up', async () => {
  assert.deepEqual(await readUmbrellaDown(new Context({}, fakeIo(tree())), '/u'), { repos: [], plan: [] });
  const generated = `# ${UMBRELLA_MARK}\npackages:\n  - shelf\n  - shelf/packages/*\n  - shop\n  - "!shop/apps/old"\n`;
  const down = await readUmbrellaDown(new Context({}, fakeIo(tree({ 'pnpm-workspace.yaml': generated }))), '/u');
  assert.deepEqual(down.repos, ['shelf', 'shop']);
  assert.equal(down.plan.length, 4);
});
