// The Plexus vocabulary (§ 1.2 PLX) as far as a verb needs it today: a
// directory and the facets it carries. A facet is present exactly when its
// marker file is. What a directory *is* (an app, the operations repo, a repo)
// is derived from where it sits and what it carries, never stored.
import type { Answers } from './copier.ts';
import { type Declaration, MARKER_FILE, type MarkerConfig } from './marker.ts';
import { templateOf } from './templates.ts';

export interface Directory {
  name: string;
  path: string;
  /** `.git` is here: a directory for a checkout, a file for a linked worktree or a submodule. Read even when the git facet is not. */
  gitRoot?: true;
  git?: GitFacet;
  template?: TemplateFacet;
  copier?: Answers;
  declaration?: Declaration;
  /** The marker as configuration (`version`, `templates`, answers); absent when it cannot be read as such, which `findSites` (sites.ts) reports. */
  config?: MarkerConfig;
  /** The `plx` pin of the directory's `mise.toml`: the Plexus version a repo is on (§ 1.5 PLX). */
  pin?: string;
  /** Marker files that could not be read; shown, never fatal. */
  problems?: string[];
  /** A git root's apps (§ 2 PLX-App), by path, as `appsOf` (overview.ts) finds them; set by the walk on every git root. */
  apps?: string[];
  /** Why the directory's entries could not be read (an errno code such as EACCES); nothing beneath it is known. */
  unreadable?: string;
  /** A symbolic link to a directory, not followed: one in a repo's `apps/`, or one to a git repo. */
  symlink?: true;
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

/** A repo or an app, and what it is. */
export interface Unit {
  dir: Directory;
  kind: Kind;
  /** An app's source repo, the repo whose `apps/` holds it. */
  repo?: Directory;
}

/** The operations template as a marker's `templates` names it. */
const OPERATIONS_TEMPLATE_NAME = 'repo-operations';

/** The template repo it is rendered from (§ 1.6 PLX), as an answers file's source names it. */
const OPERATIONS_TEMPLATE = `template-${OPERATIONS_TEMPLATE_NAME}`;

/** Whether the directory carries a marker, readable or not. */
export const hasMarker = (dir: Directory): boolean =>
  Boolean(dir.declaration || dir.problems?.some((p) => p.startsWith(MARKER_FILE)));

/** The directory that holds a repo's apps, one directory each (§ 2 PLX-App). */
export const APPS_DIR = 'apps';

/**
 * Whether a directory's entries make it an app, once it sits directly in its
 * repo's `apps/`: anything but dotfiles (an empty directory, or one holding
 * only a `.gitkeep`, is none), and no `.git` (a checkout of its own is a repo
 * of its own, not this repo's app).
 */
export const holdsApp = (entries: readonly { name: string }[]): boolean =>
  entries.some((e) => !e.name.startsWith('.')) && !entries.some((e) => e.name === '.git');

/**
 * The operations repo is the one rendered from the operations template: its
 * root answers file names it, under its current or an earlier name, or, once
 * the repo has crossed over from copier, its root marker's `templates` does.
 */
export const isOperations = (dir: Directory): boolean =>
  (dir.copier?.src !== undefined && templateOf(dir.copier.src, [OPERATIONS_TEMPLATE]) !== undefined) ||
  dir.config?.templates?.includes(OPERATIONS_TEMPLATE_NAME) === true;

/**
 * Every unit of a scanned tree, in tree order, as overview labels them. What
 * a unit is follows from where it is (§ 1.3 PLX), never from what its marker
 * says: a repo is a git root, the operations repo when its answers file says
 * so; an app is one of the apps the walk found for its nearest enclosing git
 * root (`apps`, read by `appsOf`, which doctor reads them by too), with a
 * marker or without. A git root is a Plexus repo when it carries a marker or
 * has an app.
 */
export function unitsOf(root: Directory): Unit[] {
  const units: Unit[] = [];
  /** `repo` is the nearest enclosing git root; `inApps`, that `dir` sits directly in its `apps/`. */
  const visit = (dir: Directory, repo: Directory | undefined, inApps: boolean) => {
    let here = repo;
    if (dir.gitRoot) {
      here = dir;
      if (hasMarker(dir) || (dir.apps?.length ?? 0) > 0)
        units.push({ dir, kind: isOperations(dir) ? 'operations' : 'repo' });
    } else if (inApps && repo?.apps?.includes(dir.path)) units.push({ dir, kind: 'app', repo });
    for (const child of dir.children) {
      if (child.name === APPS_DIR && here === dir) for (const app of child.children) visit(app, here, true);
      else visit(child, here, false);
    }
  };
  visit(root, undefined, false);
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
  return Boolean(
    dir.gitRoot ||
      dir.git ||
      dir.template ||
      dir.copier ||
      dir.declaration ||
      dir.problems?.length ||
      dir.unreadable ||
      dir.symlink,
  );
}
