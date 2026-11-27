// The built plx, run as a process: the bundle has to start and has to apply, so
// that a dependency left out of it (the engine loads a wasm file by a path of
// its own) is found by `verify` and not by the first user. The bundle is built
// into a scratch directory, never into the package's own dist, which another
// build may be writing at the same time; the scratch directory sees the
// package's node_modules, where the bundle finds the engine as an installed
// plx does.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { version } from './program.ts';

const PACKAGE = join(import.meta.dirname, '..');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'plx-bundle-')));
const PLX = join(dir, 'built', 'dist', 'plx.js');
before(() => {
  mkdirSync(join(dir, 'built'));
  copyFileSync(join(PACKAGE, 'package.json'), join(dir, 'built', 'package.json'));
  symlinkSync(join(PACKAGE, 'node_modules'), join(dir, 'built', 'node_modules'));
  execFileSync(process.execPath, ['build.js', join(dir, 'built', 'dist')], { cwd: PACKAGE });
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('the built plx starts', () => {
  const run = spawnSync(process.execPath, [PLX, '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /apply/);
});

test('the built plx applies a changed marker with the engine', () => {
  const put = (root: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  };
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false', ...args],
      {
        cwd: join(dir, 'repo'),
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
        stdio: 'pipe',
      },
    );
  put(join(dir, 'templates', 'basket'), {
    'template.yml': 'name: basket\nquestions:\n  fruit:\n    type: str\n',
    'files/list.txt.jinja': '{{ fruit }}\n',
  });
  const marker = (fruit: string) => `---\nversion: ${version}\ntemplates: [basket]\nfruit: ${fruit}\n---\n`;
  mkdirSync(join(dir, 'repo'));
  git('init', '-q', '-b', 'main');
  put(join(dir, 'repo'), { 'PLEXUS.md': marker('apple'), 'list.txt': 'apple\n' });
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  put(join(dir, 'repo'), { 'PLEXUS.md': marker('pear') });
  const run = spawnSync(
    process.execPath,
    [PLX, '-y', 'apply', '--templates', join(dir, 'templates'), join(dir, 'repo')],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(join(dir, 'repo', 'list.txt'), 'utf8'), 'pear\n');
});
