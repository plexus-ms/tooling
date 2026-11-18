// The Plexus vocabulary (§ 1.2 PLX) as far as a verb needs it today: a
// directory and the facets it carries. A facet is present exactly when its
// marker file is. What a directory *is* (an app, the operations repo, a repo)
// is derived from where it sits and what it carries, never stored.
import { templateOf } from './consumers.ts';
import type { Answers } from './copier.ts';
import { type Declaration, MARKER_FILE } from './marker.ts';

export interface Directory {
  name: string;
  path: string;
  git?: GitFacet;
  template?: TemplateFacet;
  copier?: Answers;
  declaration?: Declaration;
  /** The `plx` pin of the directory's `mise.toml`: the Plexus version a repo is on (§ 1.5 PLX). */
  pin?: string;
  /** Marker files that could not be read; shown, never fatal. */
  problems?: string[];
  children: Directory[];
}

export interface GitFacet {
  /** The checked-out branch, or the short commit when detached. */
  branch: string;
  /** Uncommitted tracked or untracked changes. */
  dirty: boolean;
  /** The most recent tag reachable from the default branch, if any. */
  tag?: string;
  /** The `origin` remote, shortened: `gh:org/repo` for GitHub. */
  remote?: string;
  /** Commits on the branch not on its upstream; read only by a synced overview, and only with an upstream. */
  ahead?: number;
  /** Commits on the upstream not on the branch, as of the fetch a synced overview made. */
  behind?: number;
}

export interface TemplateFacet {
  /** The template repo's most recent tag, if any. */
  tag?: string;
}

/** What a unit is: an app, the operations repo, or any other repo (§ 1.2 PLX). */
export type Kind = 'app' | 'operations' | 'repo';

/** A directory with a marker, readable or not, and what it is. */
export interface Unit {
  dir: Directory;
  kind: Kind;
  /** An app's source repo, the repo whose `apps/` holds it. */
  repo?: Directory;
}

/** The template the operations repo is rendered from (§ 1.6 PLX). */
const OPERATIONS_TEMPLATE = 'template-repo-operations';

const hasMarker = (dir: Directory): boolean =>
  Boolean(dir.declaration || dir.problems?.some((p) => p.startsWith(MARKER_FILE)));

/**
 * The operations repo is the one rendered from the operations template: its
 * root answers file names it, under its current or an earlier name.
 */
export const isOperations = (dir: Directory): boolean =>
  dir.copier?.src !== undefined && templateOf(dir.copier.src, [OPERATIONS_TEMPLATE]) !== undefined;

/**
 * Every unit of a scanned tree, in tree order. What a unit is follows from
 * where it is (§ 1.3 PLX), never from what its marker says: a marker at
 * `apps/<name>/` of a repo makes an app of that repo, any other marker a repo,
 * the operations repo when its answers file says so. With `rootIsRepo`, the
 * root is a repo whether it carries a marker or not.
 */
export function unitsOf(root: Directory, options: { rootIsRepo?: boolean } = {}): Unit[] {
  const units: Unit[] = [];
  /** `appsOf` is the repo when `dir` sits directly in that repo's `apps/`. */
  const visit = (dir: Directory, repo: Directory | undefined, appsOf: Directory | undefined) => {
    let here = repo;
    if (hasMarker(dir) || (dir === root && options.rootIsRepo)) {
      if (repo && appsOf === repo) units.push({ dir, kind: 'app', repo });
      else {
        units.push({ dir, kind: isOperations(dir) ? 'operations' : 'repo' });
        here = dir;
      }
    }
    for (const child of dir.children) {
      if (child.name === 'apps' && here === dir) for (const app of child.children) visit(app, here, here);
      else visit(child, here, undefined);
    }
  };
  visit(root, undefined, undefined);
  return units;
}

/** A git remote URL as a short handle: `gh:org/repo` for GitHub, the URL otherwise. */
export function shortRemote(url: string): string {
  const bare = url.replace(/\.git$/, '').replace(/\/$/, '');
  const m = /^(?:git@github\.com:|github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)(.+)$/.exec(bare);
  return m ? `gh:${m[1]}` : bare;
}

/** Whether a directory, or anything below it, carries a facet worth showing. */
export function isNotable(dir: Directory): boolean {
  return Boolean(dir.git || dir.template || dir.copier || dir.declaration || dir.problems?.length);
}
