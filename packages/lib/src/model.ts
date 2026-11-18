// The Plexus vocabulary (§ 1.2 PLX) as far as a verb needs it today: a
// directory and the facets it carries. A facet is present exactly when its
// marker file is. What a directory *is* (an app, the operations repo, a repo)
// is derived from where it sits and what it carries, never stored.
import type { Answers } from './copier.ts';
import { type Declaration, MARKER_FILE } from './marker.ts';
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

/** A repo or an app, and what it is. */
export interface Unit {
  dir: Directory;
  kind: Kind;
  /** An app's source repo, the repo whose `apps/` holds it. */
  repo?: Directory;
}

/** The template the operations repo is rendered from (§ 1.6 PLX). */
const OPERATIONS_TEMPLATE = 'template-repo-operations';

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
 * root answers file names it, under its current or an earlier name.
 */
export const isOperations = (dir: Directory): boolean =>
  dir.copier?.src !== undefined && templateOf(dir.copier.src, [OPERATIONS_TEMPLATE]) !== undefined;

/**
 * Every unit of a scanned tree that carries a marker, in tree order, as
 * overview labels them. What a unit is follows from where it is (§ 1.3 PLX),
 * never from what its marker says: a repo is a git root, the operations repo
 * when its answers file says so; an app is a directory directly in the
 * `apps/` of its nearest enclosing git root. A git root is a Plexus repo when
 * it carries a marker or its `apps/` holds an app. doctor finds its units by
 * the same rules, reading each repo's `apps/` itself (doctor.ts), so that an
 * app without a marker is found too.
 */
export function unitsOf(root: Directory): Unit[] {
  const units: Unit[] = [];
  /** `repo` is the nearest enclosing git root; `inApps`, that `dir` sits directly in its `apps/`. */
  const visit = (dir: Directory, repo: Directory | undefined, inApps: boolean) => {
    let here = repo;
    if (dir.gitRoot) {
      here = dir;
      const apps = dir.children.find((c) => c.name === APPS_DIR)?.children ?? [];
      if (hasMarker(dir) || apps.some((a) => !a.gitRoot))
        units.push({ dir, kind: isOperations(dir) ? 'operations' : 'repo' });
    } else if (inApps && repo && hasMarker(dir)) units.push({ dir, kind: 'app', repo });
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
  return Boolean(dir.gitRoot || dir.git || dir.template || dir.copier || dir.declaration || dir.problems?.length);
}
