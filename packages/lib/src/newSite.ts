// newSite: create a repo or an app from templates and answers, the verb that
// replaces `copier copy`. It renders the templates the running plx bundles
// through the engine, writes the tree into a directory that is empty or absent,
// writes the marker's frontmatter, and runs the birth commands the manifests
// declare. It never prompts: a missing answer is the render's error, listing
// every missing question with its help.
//
// The procedure.
//   1. Refuse a target that holds anything (a file, or a directory with
//      entries). Nothing is written before every refusal below has been made.
//   2. Tell a repo from an app. The directory is an app when the git repo it
//      lies in has a `PLEXUS.md` at its top, read from the working tree: a
//      repo just born has committed nothing, and its marker is not tracked
//      yet. Anything else is a new repo, one nested in another repo without a
//      marker included.
//   3. Render. An app is rendered with the root marker's answers and the given
//      ones; a root answer given again is refused (§ 5 of Decisions: a key is
//      answered in one marker only), and so is a question of the app's
//      templates that the root marker answers, which would stand in two
//      markers. Every render error is reported together.
//   4. Write the tree, then the marker's frontmatter into the file the render
//      produced (`PLEXUS.md`; a render without one is refused, as the marker
//      is where the answers go). The frontmatter is `version`, for a repo
//      only and the version of the running plx, then `templates`, then the
//      answers the render resolved, defaults included, so that a later change
//      of a default upstream does not silently change the repo. An app's
//      marker holds its own answers only: the root's are the root's.
//   5. Run the birth commands in the target directory, each printed before it
//      runs (the Context narrates every effect) and not run under --dry-run,
//      which also writes nothing.
//
// The files are written through the engine's `planMerge` against an empty old
// render, the one writer of directories (modes, symlinks, directories that
// stay), so that a tree is written as an update would write it.
import { mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Answers } from '@plexus-ms/cli-template';
import { readTemplate } from './bundled.ts';
import type { Context } from './context.ts';
import { run } from './effects.ts';
import { engine } from './engine.ts';
import { MARKER_FILE, parseMarkerConfig, setMarkerKeys } from './marker.ts';
import { describeError } from './sync.ts';
import { templatesRoot } from './templatesRoot.ts';

export interface NewOptions {
  /** The directory to create: absent, or empty. */
  dir: string;
  /** The templates to render together, by name. */
  templates: readonly string[];
  /** The answers given; for an app, the ones the root marker lacks. */
  answers: Answers;
  /** The Plexus version of the running plx; a new repo's marker names it. */
  plxVersion: string;
  /** The root of the templates; default `templatesRoot()`, the ones this plx bundles. */
  root?: string;
}

export interface Created {
  dir: string;
  kind: 'repo' | 'app';
  templates: readonly string[];
  /** The answers written into the marker: the resolved ones of the render, the root's not among them. */
  answers: Answers;
  /** The paths of the tree, sorted. */
  files: string[];
  /** The birth commands, each an argument vector, in the order they run. */
  birth: string[][];
  /** The given answers that no template owns or reads. */
  unused: string[];
  /** The tree was written and the commands run: false for a dry run. */
  written: boolean;
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Rejects unless `dir` is absent or an empty directory. */
async function requireEmpty(dir: string): Promise<void> {
  const st = await stat(dir).catch((error) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (st === undefined) return;
  if (!st.isDirectory()) throw new Error(`${dir} exists and is not a directory`);
  if ((await readdir(dir)).length > 0)
    throw new Error(`${dir} is not empty: a site is created in an empty or absent directory`);
}

/** The nearest directory at or above `dir` that exists. */
async function existingAbove(dir: string): Promise<string> {
  for (let at = dir; ; at = dirname(at)) {
    if (
      await stat(at).then(
        () => true,
        () => false,
      )
    )
      return at;
  }
}

/** The answers of the root marker of the repo `dir` lies in, or undefined when `dir` is no app of a Plexus repo. */
async function rootAnswers(ctx: Context, dir: string): Promise<Answers | undefined> {
  let top: string;
  try {
    top = (await ctx.read('git', ['rev-parse', '--show-toplevel'], { cwd: await existingAbove(dir) })).trim();
  } catch {
    return undefined;
  }
  const file = join(top, MARKER_FILE);
  const text = await ctx.readFile(file).catch((error) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  try {
    return parseMarkerConfig(text).answers;
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`);
  }
}

export async function newSite(ctx: Context, options: NewOptions): Promise<Created> {
  const dir = resolve(options.dir);
  const root = options.root ?? templatesRoot();
  await requireEmpty(dir);
  const inherited = await rootAnswers(ctx, dir);
  const kind = inherited === undefined ? 'repo' : 'app';
  const given = Object.keys(options.answers);
  const doubled = given.filter((key) => inherited && Object.hasOwn(inherited, key));
  if (doubled.length > 0)
    throw new Error(
      `${doubled.map((key) => `\`${key}\``).join(', ')} ${doubled.length === 1 ? 'is' : 'are'} answered in the root marker already, and a key is answered in one marker only: leave it out`,
    );

  const { render, planMerge } = await engine();
  const trees = [];
  for (const name of options.templates) trees.push((await readTemplate(root, name)).tree);
  const result = render(trees, { ...inherited, ...options.answers });
  if (result.errors.length > 0) throw new Error(result.errors.map((e) => describeError(dir, e)).join('\n'));
  const own = Object.keys(result.answers).filter((key) => inherited && Object.hasOwn(inherited, key));
  if (own.length > 0)
    throw new Error(
      `the templates ask ${own.map((key) => `\`${key}\``).join(', ')}, which the root marker answers already, and a key is answered in one marker only`,
    );
  const marker = result.tree.get(MARKER_FILE);
  if (marker === undefined)
    throw new Error(
      `the templates render no ${MARKER_FILE}, the file that holds a site's answers: add the one that does`,
    );

  const frontmatter = {
    ...(kind === 'repo' ? { version: options.plxVersion } : {}),
    templates: [...options.templates],
    ...result.answers,
  };
  const text = setMarkerKeys(`---\n---\n\n${new TextDecoder().decode(marker.bytes)}`, frontmatter);
  const tree = new Map(result.tree).set(MARKER_FILE, { ...marker, bytes: new TextEncoder().encode(text) });

  const written = !ctx.dryRun;
  ctx.say(`${written ? '' : '[dry-run] '}write ${tree.size} files to ${dir}`);
  if (written) {
    await mkdir(dir, { recursive: true });
    const plan = await planMerge(dir, { tree: new Map(), policies: new Map() }, { tree, policies: result.files });
    await plan.apply();
  }
  const birth = result.birth.map((b) => [...b.command]);
  await ctx.apply(birth.map(([command, ...args]) => run(command as string, args, { cwd: dir })));
  return {
    dir,
    kind,
    templates: options.templates,
    answers: result.answers,
    files: [...tree.keys()].sort(),
    birth,
    unused: result.unused.filter((key) => given.includes(key)),
    written,
  };
}
