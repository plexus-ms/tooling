// merge: three rendered trees into one, the current directory's with the
// template's changes applied (types.ts states the shapes). Not written yet:
// it fails on every call.
import type { MergeFile, MergeInput, MergeResult } from './types.ts';

/** The current tree with the changes from the old render to the new one merged in, and a report per touched path. */
export async function merge(_input: MergeInput, _mergeFile: MergeFile): Promise<MergeResult> {
  throw new Error('merge is not implemented yet');
}
