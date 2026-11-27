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
//
// A site's answers, which a render is given, are the root marker's answers
// and the site's own: a nested site shares the root's answers and adds its
// own, and a key answered in both markers is an error, never an override.
import { dirname, join } from 'node:path';
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
  // --end-of-options: a ref that starts with `-` is a name git rejects, never an option it runs (git 2.24).
  const listing =
    ref === undefined ? ['ls-files', '-z'] : ['ls-tree', '-r', '-z', '--name-only', '--end-of-options', ref];
  const markers = (await ctx.read('git', listing, { cwd: repo }))
    .split('\0')
    .filter((path) => path === MARKER_FILE || path.endsWith(`/${MARKER_FILE}`));
  const sites: MarkerSite[] = [];
  for (const path of markers) {
    const text =
      ref === undefined
        ? await ctx.readFile(join(repo, path)).catch((error) => {
            if (isMissing(error)) return undefined;
            throw error;
          })
        : await ctx.read('git', ['cat-file', 'blob', '--end-of-options', `${ref}:${path}`], { cwd: repo });
    if (text === undefined) continue;
    const dir = dirname(path);
    sites.push({ dir, ...configOf(text, dir) });
  }
  return sites.sort((a, b) => Number(b.dir === '.') - Number(a.dir === '.') || (a.dir < b.dir ? -1 : 1));
}

function configOf(text: string, dir: string): Pick<MarkerSite, 'config' | 'problem'> {
  try {
    const config = parseMarkerConfig(text);
    if (dir !== '.' && config.version !== undefined)
      return { problem: "`version` belongs in the repo's root marker only; remove it" };
    return { config };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The answers of the site at `dir` among `sites`: the root marker's and the
 * site's own; the root's alone for the root. Throws when either marker has a
 * problem, when both answer a key, or when no site is at `dir`.
 */
export function siteAnswers(sites: readonly MarkerSite[], dir: string): Record<string, unknown> {
  const own = answersAt(sites, dir);
  if (!own) throw new Error(`no marker in ${dir}`);
  const root = dir === '.' ? undefined : answersAt(sites, '.');
  if (!root) return { ...own };
  const both = Object.keys(own).filter((key) => Object.hasOwn(root, key));
  if (both.length > 0) {
    const keys = both.map((key) => `\`${key}\``).join(', ');
    const [is, remove] = both.length === 1 ? ['is', 'it'] : ['are', 'each'];
    throw new Error(
      `${join(dir, MARKER_FILE)}: ${keys} ${is} answered in the root marker as well; remove ${remove} from one of the two`,
    );
  }
  return { ...root, ...own };
}

/** The answers of the marker in `dir`, or undefined when there is none; throws on its problem. */
function answersAt(sites: readonly MarkerSite[], dir: string): Record<string, unknown> | undefined {
  const site = sites.find((s) => s.dir === dir);
  if (site?.problem !== undefined) throw new Error(`${join(dir, MARKER_FILE)}: ${site.problem}`);
  return site?.config?.answers;
}
