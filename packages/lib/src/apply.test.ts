// plx apply on scratch repos: real git for what is tracked and what HEAD
// holds, fixture templates for what is rendered. Each test builds a repo
// whose files are what the fixture templates render for the markers at HEAD,
// changes a marker in the working tree, and applies.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { apply } from './index.ts';
import { type Files, git, quietContext, repoWith, scratchDir, templatesAt, text, write } from './testing/siteRepo.ts';

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
  assert.deepEqual(applied, { sites: [], conflicted: 0, applied: false });
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
