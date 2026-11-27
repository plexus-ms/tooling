// merge: three rendered trees into one, the current directory's with the
// template's changes applied (types.ts states the shapes).
import {
  type Entry,
  type MergeEntry,
  type MergeFile,
  type MergeInput,
  type MergeResult,
  type Outcome,
  REGULAR,
} from './types.ts';

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
  const c = tree.get(path);
  if (c === undefined && n !== undefined && (bornOnce || o === undefined)) {
    tree.set(path, n);
    return 'added';
  }
  if (same(o, n)) return undefined;
  if (bornOnce || c === undefined) return 'kept';
  if (n === undefined) {
    if (!same(c, o)) return 'conflicted';
    tree.delete(path);
    return 'deleted';
  }
  const base = o ?? EMPTY;
  if (same(c, base) || same(c, n)) {
    tree.set(path, n);
    return 'clean';
  }
  const merged = await mergeFile({ path, old: base.bytes, new: n.bytes, current: c.bytes });
  tree.set(path, { bytes: merged.bytes, mode: n.mode });
  return merged.conflicted ? 'conflicted' : 'clean';
}

/** Whether two entries, either absent, are alike. */
function same(a: Entry | undefined, b: Entry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return equal(a.bytes, b.bytes);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
