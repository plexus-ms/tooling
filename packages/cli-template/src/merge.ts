// merge: three rendered trees into one, the current directory's with the
// template's changes applied (types.ts states the shapes). It looks at each
// path that either render holds, in path order, with its policy from the new
// render (from the old one where only the old has it), and the first rule that
// fits decides; "current" is what the current tree holds at the path, a
// directory where it holds entries below it:
//
//   1. current holds nothing there, the new render does, and the path is
//      born-once or new to the template: written, `added`; but `kept` where a
//      directory it lies in is a symlink in the current tree, and
//      `conflicted` where one is a file
//   2. the old and the new render hold it alike: left alone
//   3. current is a symlink: `kept`, never written, deleted or written through
//   4. a file on one side, a directory on another: current stays, `conflicted`
//   5. an empty directory otherwise: left alone; merge never deletes one
//   6. born-once, or current lacks it: `kept`. A born-once path is never
//      touched once it exists, nor deleted when the template drops it or its
//      name no longer renders; a path the user deleted stays deleted
//   7. the new render lacks it: `deleted` where current is the old render's
//      entry, else current stays, `conflicted`. A template that renames a file
//      drops one path and adds another, so the user's edits to the old name
//      survive this way
//   8. otherwise both are files and the two changes are merged: the content
//      and the executable bit apart
//
// Alike means the same type and bytes, and for a file the same executable bit,
// the one bit of a mode the engine carries (types.ts); a change of the bit
// alone is a change. Bytes are compared and carried as they are, line endings
// included.
//
// The content: where current is the old or the new render's, the new render's
// wins; where only the user changed it, current's stays; where all three differ
// it goes to the injected `MergeFile`, which says whether the result holds a
// conflict, its markers left in the file. An old render that lacks the path is
// an empty, non-executable file, so a path both sides add is merged against
// empty content. Where all three differ and one side is binary, current stays,
// `conflicted`, and `MergeFile` is not called. Binary is git's rule, since git
// merges the rest and fails on a binary file: a NUL byte among the first 8000.
//
// The executable bit is merged as the content is, but cannot conflict: where
// the template changed it the new render's wins, else current's stays. So a
// change of the bit on one side combines with a change of the content on the
// other. A written file takes a render's mode, 0o100644 or 0o100755 by the
// merged bit; where nothing changes the bit, that is the new render's.
//
// The report holds one entry, in path order, for each path the template
// changed, the old and the new render holding it differently, and for each
// path rule 1 writes; a path the template left alone is not reported, whatever
// the current tree holds there, and neither is an empty directory merge does
// not add. A path that neither render holds is the user's: untouched and
// unreported. The tree no longer implies a directory whose files were all
// deleted; whether such a directory is removed is for whoever applies the tree.
//
// Two rules are ported from copier v9.19.1, copier/_main.py: comparing a file's
// mode by its executable bits (`_render_allowed`, here the owner's bit alone), and
// never deleting through a symlink (`_remove_old_files`); MIT-licensed, see
// LICENSE.copier. Copier's update algorithm is not: it replays a diff, this
// merges trees.
import {
  DIRECTORY,
  type Entry,
  fileMode,
  isExecutable,
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

/** What the current tree holds at a path that has entries below it and none of its own. */
const HOLDS: Entry = { bytes: new Uint8Array(), mode: DIRECTORY };

/** The old side of a path the old render lacks. */
const EMPTY: Entry = { bytes: new Uint8Array(), mode: fileMode(false) };

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
  old: Entry | undefined,
  next: Entry | undefined,
  bornOnce: boolean,
  tree: Map<string, Entry>,
  mergeFile: MergeFile,
): Promise<Outcome | undefined> {
  const current = at(tree, path);
  // The rules of the header, by number.
  // 1
  if (current === undefined && next !== undefined && (bornOnce || old === undefined)) {
    const blocking = ancestors(path)
      .map((a) => tree.get(a))
      .find((entry) => entry !== undefined && kind(entry) !== DIRECTORY);
    if (blocking !== undefined) return kind(blocking) === SYMLINK ? 'kept' : 'conflicted';
    tree.set(path, next);
    return 'added';
  }
  if (same(old, next)) return undefined; // 2
  if (kind(current) === SYMLINK) return 'kept'; // 3
  if (bornOnce) return 'kept';
  const kinds = [old, next, current].map(kind);
  if (kinds.includes(REGULAR) && kinds.includes(DIRECTORY)) return 'conflicted'; // 4
  if (kinds.includes(DIRECTORY)) return undefined; // 5
  if (current === undefined) return 'kept'; // 6
  // 7
  if (next === undefined) {
    if (!same(current, old)) return 'conflicted';
    tree.delete(path);
    return 'deleted';
  }
  // 8
  const base = old ?? EMPTY;
  const merged = await mergeContent(path, base.bytes, next.bytes, current.bytes, mergeFile);
  if (merged === undefined) return 'conflicted';
  const bit =
    isExecutable(base.mode) === isExecutable(next.mode) ? isExecutable(current.mode) : isExecutable(next.mode);
  tree.set(path, { bytes: merged.bytes, mode: fileMode(bit) });
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

/** An entry's type bits: REGULAR, DIRECTORY or SYMLINK. */
function kind(entry: Entry | undefined): number | undefined {
  return entry === undefined ? undefined : entry.mode & MODE_TYPE;
}

/** Whether git takes `bytes` as binary: a NUL byte among the first 8000, as its `buffer_is_binary` decides. */
function binary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/** Whether two entries, either absent, are alike. */
function same(a: Entry | undefined, b: Entry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (kind(a) !== kind(b) || !equal(a.bytes, b.bytes)) return false;
  return kind(a) !== REGULAR || isExecutable(a.mode) === isExecutable(b.mode);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
