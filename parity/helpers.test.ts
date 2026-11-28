// The helpers of the parity ring that have behaviour of their own, each pinned
// before the ring relies on it: the marker strip, the answers mapping, the
// normalisation of a copier tree, the comparison of two trees, the conflict
// labels and the consumer edits of a replay.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { REGULAR, type Tree } from '../packages/cli-template/src/index.ts';
import { cloneTemplateRepos, GIT_CONFIG, isolatedEnv, run } from './harness.ts';
import {
  consumerEdits,
  copierAnswersAsEngine,
  copierJob,
  copierManifest,
  diffTrees,
  normaliseCopierTree,
  portedPath,
  stripCopierMarker,
  unifyConflictLabels,
  unifyTree,
  withMarkerFrontmatter,
} from './helpers.ts';

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const tree = (files: Record<string, string | { text: string; mode: number }>): Tree =>
  new Map(
    Object.entries(files).map(([path, f]) => [
      path,
      typeof f === 'string' ? { bytes: enc(f), mode: REGULAR | 0o644 } : { bytes: enc(f.text), mode: f.mode },
    ]),
  );

test('the marker strip removes the frontmatter and the blank line after it, and nothing else', () => {
  assert.equal(dec(stripCopierMarker(enc('---\nprofile: stateful\n---\n\nbody\n---\nmore\n'))), 'body\n---\nmore\n');
  assert.equal(dec(stripCopierMarker(enc('---\n---\n\n\nbody\n'))), '\nbody\n');
});

test("copier's answers are completed with the keys of its marker's frontmatter, and with none where it has none", () => {
  const recorded = { tenant: 'acme' };
  assert.deepEqual(withMarkerFrontmatter(recorded, tree({ 'PLEXUS.md': '---\nmajor: 3\n---\n\nbody\n' })), {
    tenant: 'acme',
    major: 3,
  });
  assert.deepEqual(withMarkerFrontmatter(recorded, tree({ 'PLEXUS.md': '---\n---\n\nbody\n' })), recorded);
  assert.deepEqual(withMarkerFrontmatter(recorded, tree({})), recorded);
});

test("where copier's answers and its marker's frontmatter hold the same key, the recorded answer stands", () => {
  const copied = tree({ 'PLEXUS.md': '---\nprofile: stateful-app\n---\n\nbody\n' });
  assert.deepEqual(withMarkerFrontmatter({ profile: 'stateful' }, copied), { profile: 'stateful' });
});

test('the marker strip takes a marker with a frontmatter and no body to be empty', () => {
  assert.equal(dec(stripCopierMarker(enc('---\nplexus: 0.119.0\nmodules: [a, b]\n---\n'))), '');
});

test('the marker strip refuses a file without frontmatter, and a body that does not follow a blank line', () => {
  assert.throws(() => stripCopierMarker(enc('body\n')), /frontmatter/);
  assert.throws(() => stripCopierMarker(enc('---\na: 1\n---\nbody\n')), /blank line/);
  assert.throws(() => stripCopierMarker(enc('---\na: 1\n')), /frontmatter/);
});

test('an app is given to copier with the profile spelled as copier has it, and its tenant in its parent', () => {
  assert.deepEqual(copierJob('app-nextjs', { name: '@acme/api', profile: 'stateful', tenant: 'acme' }), {
    data: { name: '@acme/api', profile: 'stateful-app' },
    parent: { tenant: 'acme' },
  });
  assert.deepEqual(copierJob('app-nextjs', { name: '@acme/web', tenant: 'acme' }), {
    data: { name: '@acme/web' },
    parent: { tenant: 'acme' },
  });
});

test('a repo is given to copier as it is, and has no parent', () => {
  assert.deepEqual(copierJob('repo-turbo', { tenant: 'acme', ci_strategy: 'hybrid', profile: 'stateful' }), {
    data: { tenant: 'acme', ci_strategy: 'hybrid', profile: 'stateful' },
  });
});

test("copier's recorded profile is read as the engine spells it, every other answer as it is", () => {
  assert.deepEqual(copierAnswersAsEngine({ name: 'a', profile: 'stateful-app', n: 3 }), {
    name: 'a',
    profile: 'stateful',
    n: 3,
  });
  assert.deepEqual(copierAnswersAsEngine({ profile: 'stateless-app' }), { profile: 'stateless' });
  assert.deepEqual(copierAnswersAsEngine({ tenant: 'acme' }), { tenant: 'acme' });
});

test('a copier tree is compared without its answers file and without its marker frontmatter', () => {
  const normal = normaliseCopierTree(
    tree({
      '.copier-answers.yml': 'a: 1\n',
      'PLEXUS.md': '---\nprofile: stateless\n---\n\nbody\n',
      'a.txt': '---\n---\n\nx',
    }),
  );
  assert.deepEqual([...normal.keys()].sort(), ['PLEXUS.md', 'a.txt']);
  assert.equal(dec(normal.get('PLEXUS.md')?.bytes ?? new Uint8Array()), 'body\n');
  assert.equal(dec(normal.get('a.txt')?.bytes ?? new Uint8Array()), '---\n---\n\nx');
});

test('a copier tree without a marker is not normalised, a marker without frontmatter is an error', () => {
  assert.deepEqual([...normaliseCopierTree(tree({ 'a.txt': 'x' })).keys()], ['a.txt']);
  assert.throws(() => normaliseCopierTree(tree({ 'PLEXUS.md': 'body\n' })), /frontmatter/);
});

test('two trees that are alike differ nowhere', () => {
  const a = tree({ 'a.txt': 'x', 'bin/run': { text: '#!/bin/sh\n', mode: REGULAR | 0o755 } });
  assert.deepEqual(diffTrees(a, tree({ 'a.txt': 'x', 'bin/run': { text: '#!/bin/sh\n', mode: REGULAR | 0o755 } })), []);
});

test('a difference names the path and what differs, and says which side holds it', () => {
  const copier = tree({
    'same.txt': 'x',
    'bytes.txt': 'one\ntwo\n',
    'exec.sh': { text: 'x', mode: REGULAR | 0o755 },
    'copier-only.txt': 'x',
  });
  const engine = tree({
    'same.txt': 'x',
    'bytes.txt': 'one\nTWO\n',
    'exec.sh': 'x',
    'engine-only.txt': 'x',
  });
  assert.deepEqual(diffTrees(copier, engine), [
    'bytes.txt: bytes differ, first at line 2: copier "two", the engine "TWO"',
    'copier-only.txt: only copier writes it',
    'engine-only.txt: only the engine writes it',
    'exec.sh: executable bit differs: copier true, the engine false',
  ]);
});

test('the two sides can be named otherwise, in every kind of difference', () => {
  const left = tree({ 'a.txt': 'x', 'both.txt': 'one', 'run.sh': { text: 'x', mode: REGULAR | 0o755 }, d: 'x' });
  const right = new Map([
    ...tree({ 'b.txt': 'x', 'both.txt': 'two', 'run.sh': 'x' }),
    ['d', { bytes: new Uint8Array(), mode: 0o040000 }],
  ]);
  assert.deepEqual(diffTrees(left, right, { copier: 'the template repo', engine: 'tooling' }), [
    'a.txt: only the template repo writes it',
    'b.txt: only tooling writes it',
    'both.txt: bytes differ, first at line 1: the template repo "one", tooling "two"',
    'd: the template repo has a file, tooling a directory',
    'run.sh: executable bit differs: the template repo true, tooling false',
  ]);
});

test('an entry that is a file on one side and an empty directory on the other differs', () => {
  const dir = new Map([['d', { bytes: new Uint8Array(), mode: 0o040000 }]]);
  assert.deepEqual(diffTrees(tree({ d: 'x' }), dir), ['d: copier has a file, the engine a directory']);
});

test("each side's conflict labels become bare markers, and no other label does", () => {
  const copier = 'a\n<<<<<<< before updating\nmine\n=======\ntheirs\n>>>>>>> after updating\nz\n';
  const engine = 'a\n<<<<<<< current\nmine\n=======\ntheirs\n>>>>>>> new render\nz\n';
  const bare = 'a\n<<<<<<<\nmine\n=======\ntheirs\n>>>>>>>\nz\n';
  assert.equal(unifyConflictLabels(copier, 'copier'), bare);
  assert.equal(unifyConflictLabels(engine, 'engine'), bare);
  assert.equal(unifyConflictLabels(copier, 'engine'), copier);
  assert.equal(unifyConflictLabels('<<<<<<< current extra\n', 'engine'), '<<<<<<< current extra\n');
});

const lines = (n: number) => `${Array.from({ length: n }, (_, i) => String(i + 1)).join('\n')}\n`;

test('the consumer edits a file the template changed: the first at the changed line, the second far from it', () => {
  const old = tree({ 'a.txt': lines(9), 'b.txt': lines(9) });
  const next = tree({ 'a.txt': lines(9).replace('\n2\n', '\n2x\n'), 'b.txt': lines(9).replace('\n2\n', '\n2x\n') });
  const edits = consumerEdits(old, next);
  const a = edits.find((e) => e.path === 'a.txt');
  const b = edits.find((e) => e.path === 'b.txt');
  assert.equal(a?.kind, 'conflict');
  assert.equal(a?.text, lines(9).replace('\n2\n', '\n2 # local\n'));
  assert.equal(b?.kind, 'merge');
  assert.equal(b?.text, `${lines(9)}local edit\n`);
});

test('a file the template left alone is edited once, and one the template did not write is added', () => {
  const old = tree({ 'a.txt': 'x\n', 'z.txt': 'y\n' });
  const edits = consumerEdits(old, old);
  assert.deepEqual(
    edits.map(({ path, kind, text }) => ({ path, kind, text })),
    [
      { path: 'a.txt', kind: 'untouched', text: 'x\nlocal edit\n' },
      { path: 'local/notes.md', kind: 'own', text: 'local notes\n' },
    ],
  );
});

test('the marker is edited in its body, and files that vanish, appear, or are not text are left alone', () => {
  const old = tree({ 'PLEXUS.md': 'prose\n', 'gone.txt': 'a\n', 'bin.dat': 'a\u0000b', 'c.txt': 'c\n' });
  const next = tree({ 'PLEXUS.md': 'other\n', 'new.txt': 'n\n', 'bin.dat': 'a\u0000c', 'c.txt': 'c\n' });
  const edits = consumerEdits(old, next);
  assert.deepEqual(
    edits.map(({ path, kind }) => [path, kind]),
    [
      ['PLEXUS.md', 'born-once'],
      ['c.txt', 'untouched'],
      ['local/notes.md', 'own'],
    ],
  );
  assert.equal(edits[0]?.text, 'prose\nlocal prose\n');
});

test('a marker with no body gets its prose as the first line', () => {
  const edits = consumerEdits(tree({ 'PLEXUS.md': '' }), tree({ 'PLEXUS.md': '' }));
  assert.equal(edits.find((e) => e.path === 'PLEXUS.md')?.text, 'local prose\n');
});

test('cloning the template repos fails loudly, naming the repo and where it was looked for', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parity-clone-'));
  try {
    await assert.rejects(
      cloneTemplateRepos(join(dir, 'nowhere'), join(dir, 'into'), process.env),
      /template-repo-turbo.*nowhere/s,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cloning the template repos from a base gives each repo with its tags', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parity-clone-'));
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    for (const repo of ['template-repo-turbo', 'template-repo-operations', 'template-app-nextjs']) {
      const at = join(dir, 'base', repo);
      mkdirSync(at, { recursive: true });
      writeFileSync(join(at, 'f'), 'x');
      const git = (...args: string[]) => execFileSync('git', ['-C', at, ...args], { env, stdio: 'ignore' });
      git('init', '-q', '-b', 'main');
      git('add', '.');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'one');
      git('tag', '1.0.0');
    }
    const repos = await cloneTemplateRepos(join(dir, 'base'), join(dir, 'into'), env);
    assert.deepEqual(Object.keys(repos).sort(), ['app-nextjs', 'repo-operations', 'repo-turbo']);
    const tags = execFileSync('git', ['-C', repos['repo-turbo'], 'tag'], { env, encoding: 'utf8' });
    assert.equal(tags.trim(), '1.0.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bytes are compared exactly: a missing final newline is a difference', () => {
  assert.deepEqual(diffTrees(tree({ 'a.txt': 'x' }), tree({ 'a.txt': 'x\n' })), [
    'a.txt: bytes differ, at the end: copier 1 bytes, the engine 2 bytes',
  ]);
  assert.deepEqual(diffTrees(tree({ 'a.txt': 'x\r\n' }), tree({ 'a.txt': 'x\n' })), [
    'a.txt: bytes differ, first at line 1: copier "x\\r", the engine "x"',
  ]);
});

test('a copier template file named .gitignore is carried as .gitignore.jinja, and no other', () => {
  assert.equal(portedPath('.gitignore'), '.gitignore.jinja');
  assert.equal(portedPath('apps/web/.gitignore'), 'apps/web/.gitignore.jinja');
  assert.equal(portedPath('foo.gitignore'), 'foo.gitignore');
  assert.equal(portedPath('.gitignore.jinja'), '.gitignore.jinja');
});

test("a tree's text files lose their side's conflict labels, and other files are as they were", () => {
  const binary = { bytes: Uint8Array.of(0xff, 0xfe), mode: REGULAR | 0o644 };
  const unified = unifyTree(
    new Map([...tree({ 'a.txt': '<<<<<<< current\n', 'b.txt': '<<<<<<< before updating\n' }), ['bin', binary]]),
    'engine',
  );
  assert.equal(dec(unified.get('a.txt')?.bytes ?? new Uint8Array()), '<<<<<<<\n');
  assert.equal(dec(unified.get('b.txt')?.bytes ?? new Uint8Array()), '<<<<<<< before updating\n');
  assert.equal(unified.get('bin'), binary);
});

test("the ring's git sees no setting of the machine's own, however the machine sets it", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parity-env-'));
  const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_DIR'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    const ring = join(dir, 'ring');
    const user = join(dir, 'user');
    writeFileSync(ring, GIT_CONFIG);
    writeFileSync(user, '[merge]\n\tconflictStyle = zdiff3\n[core]\n\texcludesFile = /nonexistent\n');
    Object.assign(process.env, {
      GIT_CONFIG_GLOBAL: user,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'merge.conflictStyle',
      GIT_CONFIG_VALUE_0: 'diff3',
      GIT_DIR: join(dir, 'nowhere'),
    });
    const env = isolatedEnv(ring);
    assert.deepEqual(
      Object.keys(env)
        .filter((name) => name.startsWith('GIT_'))
        .sort(),
      ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT'],
    );
    const get = (key: string) => run('git', ['config', '--get', key], env, dir).catch(() => '');
    assert.equal(await get('merge.conflictStyle'), '');
    assert.equal((await get('core.excludesFile')).trim(), '/dev/null');
    assert.equal((await get('core.attributesFile')).trim(), '/dev/null');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const manifest = `_exclude:
  - "{% if _copier_operation == 'update' %}PLEXUS.md{% endif %}"
  - "{% if _copier_operation == 'update' %}src/a.ts{% endif %}"
_skip_if_exists:
  - src/a.ts
  - PLEXUS.md
_tasks:
  - command: "git init"
    when: "{{ _copier_operation == 'copy' }}"
  - "mise install"
  - command: "only on update"
    when: "{{ _copier_operation == 'update' }}"
  - command: "mise exec -- npx corepack use pnpm@12"
    when: "{{ _copier_operation == 'copy' }}"
other: x
`;

test("copier's manifest gives what a copy runs, and the files it skips or leaves out on an update", () => {
  assert.deepEqual(copierManifest(manifest), {
    skipIfExists: ['PLEXUS.md', 'src/a.ts'],
    excludedOnUpdate: ['PLEXUS.md', 'src/a.ts'],
    birth: [
      ['git', 'init'],
      ['mise', 'install'],
      ['mise', 'exec', '--', 'npx', 'corepack', 'use', 'pnpm@12'],
    ],
  });
});

test("copier's manifest without those keys has none of them", () => {
  assert.deepEqual(copierManifest('other: x\n'), { skipIfExists: [], excludedOnUpdate: [], birth: [] });
});

test("copier's manifest in a form the mapping does not know is an error, not a guess", () => {
  const tasks = (task: string) => `_tasks:\n  - ${task}\n`;
  assert.throws(() => copierManifest(`_exclude:\n  - "docs"\n`), /_exclude/);
  assert.throws(() => copierManifest(tasks('{command: "a", when: "{{ x }}"}')), /when/);
  assert.throws(() => copierManifest(tasks('"echo \'a b\'"')), /quot/);
  assert.throws(() => copierManifest('- a\n'), /mapping/);
});
