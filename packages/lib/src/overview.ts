// overview: the map of a folder of repos (the toolbox's overview.sh, moved).
//
// Walk a directory, note for every directory whether it is a git repo, a
// copier template, a copier-managed project, or a declared Plexus unit, and
// return the tree of directories that carry such a facet, with the ancestors
// needed to reach them. Reads only: there is nothing to plan or apply.
//
//   plx overview            # map the current directory
//   plx overview ~/dev      # map somewhere else
//   plx overview --sync     # fetch every repo first, to show what is behind
import { dirname, join } from 'node:path';
import type { Context } from './context.ts';
import { ANSWERS_FILE, parseAnswers, TEMPLATE_FILES } from './copier.ts';
import type { DirEntry } from './io.ts';
import { MARKER_FILE, parseMarker } from './marker.ts';
import {
  APPS_DIR,
  type Directory,
  type GitFacet,
  holdsApp,
  isNotable,
  shortRemote,
  type TemplateFacet,
} from './model.ts';
import { plxPinOf } from './version.ts';

/** Heavy or generated directories never descended into. `.git` is the repo marker and is handled apart. */
export const PRUNED = new Set([
  'node_modules',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.svelte-kit',
  'dist',
  'build',
  'out',
  '.output',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.cache',
  '.pnpm-store',
  'coverage',
  'vendor',
  '.terraform',
  '.gradle',
]);

/**
 * Whether the walk descends into a directory of that name: never `.git`, and
 * never a pruned one unless it is an app directly in its repo's `apps/`.
 */
export const descends = (name: string, app: boolean): boolean => name !== '.git' && (app || !PRUNED.has(name));

/**
 * The directories of a repo's tree that the walk reaches and that hold an
 * answers file outside any template directory: where its sites can be, by
 * the walk's own rule, from the paths of its tracked files relative to its
 * root (`.` for the root), in the tree's order. A tree read from git (a
 * branch's tip) has no checkout to walk; this is the walk over its paths.
 */
export function answersDirs(files: readonly string[]): string[] {
  const present = new Set(files);
  const holdsTemplate = (dir: string) => TEMPLATE_FILES.some((f) => present.has(dir === '.' ? f : `${dir}/${f}`));
  const namesIn = (dir: string) =>
    files.filter((f) => f.startsWith(`${dir}/`)).map((f) => ({ name: f.slice(dir.length + 1).split('/')[0] ?? '' }));
  const dirs: string[] = [];
  for (const file of files) {
    if (file !== ANSWERS_FILE && !file.endsWith(`/${ANSWERS_FILE}`)) continue;
    const dir = dirname(file);
    const parts = dir === '.' ? [] : dir.split('/');
    let reached = !holdsTemplate('.');
    for (let i = 0; reached && i < parts.length; i++) {
      const at = parts.slice(0, i + 1).join('/');
      const app = i === 1 && parts[0] === APPS_DIR && holdsApp(namesIn(at));
      reached = descends(parts[i] ?? '', app) && !holdsTemplate(at);
    }
    if (reached) dirs.push(dir);
  }
  return dirs;
}

export interface ScanOptions {
  /** Read the git facets (four git calls per repo); off for verbs that only need markers. */
  git?: boolean;
  /** Fetch every repo's remotes, then count commits ahead of and behind the upstream; slow, so opt-in. */
  fetch?: boolean;
}

/** Where a repo pins plx, which names the version it is on. */
const MISE_FILE = 'mise.toml';

/** Fetches in flight at once: enough to hide network latency, few enough not to trip a host's rate limit. */
const FETCHES = 8;

export async function overview(ctx: Context, root: string, options: ScanOptions = {}): Promise<Directory> {
  const opts = { git: true, fetch: false, ...options };
  const tree = await walk(ctx, root, root.replace(/\/+$/, '').split('/').pop() || root, opts);
  if (opts.git && opts.fetch) await syncAll(ctx, repos(tree));
  return tree;
}

function repos(dir: Directory): Directory[] {
  return [...(dir.git ? [dir] : []), ...dir.children.flatMap(repos)];
}

async function syncAll(ctx: Context, dirs: Directory[]): Promise<void> {
  const queue = [...dirs];
  const worker = async () => {
    for (let dir = queue.shift(); dir; dir = queue.shift()) await sync(ctx, dir);
  };
  await Promise.all(Array.from({ length: Math.min(FETCHES, queue.length) }, worker));
}

/** Fetch all remotes (only remote-tracking refs change), then compare the branch with its upstream. */
async function sync(ctx: Context, dir: Directory): Promise<void> {
  const facet = dir.git;
  if (!facet) return;
  try {
    await ctx.read('git', ['fetch', '--all', '--quiet'], { cwd: dir.path });
  } catch (error) {
    dir.problems ??= [];
    dir.problems.push(`git fetch: ${error instanceof Error ? error.message : String(error)}`);
  }
  // No upstream (detached, or a branch never pushed) leaves nothing to compare against.
  const counts = await git(ctx, dir.path, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
  const [ahead, behind] = (counts ?? '').split(/\s+/).map(Number);
  if (ahead === undefined || behind === undefined || Number.isNaN(ahead) || Number.isNaN(behind)) return;
  facet.ahead = ahead;
  facet.behind = behind;
}

/** Why a directory could not be read: its errno code, else the message. */
export const whyUnreadable = (error: unknown): string =>
  (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));

/** A read that failed because nothing is there, as opposed to something that cannot be read. */
export const isMissing = (error: unknown): boolean =>
  ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

/** What `appsOf` found in a repo's `apps/`. */
export interface AppsRead {
  /** The apps' directories, in name order. */
  apps: string[];
  /** Symbolic links to directories in `apps/`: not followed, so not apps, and named as not checked. */
  links: string[];
  /** Directories that could not be read, `apps/` itself or one in it, with why. */
  unreadable: { path: string; why: string }[];
}

/**
 * The apps of a repo (§ 2 PLX-App): the directories directly in its `apps/`
 * that hold one (`holdsApp`), with a marker or without. The one reader of
 * them: overview's walk records them on every git root, and doctor checks
 * them, so the two verbs agree on what an app is. A pruned name (`build`,
 * `dist`) does not hide an app, a symlinked directory is named and not
 * followed, and a directory that cannot be read is named with why.
 */
export async function appsOf(ctx: Context, repo: string): Promise<AppsRead> {
  const read: AppsRead = { apps: [], links: [], unreadable: [] };
  const dir = join(repo, APPS_DIR);
  let entries: DirEntry[];
  try {
    entries = await ctx.readDir(dir);
  } catch (error) {
    if (!isMissing(error)) read.unreadable.push({ path: dir, why: whyUnreadable(error) });
    return read;
  }
  for (const entry of [...entries].sort(byName)) {
    const path = join(dir, entry.name);
    if (entry.symlink) {
      if (await isDirectory(ctx, path)) read.links.push(path);
      continue;
    }
    if (!entry.directory) continue;
    try {
      if (holdsApp(await ctx.readDir(path))) read.apps.push(path);
    } catch (error) {
      read.unreadable.push({ path, why: whyUnreadable(error) });
    }
  }
  return read;
}

/** Entries in code-unit order of their names, as `Array.prototype.sort` orders strings. */
const byName = (a: DirEntry, b: DirEntry): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const isDirectory = (ctx: Context, path: string): Promise<boolean> =>
  ctx.readDir(path).then(
    () => true,
    () => false,
  );

/** Whether a symbolic link leads to a git repo: its target holds `.git`. */
const linksToRepo = (ctx: Context, path: string): Promise<boolean> =>
  ctx.readDir(path).then(
    (entries) => entries.some((e) => e.name === '.git'),
    () => false,
  );

/**
 * One directory and the notable ones beneath it. A directory that cannot be
 * read is recorded with why, not fatal. Symbolic links are not followed; one
 * to a directory in a repo's `apps/`, or to a git repo, is recorded as such.
 * `apps`, when the directory is a repo's `apps/`, is what `appsOf` found
 * there: those are walked and kept whatever their name.
 */
async function walk(
  ctx: Context,
  path: string,
  name: string,
  options: Required<ScanOptions>,
  apps?: AppsRead,
): Promise<Directory> {
  let entries: DirEntry[];
  try {
    entries = await ctx.readDir(path);
  } catch (error) {
    return { name, path, children: [], unreadable: whyUnreadable(error) };
  }
  const dir = await facetsOf(ctx, path, name, entries, options);
  const own = dir.gitRoot ? await appsOf(ctx, path) : undefined;
  if (own) dir.apps = own.apps;
  for (const entry of [...entries].sort(byName)) {
    const sub = join(path, entry.name);
    if (entry.symlink) {
      if (apps?.links.includes(sub) || (await linksToRepo(ctx, sub)))
        dir.children.push({ name: entry.name, path: sub, symlink: true, children: [] });
      continue;
    }
    const app = apps?.apps.includes(sub) ?? false;
    if (!entry.directory || !descends(entry.name, app)) continue;
    const child = await walk(ctx, sub, entry.name, options, own && entry.name === APPS_DIR ? own : undefined);
    if (app || isNotable(child) || child.children.length > 0) dir.children.push(child);
  }
  return dir;
}

/** One directory as the walk records it, without its children; no git facet. */
export async function directoryAt(ctx: Context, path: string): Promise<Directory> {
  const name = path.replace(/\/+$/, '').split('/').pop() || path;
  return facetsOf(ctx, path, name, await ctx.readDir(path), { git: false, fetch: false });
}

/** The facets of one directory, from its entries. */
async function facetsOf(
  ctx: Context,
  path: string,
  name: string,
  entries: DirEntry[],
  options: Required<ScanOptions>,
): Promise<Directory> {
  const files = new Set(entries.filter((e) => !e.directory).map((e) => e.name));
  const names = new Set(entries.map((e) => e.name));
  const dir: Directory = { name, path, children: [] };

  // `.git` is a directory for a checkout and a file for a linked worktree or submodule.
  if (names.has('.git')) {
    dir.gitRoot = true;
    if (options.git) dir.git = await gitFacet(ctx, path);
  }
  if (TEMPLATE_FILES.some((f) => files.has(f))) dir.template = options.git ? await templateFacet(ctx, path) : {};
  if (files.has(ANSWERS_FILE)) {
    await facet(ctx, dir, ANSWERS_FILE, (text) => {
      dir.copier = parseAnswers(text);
    });
  }
  if (files.has(MARKER_FILE)) {
    await facet(ctx, dir, MARKER_FILE, (text) => {
      dir.declaration = parseMarker(text);
    });
  }
  if (files.has(MISE_FILE)) {
    await facet(ctx, dir, MISE_FILE, (text) => {
      const pin = plxPinOf(text);
      if (pin) dir.pin = pin;
    });
  }
  return dir;
}

async function facet(ctx: Context, dir: Directory, file: string, read: (text: string) => void) {
  try {
    read(await ctx.readFile(join(dir.path, file)));
  } catch (error) {
    dir.problems ??= [];
    dir.problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A git read that may legitimately fail (no remote, no tag, detached): undefined then. */
async function git(ctx: Context, cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const out = (await ctx.read('git', args, { cwd })).trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

async function gitFacet(ctx: Context, cwd: string): Promise<GitFacet> {
  const branch =
    (await git(ctx, cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])) ??
    (await git(ctx, cwd, ['rev-parse', '--short', 'HEAD'])) ??
    '?';
  const dirty = (await git(ctx, cwd, ['status', '--porcelain'])) !== undefined;
  const remote = await git(ctx, cwd, ['remote', 'get-url', 'origin']);
  // The most recent tag reachable from the default branch: origin/HEAD, else a local main or master.
  let defaultRef = await git(ctx, cwd, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']);
  for (const b of ['main', 'master']) {
    if (defaultRef) break;
    if (await git(ctx, cwd, ['rev-parse', '--verify', '-q', `refs/heads/${b}`])) defaultRef = b;
  }
  const tag = defaultRef ? await git(ctx, cwd, ['describe', '--tags', '--abbrev=0', defaultRef]) : undefined;
  const facet: GitFacet = { branch, dirty };
  if (tag) facet.tag = tag;
  if (remote) facet.remote = shortRemote(remote);
  return facet;
}

async function templateFacet(ctx: Context, cwd: string): Promise<TemplateFacet> {
  const tag =
    (await git(ctx, cwd, ['describe', '--tags', '--abbrev=0'])) ??
    (await git(ctx, cwd, ['tag', '--list', '--sort=-v:refname']))?.split('\n')[0];
  return tag ? { tag } : {};
}
