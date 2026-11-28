// plx new on scratch directories: fixture templates for the behaviour, the
// bundled ones for the two sites the verb exists for. The birth commands go
// through the Context's injected Io, which here records them and runs nothing;
// git, which the verb reads the enclosing repo with, goes to the real one.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { Context, diagnose, examine, newSite, realIo, templatesRoot } from './index.ts';
import { git, repoWith, scratchDir, templatesAt, text, write } from './testing/siteRepo.ts';

const scratch = scratchDir('new');
after(scratch.remove);

const VERSION = '0.131.0';

const TEMPLATES = {
  shop: {
    manifest: [
      'name: shop',
      'questions:',
      '  tenant:',
      '    type: str',
      '    help: The tenant slug',
      '  city:',
      '    help: Where the shop is',
      '    default: Oslo',
      '  stalls:',
      '    type: int',
      '    default: 2',
      'birth:',
      '  - [git, init]',
      '  - [mise, trust]',
      '',
    ].join('\n'),
    files: {
      'PLEXUS.md.jinja': '- A shop of {{ tenant }}.\n',
      'sign.txt.jinja': '{{ tenant }} in {{ city }}\n',
      'run.sh': '#!/bin/sh\n',
      'stalls/.gitkeep': '',
    },
  },
  stall: {
    manifest: [
      'name: stall',
      'reads:',
      '  tenant:',
      'questions:',
      '  goods:',
      '    help: What the stall sells',
      '  profile:',
      '    default: stateless',
      '',
    ].join('\n'),
    files: { 'PLEXUS.md.jinja': '- A stall of {{ tenant }}.\n', 'goods.txt.jinja': '{{ goods }} of {{ tenant }}\n' },
  },
  kiosk: {
    manifest: ['name: kiosk', 'reads:', '  tenant:', '  city:', ''].join('\n'),
    files: { 'PLEXUS.md.jinja': '- A kiosk.\n', 'kiosk.txt.jinja': '{{ tenant }} in {{ city }}\n' },
  },
  rooted: {
    manifest: ['name: rooted', 'questions:', '  city:', '    default: Rome', ''].join('\n'),
    files: { 'PLEXUS.md.jinja': '- Rooted.\n' },
  },
  nomarker: {
    manifest: ['name: nomarker', ''].join('\n'),
    files: { 'a.txt': 'a\n' },
  },
};

/** A Context whose Io runs nothing but git: what it was asked to run, with what had been narrated by then. */
function recording(options = { yes: true }, fails: (command: string) => boolean = () => false) {
  const stderr = new PassThrough();
  let narrated = '';
  stderr.on('data', (chunk) => {
    narrated += chunk.toString();
  });
  const ran: { command: string; args: string[]; cwd?: string; narrated: string; tree: boolean }[] = [];
  const real = realIo();
  const ctx = new Context(options, {
    ...real,
    stderr,
    exec: async (command, args, execOptions) => {
      if (command === 'git' && args[0] === 'rev-parse') return real.exec(command, args, execOptions);
      ran.push({
        command,
        args,
        cwd: execOptions?.cwd,
        narrated,
        tree: existsSync(join(execOptions?.cwd ?? '', 'PLEXUS.md')),
      });
      if (fails(command)) throw new Error(`${command} failed`);
      return '';
    },
  });
  return { ctx, ran, narrated: () => narrated };
}

const roots = () => {
  const root = templatesAt(scratch.fresh('templates'), TEMPLATES);
  chmodSync(join(root, 'shop', 'files', 'run.sh'), 0o755);
  return root;
};

const create = (target: string, templates: string[], answers: Record<string, unknown>, root: string) =>
  ({ dir: target, templates, answers, plxVersion: VERSION, root }) as const;

test('a repo is written with its marker: the version, the templates and every resolved answer', async () => {
  const root = roots();
  const target = scratch.fresh('repo');
  const { ctx } = recording();
  const created = await newSite(ctx, create(target, ['shop'], { tenant: 'acme' }, root));
  assert.equal(text(target, 'sign.txt'), 'acme in Oslo\n');
  assert.equal(
    text(target, 'PLEXUS.md'),
    '---\nversion: 0.131.0\ntemplates: [shop]\ncity: Oslo\nstalls: 2\ntenant: acme\n---\n\n- A shop of acme.\n',
  );
  assert.equal(created.kind, 'repo');
  assert.deepEqual(created.answers, { tenant: 'acme', city: 'Oslo', stalls: 2 });
  assert.deepEqual(created.files, ['PLEXUS.md', 'run.sh', 'sign.txt', 'stalls/.gitkeep']);
});

test('the executable bit of a template file reaches the new file', async () => {
  const root = roots();
  const target = scratch.fresh('repo');
  await newSite(recording().ctx, create(target, ['shop'], { tenant: 'acme' }, root));
  const { statSync } = await import('node:fs');
  assert.ok((statSync(join(target, 'run.sh')).mode & 0o100) !== 0);
});

test('an existing empty directory takes the site, a directory with anything in it does not', async () => {
  const root = roots();
  const empty = scratch.fresh('empty');
  mkdirSync(empty);
  await newSite(recording().ctx, create(empty, ['shop'], { tenant: 'acme' }, root));
  assert.equal(text(empty, 'sign.txt'), 'acme in Oslo\n');

  const full = scratch.fresh('full');
  mkdirSync(full);
  write(full, { 'mine.txt': 'mine\n' });
  await assert.rejects(newSite(recording().ctx, create(full, ['shop'], { tenant: 'acme' }, root)), /not empty/);
  assert.equal(text(full, 'mine.txt'), 'mine\n');
});

test('a path that is a file is refused', async () => {
  const root = roots();
  const dir = scratch.fresh('file');
  write(dir, { 'x.txt': 'x\n' });
  await assert.rejects(newSite(recording().ctx, create(join(dir, 'x.txt'), ['shop'], { tenant: 'a' }, root)));
});

test('a missing answer is an error listing every missing question with its help, and nothing is written or run', async () => {
  const root = roots();
  const target = scratch.fresh('missing');
  const { ctx, ran } = recording();
  await assert.rejects(newSite(ctx, create(target, ['shop', 'stall'], {}, root)), (error: Error) => {
    assert.match(error.message, /tenant/);
    assert.match(error.message, /The tenant slug/);
    assert.match(error.message, /goods/);
    assert.match(error.message, /What the stall sells/);
    return true;
  });
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(target), false);
  assert.deepEqual(ran, []);
});

test('the birth commands run in the target directory, each printed before it runs, in the order of the manifest', async () => {
  const root = roots();
  const target = scratch.fresh('birth');
  const { ctx, ran } = recording();
  const created = await newSite(ctx, create(target, ['shop'], { tenant: 'acme' }, root));
  assert.deepEqual(
    ran.map(({ command, args, cwd }) => ({ command, args, cwd })),
    [
      { command: 'git', args: ['init'], cwd: target },
      { command: 'mise', args: ['trust'], cwd: target },
    ],
  );
  assert.match(ran[0]?.narrated ?? '', /\$ \(cd .*birth-\d+ && git init\)\n$/);
  assert.match(ran[1]?.narrated ?? '', /mise trust\)\n$/);
  assert.deepEqual(created.birth, [
    ['git', 'init'],
    ['mise', 'trust'],
  ]);
  const { existsSync } = await import('node:fs');
  assert.ok(existsSync(join(target, 'sign.txt')), 'the tree is written before the commands run');
});

test('a dry run writes nothing and runs nothing, and says what it would run', async () => {
  const root = roots();
  const target = scratch.fresh('dry');
  const { ctx, ran, narrated } = recording({ dryRun: true });
  const created = await newSite(ctx, create(target, ['shop'], { tenant: 'acme' }, root));
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(target), false);
  assert.deepEqual(ran, []);
  assert.match(narrated(), /\[dry-run\] \$ \(cd .*dry-\d+ && git init\)/);
  assert.equal(created.written, false);
  assert.deepEqual(created.files, ['PLEXUS.md', 'run.sh', 'sign.txt', 'stalls/.gitkeep']);
});

test('given answers that no template owns or reads are reported unused and are no error', async () => {
  const root = roots();
  const target = scratch.fresh('unused');
  const created = await newSite(recording().ctx, create(target, ['shop'], { tenant: 'acme', cty: 'Rome' }, root));
  assert.deepEqual(created.unused, ['cty']);
  assert.ok(!text(target, 'PLEXUS.md').includes('cty'));
});

test('a render without a marker is refused: the marker is where the answers go', async () => {
  const root = roots();
  const target = scratch.fresh('nomarker');
  await assert.rejects(newSite(recording().ctx, create(target, ['nomarker'], {}, root)), /PLEXUS\.md/);
});

test('an unknown template is refused naming the root', async () => {
  const root = roots();
  await assert.rejects(
    newSite(recording().ctx, create(scratch.fresh('unknown'), ['barn'], {}, root)),
    new RegExp(`no template barn in ${root}`),
  );
});

/** A repo whose root marker is the shop's, with the stall's directory not yet there. */
function shopRepo(extraMarker = '') {
  return repoWith(scratch.fresh('shoprepo'), {
    'PLEXUS.md': `---\nversion: ${VERSION}\ntemplates: [shop]\ntenant: acme\ncity: Oslo\nstalls: 2\n${extraMarker}---\n\n- A shop.\n`,
  });
}

test('an app in a repo is rendered with the root marker’s answers and gets its own marker without a version', async () => {
  const root = roots();
  const repo = shopRepo();
  const target = join(repo, 'apps', 'fruit');
  const created = await newSite(recording().ctx, create(target, ['stall'], { goods: 'apples' }, root));
  assert.equal(text(target, 'goods.txt'), 'apples of acme\n');
  assert.equal(
    text(target, 'PLEXUS.md'),
    '---\ntemplates: [stall]\ngoods: apples\nprofile: stateless\n---\n\n- A stall of acme.\n',
  );
  assert.equal(created.kind, 'app');
  assert.deepEqual(created.answers, { goods: 'apples', profile: 'stateless' });
});

test('an app refuses an answer that the root marker answers already, and writes nothing', async () => {
  const root = roots();
  const repo = shopRepo();
  const target = join(repo, 'apps', 'fruit');
  await assert.rejects(
    newSite(recording().ctx, create(target, ['stall'], { goods: 'apples', tenant: 'other' }, root)),
    /`tenant`.*root marker/,
  );
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(target), false);
});

test('an app in a repo whose root marker is not committed yet reads it from the working tree', async () => {
  const root = roots();
  const repo = scratch.fresh('fresh');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, { 'PLEXUS.md': `---\nversion: ${VERSION}\ntemplates: [shop]\ntenant: acme\n---\n` });
  const created = await newSite(
    recording().ctx,
    create(join(repo, 'apps', 'fruit'), ['stall'], { goods: 'pears' }, root),
  );
  assert.equal(created.kind, 'app');
  assert.equal(text(repo, 'apps/fruit/goods.txt'), 'pears of acme\n');
});

test('a directory inside a repo whose root has no marker is a new repo of its own', async () => {
  const root = roots();
  const outer = repoWith(scratch.fresh('outer'), { README: 'x\n' });
  const created = await newSite(recording().ctx, create(join(outer, 'inner'), ['shop'], { tenant: 'acme' }, root));
  assert.equal(created.kind, 'repo');
  assert.match(text(outer, 'inner/PLEXUS.md'), /^---\nversion: 0\.131\.0\n/);
});

// The two sites the verb exists for, from the bundled templates.
const bundled = createRequire(import.meta.url)('../package.json') as { version: string };

test('a repo from repo-turbo and an app from app-nextjs in it: the trees and the markers, and the newborn repo passes the doctor', async () => {
  const target = scratch.fresh('turbo');
  const { ctx, ran } = recording();
  const repo = await newSite(ctx, {
    dir: target,
    templates: ['repo-turbo'],
    answers: { tenant: 'acme' },
    plxVersion: bundled.version,
    root: templatesRoot(),
  });
  assert.equal(repo.kind, 'repo');
  assert.deepEqual(
    ran.map((r) => [r.command, ...r.args].join(' ')),
    [
      'git init',
      'mise trust',
      'mise install',
      'mise exec -- npx corepack use pnpm@12',
      'mise exec -- pnpm add --workspace-root --save-dev --save-exact @biomejs/biome',
    ],
  );
  const marker = text(target, 'PLEXUS.md');
  assert.match(marker, new RegExp(`^---\\nversion: ${bundled.version}\\ntemplates: \\[repo-turbo\\]\\n`));
  assert.match(marker, /\nci_strategy: github\n/);
  assert.match(marker, /\ntenant: acme\n/);

  // The birth commands were faked, so the repo is made a git repo here: the app finds its repo by git.
  git(target, 'init', '-q', '-b', 'main');
  const app = await newSite(recording().ctx, {
    dir: join(target, 'apps', 'web'),
    templates: ['app-nextjs'],
    answers: { name: 'web' },
    plxVersion: bundled.version,
    root: templatesRoot(),
  });
  assert.equal(app.kind, 'app');
  const appMarker = text(target, 'apps/web/PLEXUS.md');
  assert.match(appMarker, /^---\ntemplates: \[app-nextjs\]\nname: web\nprofile: stateless\n---\n\n/);
  assert.ok(!appMarker.includes('version'));
  assert.ok(!appMarker.includes('tenant'));
  assert.ok(app.files.includes('src/app/healthz/route.ts'));

  // The doctor reads what git tracks, and lists the tasks of a mise.toml that `mise trust` (faked above) would have trusted.
  process.env.MISE_TRUSTED_CONFIG_PATHS = target;
  git(target, 'add', '-A');
  const { facts } = await examine(new Context({}, realIo()), target);
  const report = diagnose(facts);
  assert.deepEqual(
    report.units.flatMap((u) => u.findings.map((f) => `${u.path}: ${f.problem}`)),
    [],
  );
  assert.equal(report.units.length, 2);
  delete process.env.MISE_TRUSTED_CONFIG_PATHS;
});

// The version the repo is on is the running plx's: the bundled templates are that version's.

/** A repo whose root marker is `marker`, committed. */
const repoMarked = (marker: string) => repoWith(scratch.fresh('marked'), { 'PLEXUS.md': marker });

test('an app is refused in a repo that is on another version, and nothing is written', async () => {
  const root = roots();
  const repo = repoMarked('---\nversion: 0.130.0\ntemplates: [shop]\ntenant: acme\n---\n');
  const target = join(repo, 'apps', 'fruit');
  await assert.rejects(
    newSite(recording().ctx, create(target, ['stall'], { goods: 'apples' }, root)),
    (error: Error) => {
      assert.match(error.message, /0\.130\.0/);
      assert.match(error.message, /0\.131\.0/);
      return true;
    },
  );
  assert.equal(existsSync(target), false);
});

test('an app is refused in a repo whose root marker lists templates and names no version', async () => {
  const root = roots();
  const repo = repoMarked('---\ntemplates: [shop]\ntenant: acme\n---\n');
  await assert.rejects(
    newSite(recording().ctx, create(join(repo, 'apps', 'fruit'), ['stall'], { goods: 'apples' }, root)),
    /names no version/,
  );
});

test('an app is created in a repo whose root marker lists no templates, with or without a version', async () => {
  const root = roots();
  const repo = repoMarked('---\ntenant: acme\n---\n');
  const created = await newSite(recording().ctx, create(join(repo, 'apps', 'fruit'), ['stall'], { goods: 'a' }, root));
  assert.equal(created.kind, 'app');
});

// An app is rendered with the root's resolved answers, the defaults of its templates included.

test('an app reads a root default that the root marker does not write', async () => {
  const root = roots();
  const repo = repoMarked(`---\nversion: ${VERSION}\ntemplates: [shop]\ntenant: acme\n---\n`);
  const created = await newSite(recording().ctx, create(join(repo, 'apps', 'k'), ['kiosk'], {}, root));
  assert.equal(created.kind, 'app');
  assert.equal(text(repo, 'apps/k/kiosk.txt'), 'acme in Oslo\n');
});

test('an app refuses an answer that is a root default, though the root marker does not write it', async () => {
  const root = roots();
  const repo = repoMarked(`---\nversion: ${VERSION}\ntemplates: [shop]\ntenant: acme\n---\n`);
  const target = join(repo, 'apps', 'k');
  await assert.rejects(
    newSite(recording().ctx, create(target, ['kiosk'], { city: 'Rome' }, root)),
    /`city`.*root marker/,
  );
  assert.equal(existsSync(target), false);
});

// A template that cannot be read is reported with every other.

test('every template that cannot be read is named in one error', async () => {
  const root = roots();
  await assert.rejects(
    newSite(recording().ctx, create(scratch.fresh('unknowns'), ['barn', 'shed'], {}, root)),
    (error: Error) => {
      assert.match(error.message, /no template barn/);
      assert.match(error.message, /no template shed/);
      return true;
    },
  );
});

// A birth command that fails leaves the files written, and says what is left to do by hand.

test('a failed birth command says that the tree is written and lists the commands still to run', async () => {
  const root = roots();
  const target = scratch.fresh('failed');
  await assert.rejects(
    newSite(
      recording({ yes: true }, (command) => command === 'git').ctx,
      create(target, ['shop'], { tenant: 'acme' }, root),
    ),
    (error: Error) => {
      assert.match(error.message, /git failed/);
      assert.match(error.message, /files are written/);
      assert.match(error.message, /git init\)\n.*mise trust\)/s);
      return true;
    },
  );
  assert.ok(existsSync(join(target, 'PLEXUS.md')));
});
