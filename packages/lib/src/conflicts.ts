// conflicts: whether a text, or the tracked files of a repo, hold conflict
// markers. The one detector of plx, for every verb that asks: `doctor`
// reports a repo's files that hold one, a repo taking a version (take.ts)
// tells a conflicted site by it and lists the files in its pull request, and
// a later run tells by it whether that pull request still needs a hand
// (pull.ts).
//
// A marker is a line that opens (`<<<<<<<`) or closes (`>>>>>>>`) a
// conflict, followed by a space or the end of the line. The `=======` line
// between them is never one alone: it is also a Markdown setext heading.
//
// The files are found with `git grep`, which reads only what git tracks and
// can read a ref without a checkout; it only narrows the candidates, and the
// detector below decides each of them, read as git stores it (`cat-file`, no
// textconv). Nothing a user's git config colours reaches the parse.
import { join } from 'node:path';
import type { Context } from './context.ts';
import { orAbsent } from './io.ts';

/** A line that opens or closes a conflict; a carriage return before the line's end counts as its end. */
const MARKER = /^(?:<<<<<<<|>>>>>>>)(?: |\r?$)/m;

/** Whether the text holds a line that opens or closes a conflict. */
export const hasConflictMarkers = (text: string): boolean => MARKER.test(text);

/** Whether `git status --porcelain` output shows unmerged entries. */
export const hasUnmergedEntries = (porcelain: string): boolean => /^(UU|AA|DU|UD)/m.test(porcelain);

/**
 * The tracked files of the repo at `dir` that hold conflict markers, relative
 * to it, sorted: as the working tree has them, or, given a `ref`, as that
 * commit has them, which needs no checkout of it.
 */
export async function filesWithConflictMarkers(ctx: Context, dir: string, ref?: string): Promise<string[]> {
  // --no-color: under color.grep=always git colours the names even with -l -z.
  const args = ['grep', '-l', '-z', '--no-color', '-E', '-e', '^(<<<<<<<|>>>>>>>)', ...(ref ? [ref] : []), '--'];
  // git grep exits 1 when nothing matches.
  const listed = await orAbsent(ctx.read('git', args, { cwd: dir }), (error) => error.code === 1);
  const candidates = (listed ?? '')
    .split('\0')
    .filter(Boolean)
    .map((name) => (ref && name.startsWith(`${ref}:`) ? name.slice(ref.length + 1) : name));
  const held: string[] = [];
  for (const file of candidates) {
    const text = ref
      ? await ctx.read('git', ['cat-file', 'blob', `${ref}:${file}`], { cwd: dir })
      : await ctx.readFile(join(dir, file));
    if (hasConflictMarkers(text)) held.push(file);
  }
  return held.sort();
}
