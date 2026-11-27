// The sites of a repo: every directory that holds a tracked marker
// (PLEXUS.md, marker.ts), at any depth, with the marker's frontmatter read as
// configuration. A site whose marker lists `templates` is rendered from them;
// one without renders nothing, and the root marker's answers count for every
// site all the same.
//
// The markers are read from the working tree, as a verb that works on the
// checkout sees it, or from a git ref, as a verb that compares with a base
// branch needs it. Tracked is what git lists (`git ls-files`, `git ls-tree`
// at a ref): an untracked marker is no site yet, and a tracked one deleted
// from the working tree is none any more there.
//
// A marker that cannot be read, or that carries `version` below the root,
// where it does not belong, gives its site a problem instead of a
// configuration, so that a check can name every such site at once.
import { join } from 'node:path';
import type { Context } from './context.ts';
import { MARKER_FILE, type MarkerConfig, parseMarkerConfig } from './marker.ts';
import { isMissing } from './overview.ts';

export interface MarkerSite {
  /** The site's directory relative to the repo, `.` for the root. */
  dir: string;
  /** The marker's configuration; undefined when the marker has a problem. */
  config?: MarkerConfig;
  /** Why the marker cannot serve as configuration. */
  problem?: string;
}

/**
 * The sites of the repo at `repo`, the root first and the others in path
 * order: as the working tree has them, or, given a `ref`, as that commit has
 * them, which needs no checkout of it. Rejects when git cannot list the
 * repo or the ref.
 */
export async function findSites(ctx: Context, repo: string, ref?: string): Promise<MarkerSite[]> {
  const listing = ref === undefined ? ['ls-files', '-z'] : ['ls-tree', '-r', '-z', '--name-only', ref];
  const markers = (await ctx.read('git', listing, { cwd: repo }))
    .split('\0')
    .filter((path) => path === MARKER_FILE || path.endsWith(`/${MARKER_FILE}`));
  const sites: MarkerSite[] = [];
  for (const path of markers) {
    const text = ref
      ? await ctx.read('git', ['cat-file', 'blob', `${ref}:${path}`], { cwd: repo })
      : await ctx.readFile(join(repo, path)).catch((error) => {
          if (isMissing(error)) return undefined;
          throw error;
        });
    if (text === undefined) continue;
    const dir = path === MARKER_FILE ? '.' : path.slice(0, -MARKER_FILE.length - 1);
    sites.push({ dir, ...configOf(text, dir) });
  }
  return sites.sort((a, b) => Number(b.dir === '.') - Number(a.dir === '.') || (a.dir < b.dir ? -1 : 1));
}

function configOf(text: string, dir: string): Pick<MarkerSite, 'config' | 'problem'> {
  try {
    const config = parseMarkerConfig(text);
    if (dir !== '.' && config.version !== undefined)
      return { problem: "`version` belongs in the repo's root marker only" };
    return { config };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}
