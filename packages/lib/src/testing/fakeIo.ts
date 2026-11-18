// A test Io over an in-memory tree: files map to their text, directories to
// nested trees; `git` answers exec calls. Two kinds of entry stand for what a
// tree of text cannot hold: UNREADABLE, a directory whose entries cannot be
// read (EACCES), and `link(target)`, a symbolic link that reads as its
// target. A missing path fails with ENOENT. Not shipped (excluded in tsconfig).
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ExecError, type Io } from '../io.ts';

export type Tree = { [name: string]: string | Tree };

/** A directory whose entries cannot be read. */
export const UNREADABLE = '\0unreadable';
const LINK = '\0link:';
/** A symbolic link to an absolute path of the tree. */
export const link = (target: string): string => `${LINK}${target}`;

const failure = (code: string, path: string) => Object.assign(new Error(`${code}: ${path}`), { code });

export type FakeExec = (cwd: string, args: string[], input?: string) => string | undefined;

/** `git` answers git calls; `other` answers any other command, by name. */
export function fakeIo(tree: Tree, git: FakeExec = () => undefined, other: Record<string, FakeExec> = {}): Io {
  const at = (path: string): Tree | string | undefined =>
    path
      .split('/')
      .filter((p) => p && p !== '.')
      .reduce<Tree | string | undefined>((node, p) => {
        const next = typeof node === 'object' ? node[p] : undefined;
        return typeof next === 'string' && next.startsWith(LINK) ? at(next.slice(LINK.length)) : next;
      }, tree);
  return {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exec: async (command, args, options) => {
      const handler = command === 'git' ? git : other[command];
      assert.ok(handler, `fake io: no handler for ${command}`);
      const out = handler(options?.cwd ?? '', args, options?.input);
      if (out === undefined)
        throw new ExecError(`${command} ${args.join(' ')}`, 1, `fake ${command} fails in ${options?.cwd}`);
      return out;
    },
    readFile: async (path) => {
      const node = at(path);
      if (node === UNREADABLE) throw failure('EACCES', path);
      if (typeof node !== 'string') throw failure(node === undefined ? 'ENOENT' : 'EISDIR', path);
      return node;
    },
    writeFile: async () => {},
    readDir: async (path) => {
      const node = at(path);
      if (node === UNREADABLE) throw failure('EACCES', path);
      if (typeof node !== 'object') throw failure(node === undefined ? 'ENOENT' : 'ENOTDIR', path);
      return Object.entries(node).map(([name, v]) =>
        typeof v === 'string' && v.startsWith(LINK)
          ? { name, directory: false, symlink: true }
          : { name, directory: typeof v === 'object' || v === UNREADABLE },
      );
    },
  };
}
