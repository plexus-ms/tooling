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
    files: { 'list.txt.jinja': '{{ count }} {{ fruit }}s\nfresh\n' },
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
    'list.txt': '3 apples\nfresh\n',
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
  assert.equal(text(repo, 'list.txt'), '3 apples\nfresh\n');
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
  assert.equal(text(repo, 'list.txt'), '3 apples\nfresh\n');
});

test('a copier answers file that git does not track does not stop apply', async () => {
  const { repo, templates } = fixture();
  write(repo, { '.copier-answers.yml': '_commit: v0.129.1\n' });
  const applied = await apply(quietContext(), options(repo, templates));
  assert.deepEqual(applied.sites, []);
  git(repo, 'status', '--short');
});
