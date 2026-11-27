// merge: three rendered trees into one, the current directory's with the
// template's changes applied (types.ts states the shapes). A path both renders
// hold alike is left alone; the others are not merged yet.
import type { Entry, MergeEntry, MergeFile, MergeInput, MergeResult } from './types.ts';

/** The current tree with the changes from the old render to the new one merged in, and a report per touched path. */
export async function merge(input: MergeInput, mergeFile: MergeFile): Promise<MergeResult> {
  const { old, new: next, current } = input;
  const tree = new Map(current);
  const report: MergeEntry[] = [];
  for (const path of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const o = old.get(path);
    const n = next.get(path);
    const c = tree.get(path);
    if (same(o, n)) continue;
    if (n !== undefined && (same(c, o) || same(c, n))) {
      tree.set(path, n);
      report.push({ path, outcome: 'clean' });
      continue;
    }
    if (o !== undefined && n !== undefined && c !== undefined) {
      const merged = await mergeFile({ path, old: o.bytes, new: n.bytes, current: c.bytes });
      tree.set(path, { bytes: merged.bytes, mode: n.mode });
      report.push({ path, outcome: merged.conflicted ? 'conflicted' : 'clean' });
      continue;
    }
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
