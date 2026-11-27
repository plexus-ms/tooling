// Scratch repos and fixture templates for the tests of the verbs that render
// sites: real git, because what is tracked and what HEAD holds are git's, and
// template directories written as the engine reads them. Not shipped
// (excluded in tsconfig). No file is named PLEXUS.md in this repository's
// tree: the markers of a fixture are written into a scratch directory.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Context, type Options, realIo } from '../index.ts';

export type Files = Record<string, string>;

/** A scratch directory that holds the repos and template roots of one test file; `remove` deletes it. */
export function scratchDir(name: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `plx-${name}-`)));
  let count = 0;
  return {
    dir,
    /** A path of a new, unused name below the directory. */
    fresh: (label: string) => join(dir, `${label}-${count++}`),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** git in a scratch repo, with no configuration of the machine's and no hooks. */
export const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdio: 'pipe',
  }).toString();

export const write = (root: string, files: Files): void => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

export const text = (root: string, path: string): string => readFileSync(join(root, path), 'utf8');

/** A repo at `path` with `files` committed. */
export function repoWith(path: string, files: Files): string {
  mkdirSync(path);
  git(path, 'init', '-q', '-b', 'main');
  write(path, files);
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'init');
  return path;
}

/** A root of templates at `path`: each template's manifest and its files below `files/`. */
export function templatesAt(path: string, templates: Record<string, { manifest: string; files?: Files }>): string {
  mkdirSync(path);
  for (const [name, { manifest, files = {} }] of Object.entries(templates)) {
    write(join(path, name), { 'template.yml': manifest });
    write(
      join(path, name, 'files'),
      Object.fromEntries(Object.entries(files).map(([file, content]) => [file, content])),
    );
  }
  return path;
}

/** A Context that performs everything, asks nothing, and keeps its narration out of the test's output. */
export function quietContext(options: Options = { yes: true }): Context {
  return new Context(options, { ...realIo(), stderr: new PassThrough() });
}
