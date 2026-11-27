// merge: three rendered trees into one, the current directory's with the
// template's changes applied (types.ts states the shapes).
import {
  DIRECTORY,
  type Entry,
  type MergedFile,
  type MergeEntry,
  type MergeFile,
  type MergeInput,
  type MergeResult,
  MODE_TYPE,
  type Outcome,
  REGULAR,
  SYMLINK,
  type Tree,
} from './types.ts';

/** The one bit of a file's mode the engine carries: executable by its owner, as git decides. */
const EXECUTABLE = 0o100;

/** What the current tree holds at a path that has entries below it and none of its own. */
const HOLDS: Entry = { bytes: new Uint8Array(), mode: DIRECTORY };

/** The old side of a path the old render lacks. */
const EMPTY: Entry = { bytes: new Uint8Array(), mode: REGULAR | 0o644 };

/** The current tree with the changes from the old render to the new one merged in, and a report per touched path. */
export async function merge(input: MergeInput, mergeFile: MergeFile): Promise<MergeResult> {
  const { old, new: next, current, files } = input;
  const tree = new Map(current);
  const report: MergeEntry[] = [];
  for (const path of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const bornOnce = (next.has(path) ? files.new : files.old).get(path)?.policy === 'born-once';
    const outcome = await mergePath(path, old.get(path), next.get(path), bornOnce, tree, mergeFile);
    if (outcome !== undefined) report.push({ path, outcome });
  }
  return { tree, report };
}

/** Merges the old and the new render's entry at `path` into `tree`, and says what happened; nothing when nothing did. */
async function mergePath(
  path: string,
  o: Entry | undefined,
  n: Entry | undefined,
  bornOnce: boolean,
  tree: Map<string, Entry>,
  mergeFile: MergeFile,
): Promise<Outcome | undefined> {
  const c = at(tree, path);
  if (c === undefined && n !== undefined && (bornOnce || o === undefined)) {
    if (ancestors(path).some((a) => isSymlink(tree.get(a)))) return 'kept';
    tree.set(path, n);
    return 'added';
  }
  if (same(o, n)) return undefined;
  if (isSymlink(c)) return 'kept';
  if (isDirectory(o) || isDirectory(n)) return undefined;
  if (bornOnce || c === undefined) return 'kept';
  if (n === undefined) {
    if (!same(c, o)) return 'conflicted';
    tree.delete(path);
    return 'deleted';
  }
  const base = o ?? EMPTY;
  const merged = await mergeContent(path, base.bytes, n.bytes, c.bytes, mergeFile);
  if (merged === undefined) return 'conflicted';
  const bit = executable(base) === executable(n) ? executable(c) : executable(n);
  tree.set(path, { bytes: merged.bytes, mode: REGULAR | (bit ? 0o755 : 0o644) });
  return merged.conflicted ? 'conflicted' : 'clean';
}

/** The three sides' content merged; nothing where all three differ and one is binary. */
async function mergeContent(
  path: string,
  old: Uint8Array,
  next: Uint8Array,
  current: Uint8Array,
  mergeFile: MergeFile,
): Promise<MergedFile | undefined> {
  if (equal(current, old) || equal(current, next)) return { bytes: next, conflicted: false };
  if (equal(next, old)) return { bytes: current, conflicted: false };
  if ([old, next, current].some(binary)) return undefined;
  return mergeFile({ path, old, new: next, current });
}

/** The entry at `path` in `tree`; a directory where entries lie below it. */
function at(tree: Tree, path: string): Entry | undefined {
  const entry = tree.get(path);
  if (entry !== undefined) return entry;
  const below = `${path}/`;
  for (const p of tree.keys()) if (p.startsWith(below)) return HOLDS;
  return undefined;
}

/** The paths of the directories `path` lies in, outermost first. */
function ancestors(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

function isSymlink(entry: Entry | undefined): boolean {
  return entry !== undefined && (entry.mode & MODE_TYPE) === SYMLINK;
}

function isDirectory(entry: Entry | undefined): boolean {
  return entry !== undefined && (entry.mode & MODE_TYPE) === DIRECTORY;
}

/** Whether git takes `bytes` as binary: a NUL byte among the first 8000, as its `buffer_is_binary` decides. */
function binary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

function executable(entry: Entry): boolean {
  return (entry.mode & EXECUTABLE) !== 0;
}

/** Whether two entries, either absent, are alike. */
function same(a: Entry | undefined, b: Entry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return equal(a.bytes, b.bytes) && executable(a) === executable(b);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
