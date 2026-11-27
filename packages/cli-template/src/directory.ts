// Directories and trees: the one place that reads a directory into a tree and
// the one that writes a tree to a directory. The core works on trees in memory
// (types.ts); this is the filesystem side of it, for the command in cli.ts.
//
// Reading. A directory is walked with `lstat`, and a symlink is never followed:
// it is an entry whose bytes are its target and whose mode says it is a
// symlink, which the core treats as it must (a template holding one is an
// error, `merge` never writes through one). A directory that holds nothing is
// a DIRECTORY entry; one that holds entries is implied by their paths. Any
// other kind of file, a socket or a pipe, is an input error.
//
// `readTree` reads a whole directory, which is what a template and a render
// are. The directory `merge` merges into is read by `readCurrent` instead, and
// only as far as `merge` looks (merge.ts): for each path of the two renders,
//   - each directory above it that is a symlink or a file, as an entry, and
//     the walk stops there, since nothing below it is reachable
//   - the path itself where it is a file or a symlink
//   - where it is a directory, one entry below it, the first leaf in name
//     order, so that "current holds entries below the path" is answered, or the
//     empty directory itself as a DIRECTORY entry
// so that a repository's `.git` and `node_modules` are never read, and neither
// is any file no render names.
//
// Writing. `applyChanges` makes a directory hold what the core decided, for the
// paths it is given, an entry to write or nothing to delete, and touches
// nothing else. It never writes or deletes through a symlink: a path whose
// directory above it is a symlink or a file, or that is itself a symlink, is
// skipped. A file is written only where its bytes differ from what is there. A
// file that exists keeps its permissions but for its executable bits, which
// follow the entry's, and never widen beyond that: where the entry is
// executable, a mode gains the owner's execute bit and the group's and others'
// only where they may read (0o600 becomes 0o700, 0o644 becomes 0o755); where it
// is not, all three are cleared. A new file or directory takes the entry's
// mode under the process's umask.
//
// A deletion removes a file, and then the directories it leaves empty, upward
// from it and no further than the directory itself: copier removes directories
// that end empty, and `merge` never deletes one. A directory that was empty
// before, or the render still holds as an empty directory (`keep`), stays.
import { chmod, lstat, mkdir, readdir, readFile, readlink, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InputError } from './errors.ts';
import { DIRECTORY, type Entry, isExecutable, MODE_TYPE, REGULAR, SYMLINK, type Tree } from './types.ts';

const EMPTY = new Uint8Array();

/** The permission bits a file's mode holds. */
const PERMISSIONS = 0o7777;

/** `lstat` of `path`, nothing where there is nothing there or something above it is no directory. */
async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** The entry at `path`, a directory's as `undefined`. */
async function leaf(path: string, mode: number): Promise<Entry | undefined> {
  const type = mode & MODE_TYPE;
  if (type === SYMLINK) return { bytes: Buffer.from(await readlink(path)), mode };
  if (type === REGULAR) return { bytes: new Uint8Array(await readFile(path)), mode };
  if (type === DIRECTORY) return undefined;
  throw new InputError('neither a file, a symlink nor a directory', path);
}

/** Whether `path` is a directory, an input error where it is not. */
async function requireDirectory(path: string): Promise<void> {
  const st = await stat(path);
  if (st === undefined) throw new InputError('there is no such directory', path);
  if (!st.isDirectory()) throw new InputError('not a directory', path);
}

/** The tree of the directory `root`. */
export async function readTree(root: string): Promise<Tree> {
  await requireDirectory(root);
  const tree = new Map<string, Entry>();
  await walk(root, '', tree);
  return tree;
}

async function walk(root: string, prefix: string, tree: Map<string, Entry>): Promise<void> {
  const names = (await readdir(join(root, prefix))).sort();
  if (names.length === 0 && prefix !== '') {
    tree.set(prefix, { bytes: EMPTY, mode: DIRECTORY | 0o755 });
    return;
  }
  for (const name of names) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const st = await lstat(join(root, path));
    const entry = await leaf(join(root, path), st.mode);
    if (entry === undefined) await walk(root, path, tree);
    else tree.set(path, entry);
  }
}

/** The part of the directory `root` that `merge` looks at for `paths`, as the header says. */
export async function readCurrent(root: string, paths: Iterable<string>): Promise<Tree> {
  await requireDirectory(root);
  const tree = new Map<string, Entry>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const at = parts.slice(0, i).join('/');
      const st = await stat(join(root, at));
      if (st === undefined) break;
      const entry = await leaf(join(root, at), st.mode);
      if (entry !== undefined) {
        tree.set(at, entry);
        break;
      }
      if (i === parts.length) await firstLeaf(root, at, tree);
    }
  }
  return tree;
}

/** The first leaf below the directory `at`, in name order; the directory itself where it holds nothing. */
async function firstLeaf(root: string, at: string, tree: Map<string, Entry>): Promise<void> {
  const [name] = (await readdir(join(root, at))).sort();
  if (name === undefined) {
    tree.set(at, { bytes: EMPTY, mode: DIRECTORY | 0o755 });
    return;
  }
  const path = `${at}/${name}`;
  const st = await lstat(join(root, path));
  const entry = await leaf(join(root, path), st.mode);
  if (entry === undefined) await firstLeaf(root, path, tree);
  else tree.set(path, entry);
}

/** Whether every directory above `path` is a directory or missing, creating the missing ones where `create`. */
async function parentsOpen(root: string, path: string, create: boolean): Promise<boolean> {
  const parts = path.split('/').slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const dir = join(root, ...parts.slice(0, i));
    const st = await stat(dir);
    if (st === undefined) {
      if (!create) return true;
      await mkdir(dir);
    } else if (!st.isDirectory()) return false;
  }
  return true;
}

/** The mode a file of `mode` takes when its executable bits follow `executable`, nothing else moving. */
function withExecutable(mode: number, executable: boolean): number {
  const bits = mode & PERMISSIONS;
  if (!executable) return bits & ~0o111;
  return bits | 0o100 | (bits & 0o040 ? 0o010 : 0) | (bits & 0o004 ? 0o001 : 0);
}

/**
 * Makes `root` hold, at each path of `changes`, its entry, or nothing where it
 * is `undefined`; the header says how. `keep` holds the paths of directories
 * not to remove after a deletion.
 */
export async function applyChanges(
  root: string,
  changes: ReadonlyMap<string, Entry | undefined>,
  keep: ReadonlySet<string> = new Set(),
): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const [path, entry] of changes) {
    if (entry === undefined) await remove(root, path, keep);
    else await write(root, path, entry);
  }
}

async function write(root: string, path: string, entry: Entry): Promise<void> {
  if (!(await parentsOpen(root, path, true))) return;
  const file = join(root, path);
  const st = await stat(file);
  const directory = (entry.mode & MODE_TYPE) === DIRECTORY;
  if (st === undefined) {
    if (directory) await mkdir(file);
    else await writeFile(file, entry.bytes, { mode: entry.mode & PERMISSIONS });
    return;
  }
  if (!st.isFile() || directory) return;
  if (!Buffer.from(entry.bytes).equals(await readFile(file))) await writeFile(file, entry.bytes);
  if (isExecutable(st.mode) !== isExecutable(entry.mode))
    await chmod(file, withExecutable(st.mode, isExecutable(entry.mode)));
}

async function remove(root: string, path: string, keep: ReadonlySet<string>): Promise<void> {
  if (!(await parentsOpen(root, path, false))) return;
  const st = await stat(join(root, path));
  if (st === undefined || !st.isFile()) return;
  await unlink(join(root, path));
  const parts = path.split('/').slice(0, -1);
  for (let i = parts.length; i > 0; i--) {
    const dir = parts.slice(0, i).join('/');
    if (keep.has(dir) || (await readdir(join(root, dir))).length > 0) return;
    await rmdir(join(root, dir));
  }
}

/** Whether `path` can take a render: missing, or a directory that holds nothing; an input error otherwise. */
export async function requireEmpty(path: string): Promise<void> {
  const st = await stat(path);
  if (st === undefined) return;
  if (!st.isDirectory()) throw new InputError('exists and is not a directory', path);
  if ((await readdir(path)).length > 0) throw new InputError('is not empty', path);
}
