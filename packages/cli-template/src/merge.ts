// merge: three rendered trees into one, the current directory's with the
// template's changes applied (types.ts states the shapes). A path both renders
// hold alike is left alone; the others are not merged yet.
import type { Entry, MergeEntry, MergeFile, MergeInput, MergeResult } from './types.ts';

/** The current tree with the changes from the old render to the new one merged in, and a report per touched path. */
export async function merge(input: MergeInput, _mergeFile: MergeFile): Promise<MergeResult> {
  const { old, new: next, current } = input;
  const tree = new Map(current);
  const report: MergeEntry[] = [];
  for (const path of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    if (same(old.get(path), next.get(path))) continue;
    throw new Error(`merge: ${path} changed, which is not merged yet`);
  }
  return { tree, report };
}

/** Whether two entries, either absent, are alike. */
function same(a: Entry | undefined, b: Entry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return equal(a.bytes, b.bytes);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
