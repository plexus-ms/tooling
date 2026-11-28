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
// is any file no render names. This answers as a whole read would where the
// filesystem tells names apart exactly. On a case-insensitive or normalising
// one, the default on macOS, `lstat('A')` finds `a`: the partial read then
// reports what the writes will meet, which is the safer answer, and differs
// from a whole read.
//
// Writing. `applyChanges` makes a directory hold what the core decided, for the
// paths it is given, an entry to write or nothing to delete, and touches
// nothing else. It never writes or deletes through a symlink: a path whose
// directory above it is a symlink or a file, or that is itself a symlink, is
// skipped. The core answers `kept` where a directory above a path is a
// symlink or the path is one (rules 1 and 4 of merge.ts), but it still reports
// such a path, and a reported path that the merged tree lacks reaches this as a
// deletion. These guards are what keeps a `kept` or `conflicted` path
// untouched. A file is written only where its bytes differ from what is there.
// A file that exists keeps its permissions but for its executable bits, which
// follow the entry's, and never widen beyond that: where the entry is
// executable, a mode gains the owner's execute bit and the group's and others'
// only where they may read (0o600 becomes 0o700, 0o644 becomes 0o755); where it
// is not, all three are cleared. A new file or directory takes the entry's
// mode under the process's umask. A failure stops the run with the path that
// failed and the note that the paths before it, in the order given, were
// already applied.
//
// A deletion removes a file, and then the directories it leaves empty, upward
// from it and no further than the directory itself: copier removes directories
// that end empty, and `merge` never deletes one. A directory that was empty
// before, or the render still holds as an empty directory (`keep`), stays.
//
// What a caller of the library uses, beside `readTree`: `readManifest` reads
// the manifest of a template directory, and `readTemplateDirectory` that
// manifest with the tree `render` takes, both throwing one error that lists
// every problem of the manifest. `readRender` reads a render directory that
// `plx-template render` wrote, with the policies file beside it (cli.ts says
// how the two travel), into the side `planMerge` takes, so that a caller can
// merge a render another version of the command made; each way the directory
// or its policies file is wrong is an input error naming the path, the first
// symlink in the render among them. `planMerge` reads what `merge` looks at in a
// directory, merges two renders given as trees with their policies, and
// returns the report with `apply`, which makes the directory hold the result.
// Nothing is written before `apply`, so a caller can show the report first; the
// merge of the command `plx-template merge` is the same plan applied at once.
import { chmod, lstat, mkdir, readdir, readFile, readlink, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { InputError, messageOf } from './errors.ts';
import { gitMergeFile } from './git-merge-file.ts';
import { readTemplate } from './manifest.ts';
import { merge } from './merge.ts';
import {
  DIRECTORY,
  type Entry,
  isExecutable,
  type Manifest,
  type MergeEntry,
  MODE_TYPE,
  type Policies,
  type Policy,
  REGULAR,
  type RenderError,
  SYMLINK,
  type Tree,
} from './types.ts';

/** An entry for a directory that holds nothing. */
const EMPTY_DIRECTORY: Entry = { bytes: new Uint8Array(), mode: DIRECTORY | 0o755 };

const SYMLINK_ARGUMENT = 'is a symlink, which is not followed: name the directory itself';

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
export async function requireDirectory(path: string): Promise<void> {
  const st = await stat(path);
  if (st === undefined) throw new InputError('there is no such directory', path);
  if (st.isSymbolicLink()) throw new InputError(SYMLINK_ARGUMENT, path);
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
    tree.set(prefix, EMPTY_DIRECTORY);
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
    tree.set(at, EMPTY_DIRECTORY);
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
    try {
      if (entry === undefined) await remove(root, path, keep);
      else await write(root, path, entry);
    } catch (error) {
      throw new Error(`${path}: ${messageOf(error)}; the paths before it in path order were already applied`);
    }
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
  if (st.isSymbolicLink()) throw new InputError(SYMLINK_ARGUMENT, path);
  if (!st.isDirectory()) throw new InputError('exists and is not a directory', path);
  if ((await readdir(path)).length > 0) throw new InputError('is not empty', path);
}

/** A template directory read: its manifest, and its tree for `render`. */
export interface TemplateDirectory {
  readonly manifest: Manifest;
  readonly tree: Tree;
}

/** The template directory `root`, read once; the error lists every problem that keeps its manifest from being read. */
export async function readTemplateDirectory(root: string): Promise<TemplateDirectory> {
  const errors: RenderError[] = [];
  const tree = await readTree(root);
  const template = readTemplate(tree, 1, errors);
  if (template === undefined) {
    const lines = errors.map((e) => `${e.path ?? root}: ${e.message}${e.question ? ` (question ${e.question})` : ''}`);
    throw new Error(`${root} is no template:\n${lines.join('\n')}`);
  }
  return { manifest: template.manifest, tree };
}

/** The manifest of the template directory `root`; the error is `readTemplateDirectory`'s. */
export async function readManifest(root: string): Promise<Manifest> {
  return (await readTemplateDirectory(root)).manifest;
}

/** One side of a merge: a render's tree, and the policies of its paths. */
export interface RenderedSide {
  readonly tree: Tree;
  readonly policies: Policies;
}

/** Where `render` writes the policies of the render in `dir`: beside it, so that no file of the render is one it did not render. */
export const policiesOf = (dir: string): string => `${resolve(dir)}.plx-template.json`;

/** The version of the policies file `render` writes and `readRender` reads. */
export const POLICIES_VERSION = 1;

const POLICIES: readonly string[] = ['merge', 'born-once'] satisfies Policy[];

/** Whether `value` is a JSON object: not null, not a list. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON of `path`, read by `read`; what goes wrong is an input error about `what`, with `hint` after a failed read. */
export async function readJson(read: () => Promise<string>, path: string, what: string, hint = ''): Promise<unknown> {
  let text: string;
  try {
    text = await read();
  } catch (error) {
    throw new InputError(`cannot read the ${what}: ${messageOf(error)}${hint}`, path);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InputError(`the ${what} is no JSON: ${messageOf(error)}`, path);
  }
}

/** The policies `render` wrote beside the render in `dir`, which holds `tree`; each way it can be wrong is an input error. */
async function readPolicies(dir: string, tree: Tree): Promise<Policies> {
  const file = policiesOf(dir);
  const fail = (what: string): never => {
    throw new InputError(`the policies file ${what}`, file);
  };
  const parsed = await readJson(
    () => readFile(file, 'utf8'),
    file,
    'policies file',
    '; `render` writes one beside the render it writes',
  );
  if (!isObject(parsed)) return fail('is not a JSON object with a version and files');
  if (parsed.version === undefined) return fail('has no version');
  if (parsed.version !== POLICIES_VERSION)
    return fail(
      `is version ${String(parsed.version)}, and this plx-template reads version ${POLICIES_VERSION} only; was it written by a later plx-template?`,
    );
  if (!isObject(parsed.files)) return fail('has no files: a map of path to { template, policy }');
  const files = Object.entries(parsed.files);
  const bad = files.filter(([, v]) => !isObject(v) || !POLICIES.includes(v.policy as string)).map(([path]) => path);
  if (bad.length > 0) return fail(`gives no policy, merge or born-once, to ${bad.join(', ')}`);
  const lacking = [...tree.keys()].filter((path) => !(path in (parsed.files as object)));
  if (lacking.length > 0) return fail(`lacks ${lacking.join(', ')}, which its render holds`);
  const extra = files.map(([path]) => path).filter((path) => !tree.has(path));
  if (extra.length > 0) return fail(`names ${extra.join(', ')}, which its render does not hold`);
  return new Map(files as [string, { policy: Policy }][]);
}

/** The render directory `dir` as a side of a merge, with the policies file beside it, as the header says. */
export async function readRender(dir: string): Promise<RenderedSide> {
  const tree = await readTree(dir);
  const links = [...tree].filter(([, e]) => (e.mode & MODE_TYPE) === SYMLINK).map(([path]) => join(dir, path));
  const [link, ...more] = links;
  if (link !== undefined)
    throw new InputError(
      `is a symlink, and a render holds none${more.length > 0 ? ` (nor ${more.join(', ')})` : ''}`,
      link,
    );
  return { tree, policies: await readPolicies(dir, tree) };
}

/** A merge decided, not yet applied. */
export interface MergePlan {
  readonly report: readonly MergeEntry[];
  /** Makes the directory hold the merge; touches only the paths of the report. */
  apply(): Promise<void>;
}

/** The merge of `old` and `next` into the directory `target`, as the header says. */
export async function planMerge(target: string, old: RenderedSide, next: RenderedSide): Promise<MergePlan> {
  const current = await readCurrent(target, new Set([...old.tree.keys(), ...next.tree.keys()]));
  const { tree, report } = await merge(
    { old: old.tree, new: next.tree, current, files: { old: old.policies, new: next.policies } },
    gitMergeFile,
  );
  const changes = new Map<string, Entry | undefined>();
  for (const { path, outcome } of report) {
    if (outcome === 'deleted') changes.set(path, undefined);
    else changes.set(path, tree.get(path));
  }
  const directories = new Set(
    [...next.tree].filter(([, e]) => (e.mode & MODE_TYPE) === DIRECTORY).map(([path]) => path),
  );
  return { report, apply: () => applyChanges(target, changes, directories) };
}
