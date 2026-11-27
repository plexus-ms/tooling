// plx apply on scratch repos: real git for what is tracked and what HEAD
// holds, fixture templates for what is rendered. Each test builds a repo
// whose files are what the fixture templates render for the markers at HEAD,
// changes a marker in the working tree, and applies.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { apply, Context, planSync, realIo, templatesRoot } from './index.ts';
import {
  type Files,
  git,
  loggingContext,
  quietContext,
  repoWith,
  scratchDir,
  templatesAt,
  text,
  write,
} from './testing/siteRepo.ts';

const scratch = scratchDir('apply');
after(scratch.remove);

const VERSION = '0.131.0';

const TEMPLATES = {
  basket: {
    manifest: ['name: basket', 'questions:', '  fruit:', '    type: str', '  count:', '    default: 3', ''].join('\n'),
    files: { 'list.txt.jinja': '{{ count }} {{ fruit }}s\nfresh\nsweet\n' },
  },
  shelf: {
    manifest: ['name: shelf', 'questions:', '  width:', '    type: int', '    default: 4', ''].join('\n'),
    files: { 'shelf.txt': 'a shelf\n', 'bench.txt': 'a bench\n', 'width.txt.jinja': '{{ width }} wide\n' },
  },
  owner: {
    manifest: ['name: owner', 'questions:', '  tenant:', '    default: acme', ''].join('\n'),
    files: { 'tenant.txt.jinja': '{{ tenant }}\n' },
  },
  app: {
    manifest: ['name: app', 'reads:', '  tenant:', ''].join('\n'),
    files: { 'app.txt.jinja': 'app of {{ tenant }}\n' },
  },
  lid: {
    manifest: [
      'name: lid',
      'questions:',
      '  lid_color:',
      '    default: blue',
      'policies:',
      '  born-lid.txt: born-once',
      '',
    ].join('\n'),
    files: { 'lid.txt.jinja': 'a {{ lid_color }} lid\n', 'born-lid.txt': 'lid born\n' },
  },
  lidroot: {
    manifest: ['name: lidroot', 'questions:', '  lid_color:', '    default: blue', ''].join('\n'),
    files: { 'lidroot.txt.jinja': '{{ lid_color }}\n' },
  },
  need: {
    manifest: ['name: need', 'questions:', '  token:', '    type: str', ''].join('\n'),
    files: { 'token.txt.jinja': '{{ token }}\n' },
  },
  reserved: {
    manifest: ['name: reserved', 'questions:', '  version:', '    default: 9.9.9', ''].join('\n'),
    files: { 'r.txt': 'r\n' },
  },
  crate: {
    manifest: ['name: crate', 'reads:', '  fruit:', ''].join('\n'),
    files: { 'crate.txt.jinja': 'a crate of {{ fruit }}s\n' },
  },
};

const marker = (keys: string, body = '\n- A repo.\n') => `---\n${keys}---\n${body}`;

/** A repo whose committed state is a basket of apples, and a root of the fixture templates. */
function fixture(extra: Files = {}) {
  const templates = templatesAt(scratch.fresh('templates'), TEMPLATES);
  const repo = repoWith(scratch.fresh('repo'), {
    'PLEXUS.md': marker(`version: ${VERSION}\ntemplates: [basket]\nfruit: apple\n`),
    'list.txt': '3 apples\nfresh\nsweet\n',
    ...extra,
  });
  return { templates, repo };
}

const options = (repo: string, templates: string, plxVersion = VERSION) => ({ repo, templates, plxVersion });

test('apply refuses when the running plx is not the version the root marker names, and writes nothing', async () => {
  const { repo, templates } = fixture();
  write(repo, { 'PLEXUS.md': marker(`version: ${VERSION}\ntemplates: [basket]\nfruit: pear\n`) });
  await assert.rejects(apply(quietContext(), options(repo, templates, '0.132.0')), (error: Error) => {
    assert.match(error.message, /0\.131\.0/);
    assert.match(error.message, /0\.132\.0/);
    return true;
  });
  assert.equal(text(repo, 'list.txt'), '3 apples\nfresh\nsweet\n');
});

test('apply refuses when the root marker names no version although a site lists templates', async () => {
  const { repo, templates } = fixture();
  write(repo, { 'PLEXUS.md': marker('templates: [basket]\nfruit: pear\n') });
  await assert.rejects(apply(quietContext(), options(repo, templates)), /names no version/);
});

test('apply refuses in a repo that still tracks a copier answers file, and points to the crossover runbook', async () => {
  const { repo, templates } = fixture({ 'apps/web/.copier-answers.yml': '_commit: v0.129.1\n' });
  write(repo, { 'PLEXUS.md': marker(`version: ${VERSION}\ntemplates: [basket]\nfruit: pear\n`) });
  await assert.rejects(apply(quietContext(), options(repo, templates)), (error: Error) => {
    assert.match(error.message, /\.copier-answers\.yml/);
    assert.match(error.message, /crossover runbook/);
    return true;
  });
  assert.equal(text(repo, 'list.txt'), '3 apples\nfresh\nsweet\n');
});

test('a copier answers file that git does not track does not stop apply', async () => {
  const { repo, templates } = fixture();
  write(repo, { '.copier-answers.yml': '_commit: v0.129.1\n' });
  const applied = await apply(quietContext(), options(repo, templates));
  assert.deepEqual(applied.sites, []);
});

const pears = marker(`version: ${VERSION}\ntemplates: [basket]\nfruit: pear\n`);

test('apply renders a site whose answer changed, merging into the working tree and keeping the local edit', async () => {
  const { repo, templates } = fixture();
  write(repo, { 'PLEXUS.md': pears, 'list.txt': '3 apples\nfresh\nsour\n' });
  const applied = await apply(quietContext(), options(repo, templates));
  assert.equal(text(repo, 'list.txt'), '3 pears\nfresh\nsour\n');
  assert.deepEqual(applied.sites, [{ dir: '.', report: [{ path: 'list.txt', outcome: 'clean' }], defaults: {} }]);
  assert.equal(applied.conflicted, 0);
  assert.equal(applied.applied, true);
  assert.equal(text(repo, 'PLEXUS.md'), pears);
});

test('apply commits nothing and stages nothing', async () => {
  const { repo, templates } = fixture();
  const head = git(repo, 'rev-parse', 'HEAD');
  write(repo, { 'PLEXUS.md': pears });
  await apply(quietContext(), options(repo, templates));
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'diff', '--cached', '--name-only'), '');
  assert.equal(git(repo, 'status', '--short'), ' M PLEXUS.md\n M list.txt\n');
});

test('apply says it changed nothing when no marker differs from HEAD', async () => {
  const { repo, templates } = fixture();
  const applied = await apply(quietContext(), options(repo, templates));
  assert.deepEqual(applied, { sites: [], conflicted: 0, applied: false, declined: false });
});

const CRATE = marker('templates: [crate]\n', '\n- A crate.\n');

test('apply re-renders a nested site that reads an answer of the root marker when the root changes it', async () => {
  const { repo, templates } = fixture({ 'apps/crate/PLEXUS.md': CRATE, 'apps/crate/crate.txt': 'a crate of apples\n' });
  write(repo, { 'PLEXUS.md': pears });
  const applied = await apply(quietContext(), options(repo, templates));
  assert.equal(text(repo, 'apps/crate/crate.txt'), 'a crate of pears\n');
  assert.equal(text(repo, 'list.txt'), '3 pears\nfresh\nsweet\n');
  assert.deepEqual(
    applied.sites.map((s) => [s.dir, s.report]),
    [
      ['.', [{ path: 'list.txt', outcome: 'clean' }]],
      ['apps/crate', [{ path: 'crate.txt', outcome: 'clean' }]],
    ],
  );
});

test('apply renders only the sites whose answers or templates changed', async () => {
  const { repo, templates } = fixture({
    'apps/crate/PLEXUS.md': CRATE,
    'apps/crate/crate.txt': 'a crate of apples\n',
    'apps/old/PLEXUS.md': marker('templates: [ghost]\n'),
  });
  write(repo, { 'apps/crate/PLEXUS.md': marker('templates: [crate]\nextra: 1\n', '\n- A crate.\n') });
  const applied = await apply(quietContext(), options(repo, templates));
  assert.deepEqual(
    applied.sites.map((s) => s.dir),
    ['apps/crate'],
  );
});

const both = (keys = '') => marker(`version: ${VERSION}\ntemplates: [basket, shelf]\nfruit: apple\n${keys}`);

test('apply adds the files of a template added to a site, and writes the defaults of its questions into the marker', async () => {
  const { repo, templates } = fixture();
  write(repo, { 'PLEXUS.md': both() });
  const applied = await apply(quietContext(), options(repo, templates));
  assert.equal(text(repo, 'shelf.txt'), 'a shelf\n');
  assert.equal(text(repo, 'bench.txt'), 'a bench\n');
  assert.equal(text(repo, 'width.txt'), '4 wide\n');
  assert.deepEqual(applied.sites, [
    {
      dir: '.',
      report: [
        { path: 'bench.txt', outcome: 'added' },
        { path: 'shelf.txt', outcome: 'added' },
        { path: 'width.txt', outcome: 'added' },
      ],
      defaults: { width: 4 },
    },
  ]);
  assert.equal(text(repo, 'PLEXUS.md'), both('width: 4\n'));
});

test('apply writes no default for a question that was applicable before, and none the marker answers', async () => {
  const { repo, templates } = fixture();
  write(repo, { 'PLEXUS.md': both('width: 9\n') });
  const applied = await apply(quietContext(), options(repo, templates));
  assert.deepEqual(applied.sites[0]?.defaults, {});
  assert.equal(text(repo, 'width.txt'), '9 wide\n');
  assert.equal(text(repo, 'PLEXUS.md'), both('width: 9\n'));
});

test('apply deletes the unedited files of a template removed from a site, keeps the edited ones, and reports the conflict', async () => {
  const { repo, templates } = fixture();
  git(repo, 'rm', '-q', '--cached', 'PLEXUS.md');
  write(repo, { 'PLEXUS.md': both(), 'shelf.txt': 'a shelf\n', 'bench.txt': 'a bench\n', 'width.txt': '4 wide\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'shelf');
  write(repo, {
    'PLEXUS.md': marker(`version: ${VERSION}\ntemplates: [basket]\nfruit: apple\n`),
    'bench.txt': 'my bench\n',
  });
  const applied = await apply(quietContext(), options(repo, templates));
  assert.equal(existsSync(join(repo, 'shelf.txt')), false);
  assert.equal(existsSync(join(repo, 'width.txt')), false);
  assert.equal(text(repo, 'bench.txt'), 'my bench\n');
  assert.deepEqual(applied.sites[0]?.report, [
    { path: 'bench.txt', outcome: 'conflicted' },
    { path: 'shelf.txt', outcome: 'deleted' },
    { path: 'width.txt', outcome: 'deleted' },
  ]);
  assert.equal(applied.conflicted, 1);
});

test('apply renders a site whose marker is new, from nothing, once git tracks it', async () => {
  const { repo, templates } = fixture();
  write(repo, { 'apps/crate/PLEXUS.md': CRATE });
  assert.deepEqual((await apply(quietContext(), options(repo, templates))).sites, []);
  git(repo, 'add', 'apps/crate/PLEXUS.md');
  const applied = await apply(quietContext(), options(repo, templates));
  assert.equal(text(repo, 'apps/crate/crate.txt'), 'a crate of apples\n');
  assert.deepEqual(
    applied.sites.map((s) => s.dir),
    ['apps/crate'],
  );
});

test('apply lists every render error of every site, and writes nothing', async () => {
  const { repo, templates } = fixture({ 'apps/crate/PLEXUS.md': CRATE, 'apps/crate/crate.txt': 'a crate of apples\n' });
  write(repo, { 'PLEXUS.md': marker(`version: ${VERSION}\ntemplates: [basket, ghost]\ncount: 4\n`) });
  await assert.rejects(apply(quietContext(), options(repo, templates)), (error: Error) => {
    assert.match(error.message, /^\.: no template ghost/m);
    assert.match(error.message, /^apps\/crate: .*fruit/m);
    return true;
  });
  assert.equal(text(repo, 'list.txt'), '3 apples\nfresh\nsweet\n');
  assert.equal(text(repo, 'apps/crate/crate.txt'), 'a crate of apples\n');
});

test('apply under --dry-run reports what it would do and writes nothing', async () => {
  const { repo, templates } = fixture();
  write(repo, { 'PLEXUS.md': both() });
  const applied = await apply(quietContext({ dryRun: true }), options(repo, templates));
  assert.equal(applied.applied, false);
  assert.equal(applied.sites[0]?.report.length, 3);
  assert.equal(existsSync(join(repo, 'shelf.txt')), false);
  assert.equal(text(repo, 'PLEXUS.md'), both());
});

test('apply asks before it writes, and writes nothing when the answer is no', async () => {
  const { repo, templates } = fixture();
  write(repo, { 'PLEXUS.md': pears });
  const asked: string[] = [];
  const io = {
    ...realIo(),
    stderr: new PassThrough(),
    prompt: async (question: string) => {
      asked.push(question);
      return false;
    },
  };
  const applied = await apply(new Context({}, io), options(repo, templates));
  assert.equal(asked.length, 1);
  assert.equal(applied.applied, false);
  assert.equal(text(repo, 'list.txt'), '3 apples\nfresh\nsweet\n');
});

test('planSync takes an old side that arrived rendered, with its policies', async () => {
  const { repo, templates } = fixture({ 'old.txt': 'old\n', 'mine.txt': 'mine\n' });
  const rendered = {
    tree: new Map([
      ['list.txt', { bytes: Buffer.from('3 apples\nfresh\nsweet\n'), mode: 0o100644 }],
      ['old.txt', { bytes: Buffer.from('old\n'), mode: 0o100644 }],
    ]),
    policies: new Map([
      ['list.txt', { template: 'basket', policy: 'merge' as const }],
      ['old.txt', { template: 'basket', policy: 'merge' as const }],
    ]),
    answers: { fruit: 'apple', count: 3 },
  };
  const plan = await planSync(quietContext(), repo, templates, [
    { dir: '.', old: rendered, new: { templates: ['basket'], answers: { fruit: 'pear' } } },
  ]);
  assert.deepEqual(plan.sites[0]?.report, [
    { path: 'list.txt', outcome: 'clean' },
    { path: 'old.txt', outcome: 'deleted' },
  ]);
  assert.equal(text(repo, 'list.txt'), '3 apples\nfresh\nsweet\n');
  await plan.perform();
  assert.equal(text(repo, 'list.txt'), '3 pears\nfresh\nsweet\n');
  assert.equal(existsSync(join(repo, 'old.txt')), false);
  assert.equal(text(repo, 'mine.txt'), 'mine\n');
});

test('apply refuses a marker it cannot read, naming it and the side, and deletes nothing', async () => {
  const { repo, templates } = fixture({ 'apps/crate/PLEXUS.md': CRATE, 'apps/crate/crate.txt': 'a crate of apples\n' });
  write(repo, { 'apps/crate/PLEXUS.md': marker('templates: [crate\n') });
  await assert.rejects(apply(quietContext(), options(repo, templates)), (error: Error) => {
    assert.match(error.message, /apps\/crate\/PLEXUS\.md/);
    assert.match(error.message, /working tree/);
    return true;
  });
  assert.equal(text(repo, 'apps/crate/crate.txt'), 'a crate of apples\n');
});

test('apply refuses a marker at HEAD it cannot read, even when the working tree has fixed it, and says to commit the fix', async () => {
  const { repo, templates } = fixture({ 'apps/crate/PLEXUS.md': marker('templates: [crate\n') });
  write(repo, { 'apps/crate/PLEXUS.md': CRATE });
  await assert.rejects(apply(quietContext(), options(repo, templates)), (error: Error) => {
    assert.match(error.message, /apps\/crate\/PLEXUS\.md at HEAD/);
    assert.match(error.message, /commit/);
    return true;
  });
  assert.equal(existsSync(join(repo, 'apps/crate/crate.txt')), false);
});

test('apply refuses a nested marker that carries version', async () => {
  const { repo, templates } = fixture({ 'apps/crate/PLEXUS.md': CRATE });
  write(repo, { 'apps/crate/PLEXUS.md': marker(`version: ${VERSION}\ntemplates: [crate]\n`) });
  await assert.rejects(apply(quietContext(), options(repo, templates)), /apps\/crate\/PLEXUS\.md.*version/s);
});

test('apply reports an unreadable root marker as that, not as a missing version', async () => {
  const { repo, templates } = fixture();
  write(repo, { 'PLEXUS.md': marker(`version: ${VERSION}\ntemplates: [basket\nfruit: pear\n`) });
  await assert.rejects(apply(quietContext(), options(repo, templates)), (error: Error) => {
    assert.match(error.message, /PLEXUS\.md/);
    assert.doesNotMatch(error.message, /names no version/);
    return true;
  });
});

test('apply says what to do when the root marker names no version', async () => {
  const { repo, templates } = fixture();
  write(repo, { 'PLEXUS.md': marker('templates: [basket]\nfruit: pear\n') });
  await assert.rejects(apply(quietContext(), options(repo, templates)), /set `version: 0\.131\.0`/);
});

test('apply refuses a version edited by hand, even to the running plx, and says only plx update writes it', async () => {
  const templates = templatesAt(scratch.fresh('templates'), TEMPLATES);
  const repo = repoWith(scratch.fresh('repo'), {
    'PLEXUS.md': marker('version: 0.130.0\ntemplates: [basket]\nfruit: apple\n'),
    'list.txt': '3 apples\nfresh\nsweet\n',
  });
  write(repo, { 'PLEXUS.md': marker(`version: ${VERSION}\ntemplates: [basket]\nfruit: pear\n`) });
  await assert.rejects(apply(quietContext(), options(repo, templates)), (error: Error) => {
    assert.match(error.message, /0\.130\.0/);
    assert.match(error.message, /only `plx update` writes it/);
    return true;
  });
  assert.equal(text(repo, 'list.txt'), '3 apples\nfresh\nsweet\n');
});

test('apply finds the repo from a subdirectory instead of taking a nested marker for the root', async () => {
  const { repo, templates } = fixture({ 'apps/crate/PLEXUS.md': CRATE, 'apps/crate/crate.txt': 'a crate of apples\n' });
  write(repo, { 'PLEXUS.md': pears });
  const applied = await apply(quietContext(), options(join(repo, 'apps/crate'), templates));
  assert.deepEqual(
    applied.sites.map((s) => s.dir),
    ['.', 'apps/crate'],
  );
  assert.equal(text(repo, 'list.txt'), '3 pears\nfresh\nsweet\n');
});

test('apply says a directory that is no repo is none, and a repo without a commit has nothing to compare with', async () => {
  const { templates } = fixture();
  const plain = scratch.fresh('plain');
  write(plain, { 'a.txt': 'a' });
  await assert.rejects(apply(quietContext(), options(plain, templates)), /not inside a git repository/);
  const empty = scratch.fresh('empty');
  write(empty, { 'PLEXUS.md': marker(`version: ${VERSION}\ntemplates: [basket]\nfruit: apple\n`) });
  git(empty, 'init', '-q', '-b', 'main');
  git(empty, 'add', '-A');
  await assert.rejects(apply(quietContext(), options(empty, templates)), (error: Error) => {
    assert.match(error.message, /no commit/);
    assert.doesNotMatch(error.message, /exited with/);
    return true;
  });
});

const EMPTY = marker('templates: []\n');

test('apply gives a default the root adopts, a root answer, to a nested site that reads it, in the same run', async () => {
  const { repo, templates } = fixture({ 'apps/x/PLEXUS.md': EMPTY });
  write(repo, {
    'PLEXUS.md': marker(`version: ${VERSION}\ntemplates: [basket, owner]\nfruit: apple\n`),
    'apps/x/PLEXUS.md': marker('templates: [app]\n'),
  });
  const applied = await apply(quietContext(), options(repo, templates));
  assert.equal(text(repo, 'tenant.txt'), 'acme\n');
  assert.equal(text(repo, 'apps/x/app.txt'), 'app of acme\n');
  assert.deepEqual(
    applied.sites.map((s) => [s.dir, s.defaults]),
    [
      ['.', { tenant: 'acme' }],
      ['apps/x', {}],
    ],
  );
  assert.equal(text(repo, 'apps/x/PLEXUS.md'), marker('templates: [app]\n'));
});

test('apply refuses a default that the root and a nested site would both write, naming the key, templates and markers', async () => {
  const { repo, templates } = fixture({ 'apps/x/PLEXUS.md': EMPTY });
  const root = marker(`version: ${VERSION}\ntemplates: [basket, lidroot]\nfruit: apple\n`);
  write(repo, { 'PLEXUS.md': root, 'apps/x/PLEXUS.md': marker('templates: [lid]\n') });
  await assert.rejects(apply(quietContext(), options(repo, templates)), (error: Error) => {
    for (const part of [/lid_color/, /lidroot/, /\blid\b/, /PLEXUS\.md/, /apps\/x\/PLEXUS\.md/])
      assert.match(error.message, part);
    return true;
  });
  assert.equal(text(repo, 'PLEXUS.md'), root);
  assert.equal(existsSync(join(repo, 'lidroot.txt')), false);
});

test('apply refuses a root default for a key that a nested marker already answers', async () => {
  const { repo, templates } = fixture({ 'apps/x/PLEXUS.md': marker('templates: [lid]\nlid_color: green\n') });
  write(repo, { 'PLEXUS.md': marker(`version: ${VERSION}\ntemplates: [basket, lidroot]\nfruit: apple\n`) });
  await assert.rejects(apply(quietContext(), options(repo, templates)), /lid_color.*apps\/x\/PLEXUS\.md/s);
});

test('apply refuses a template that declares a question named like a marker key, and writes nothing', async () => {
  const { repo, templates } = fixture();
  write(repo, { 'PLEXUS.md': marker(`version: ${VERSION}\ntemplates: [basket, reserved]\nfruit: apple\n`) });
  await assert.rejects(apply(quietContext(), options(repo, templates)), (error: Error) => {
    assert.match(error.message, /reserved/);
    assert.match(error.message, /`version`/);
    return true;
  });
  assert.equal(existsSync(join(repo, 'r.txt')), false);
});

test('apply leaves a nested site alone when the root answer that changed is none its templates read or own', async () => {
  const { repo, templates } = fixture({
    'apps/need/PLEXUS.md': marker('templates: [need]\ntoken: t\n'),
    'apps/need/token.txt': 't\n',
    'apps/lid/PLEXUS.md': marker('templates: [lid]\nlid_color: blue\n'),
    'apps/lid/lid.txt': 'a blue lid\n',
  });
  write(repo, { 'PLEXUS.md': marker(`version: ${VERSION}\ntemplates: [basket]\nfruit: apple\ncount: 5\n`) });
  const applied = await apply(quietContext(), options(repo, templates));
  assert.deepEqual(
    applied.sites.map((s) => s.dir),
    ['.'],
  );
  assert.equal(
    existsSync(join(repo, 'apps/lid/born-lid.txt')),
    false,
    'a born-once file the user does not have is not written back',
  );
});

test('apply renders a nested site when a root answer that changed is one its template owns', async () => {
  const { repo, templates } = fixture({
    'PLEXUS.md': marker(`version: ${VERSION}\ntemplates: [basket]\nfruit: apple\nlid_color: blue\n`),
    'apps/lid/PLEXUS.md': marker('templates: [lid]\n'),
    'apps/lid/lid.txt': 'a blue lid\n',
    'apps/lid/born-lid.txt': 'lid born\n',
  });
  write(repo, { 'PLEXUS.md': marker(`version: ${VERSION}\ntemplates: [basket]\nfruit: apple\nlid_color: green\n`) });
  await apply(quietContext(), options(repo, templates));
  assert.equal(text(repo, 'apps/lid/lid.txt'), 'a green lid\n');
});

test('apply lists a render error once, and says which markers it comes from', async () => {
  const { repo, templates } = fixture({ 'apps/need/PLEXUS.md': marker('templates: [need]\n') });
  write(repo, { 'apps/need/PLEXUS.md': marker('templates: [need]\nextra: 1\n') });
  await assert.rejects(apply(quietContext(), options(repo, templates)), (error: Error) => {
    assert.equal(error.message.split('\n').filter((l) => /token/.test(l)).length, 1);
    return true;
  });
  write(repo, { 'apps/need/PLEXUS.md': marker('templates: [need]\ntoken: x\n') });
  await assert.rejects(apply(quietContext(), options(repo, templates)), /apps\/need.*markers at HEAD/s);
});

test('apply writes the default of a nested site into the nested marker, not the root one', async () => {
  const { repo, templates } = fixture({ 'apps/x/PLEXUS.md': EMPTY });
  write(repo, { 'apps/x/PLEXUS.md': marker('templates: [lid]\n') });
  const applied = await apply(quietContext(), options(repo, templates));
  assert.equal(text(repo, 'apps/x/PLEXUS.md'), marker('templates: [lid]\nlid_color: blue\n'));
  assert.equal(text(repo, 'PLEXUS.md'), marker(`version: ${VERSION}\ntemplates: [basket]\nfruit: apple\n`));
  assert.deepEqual(applied.sites[0]?.defaults, { lid_color: 'blue' });
});

test('apply does not look at the version of a repo that lists no templates', async () => {
  const repo = repoWith(scratch.fresh('repo'), { 'PLEXUS.md': marker('version: 0.1.0\nfruit: apple\n') });
  write(repo, { 'PLEXUS.md': marker('version: 0.1.0\nfruit: pear\n') });
  assert.deepEqual(await apply(quietContext(), { repo, plxVersion: VERSION }), {
    sites: [],
    conflicted: 0,
    applied: false,
    declined: false,
  });
});

test('apply renders nothing for a site that lists no templates on either side, whatever its answers do', async () => {
  const { repo, templates } = fixture({ 'apps/x/PLEXUS.md': EMPTY });
  write(repo, { 'apps/x/PLEXUS.md': marker('templates: []\nnote: 1\n') });
  assert.deepEqual((await apply(quietContext(), options(repo, templates))).sites, []);
});

test('apply needs no templates root when no marker changed, and takes the bundled templates when something did', async () => {
  const { repo } = fixture();
  write(repo, { 'PLEXUS.md': marker(`version: ${VERSION}\ntemplates: [basket, ghost]\nfruit: apple\n`) });
  await assert.rejects(apply(quietContext(), { repo, plxVersion: VERSION }), (error: Error) =>
    error.message.includes(`no template basket in ${templatesRoot()}`),
  );
  git(repo, 'checkout', '--', 'PLEXUS.md');
  assert.equal((await apply(quietContext(), { repo, plxVersion: VERSION })).sites.length, 0);
});

test('apply asks nothing when the re-render changes no file, and counts the defaults it writes in what it asks', async () => {
  const { repo, templates } = fixture();
  write(repo, { 'PLEXUS.md': marker(`version: ${VERSION}\ntemplates: [basket]\nfruit: apple\nnote: 1\n`) });
  const quiet = loggingContext({});
  const same = await apply(quiet.ctx, options(repo, templates));
  assert.equal(quiet.asked.length, 0);
  assert.deepEqual(
    same.sites.map((s) => s.report),
    [[]],
  );
  write(repo, { 'PLEXUS.md': both() });
  const adding = loggingContext({});
  await apply(adding.ctx, options(repo, templates));
  assert.match(adding.asked[0] ?? '', /^apply 4 changes in one site to /);
});

test('apply narrates each path it writes, marking a dry run', async () => {
  const { repo, templates } = fixture();
  write(repo, { 'PLEXUS.md': both() });
  const dry = loggingContext({ dryRun: true });
  await apply(dry.ctx, options(repo, templates));
  assert.match(dry.log(), /^\[dry-run\] added shelf\.txt$/m);
  const real = loggingContext();
  await apply(real.ctx, options(repo, templates));
  assert.match(real.log(), /^added shelf\.txt$/m);
});

test('apply names the template, path and question of a render error', async () => {
  const { repo, templates } = fixture({ 'apps/x/PLEXUS.md': EMPTY });
  write(repo, { 'apps/x/PLEXUS.md': marker('templates: [need]\n') });
  await assert.rejects(apply(quietContext(), options(repo, templates)), /\(template need, question token\)/);
});

test('apply reports a missing template alone, without the errors of the templates that were found', async () => {
  const { repo, templates } = fixture({ 'apps/x/PLEXUS.md': EMPTY });
  write(repo, { 'apps/x/PLEXUS.md': marker('templates: [need, ghost]\n') });
  await assert.rejects(apply(quietContext(), options(repo, templates)), (error: Error) => {
    assert.match(error.message, /no template ghost/);
    assert.doesNotMatch(error.message, /token/);
    return true;
  });
});

test('apply gives the nested site of the old side the root defaults of the old side', async () => {
  const { repo, templates } = fixture({
    'PLEXUS.md': marker(`version: ${VERSION}\ntemplates: [basket, owner]\nfruit: apple\n`),
    'tenant.txt': 'acme\n',
    'apps/x/PLEXUS.md': marker('templates: [app]\n'),
    'apps/x/app.txt': 'app of acme\n',
  });
  write(repo, { 'apps/x/PLEXUS.md': marker('templates: [app]\nnote: 1\n') });
  const applied = await apply(quietContext(), options(repo, templates));
  assert.deepEqual(
    applied.sites.map((s) => [s.dir, s.report]),
    [['apps/x', []]],
  );
});
