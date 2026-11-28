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
//      lies in has a `PLEXUS.md` at its top, read from the working tree, so
//      that an untracked one counts: a repo just born has committed nothing.
//      Anything else is a new repo, one nested in another repo without a
//      marker included. An app is refused, by the rule of `plx apply`
//      (`versionRefusal`), where the root marker lists templates and its
//      `version` is not the running plx's or is absent: the templates are the
//      running version's, and all sites of a repo are on one version.
//   3. Render. An app is rendered with the root's resolved answers, as a
//      nested site is by `apply`: the root marker's and the defaults of its
//      templates, plus the given ones. A root answer given again is refused
//      (§ 5 of Decisions: a key is answered in one marker only), and so is a
//      question of the app's templates that the root answers, which would
//      stand in two markers. Every template that cannot be read is reported
//      together, and that stops the run; only when all are read are the
//      render errors, all of them, reported together.
//   4. Write the tree, then the marker's frontmatter into the file the render
//      produced (`PLEXUS.md`; a render without one is refused, as the marker
//      is where the answers go). The frontmatter is `version`, for a repo
//      only and the version of the running plx, then `templates`, then the
//      answers the render resolved, defaults included, so that a later change
//      of a default upstream does not silently change the repo, then the
//      given answers that a rendered template reads and none owns, as they
//      were given (the engine casts only what a template owns): without them
//      `plx apply` could not render the site again. A given answer that
//      nothing owns or reads is written nowhere and reported unused; one for
//      a question whose `when` is false is written nowhere and not reported,
//      as the engine does not. An app's marker holds its own answers only:
//      the root's are the root's.
//   5. Run the birth commands in the target directory, each printed before it
//      runs (the Context narrates every effect) and not run under --dry-run,
//      which also writes nothing. A command that fails stops the run with its
//      error, the note that the files are written, and the commands left to
//      do by hand, the failed one first.
//
// The files are written through the engine's `planMerge` against an empty old
// render, the one writer of directories (modes, symlinks, directories that
// stay), so that a tree is written as an update would write it.
import { mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Answers, Manifest } from '@plexus-ms/cli-template';
import { versionRefusal } from './apply.ts';
import { readTemplate } from './bundled.ts';
import type { Context } from './context.ts';
import { describe, run } from './effects.ts';
import { engine } from './engine.ts';
import { MARKER_FILE, type MarkerConfig, parseMarkerConfig, setMarkerKeys } from './marker.ts';
import { describeError, resolvedAnswers } from './sync.ts';
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
  /** The answers written into the marker: the resolved ones of the render and the given ones it reads, the root's not among them. */
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

/** The root marker of the repo `dir` lies in, read from the working tree; undefined when `dir` is no app of a Plexus repo. */
async function rootMarker(ctx: Context, dir: string): Promise<MarkerConfig | undefined> {
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
    return parseMarkerConfig(text);
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`);
  }
}

export async function newSite(ctx: Context, options: NewOptions): Promise<Created> {
  const dir = resolve(options.dir);
  const root = options.root ?? templatesRoot();
  await requireEmpty(dir);
  const rootConfig = await rootMarker(ctx, dir);
  if (rootConfig?.templates !== undefined) {
    // The bundled templates are the running version's, and all sites of a repo are on one version.
    const refusal = versionRefusal(
      [{ dir: '.', config: rootConfig }],
      [{ dir: '.', config: rootConfig }],
      options.plxVersion,
      'plx new',
    );
    if (refusal !== undefined) throw new Error(refusal);
  }
  // A nested site's answers are the root's resolved ones, the defaults of its templates included.
  const inherited =
    rootConfig && (await resolvedAnswers(root, { templates: rootConfig.templates ?? [], answers: rootConfig.answers }));
  const kind = inherited === undefined ? 'repo' : 'app';
  const given = Object.keys(options.answers);
  const doubled = given.filter((key) => inherited && Object.hasOwn(inherited, key));
  if (doubled.length > 0)
    throw new Error(
      `${doubled.map((key) => `\`${key}\``).join(', ')} ${doubled.length === 1 ? 'is' : 'are'} answered in the root marker already, and a key is answered in one marker only: leave it out`,
    );

  const { render, planMerge } = await engine();
  const trees = [];
  const manifests: Manifest[] = [];
  const unreadable: string[] = [];
  for (const name of options.templates)
    try {
      const template = await readTemplate(root, name);
      trees.push(template.tree);
      manifests.push(template.manifest);
    } catch (error) {
      unreadable.push((error as Error).message);
    }
  if (unreadable.length > 0) throw new Error(unreadable.join('\n'));
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

  // An answer a template reads and none owns is no resolved answer, and the site cannot be rendered again without it.
  const owned = new Set(manifests.flatMap((m) => m.questions.map((q) => q.name)));
  const read = new Set(manifests.flatMap((m) => m.reads.map((r) => r.name)));
  const reads = Object.fromEntries(Object.entries(options.answers).filter(([key]) => read.has(key) && !owned.has(key)));
  const frontmatter = {
    ...(kind === 'repo' ? { version: options.plxVersion } : {}),
    templates: [...options.templates],
    ...result.answers,
    ...reads,
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
  for (const [at, [command, ...args]] of birth.entries())
    try {
      await ctx.apply([run(command as string, args, { cwd: dir })]);
    } catch (error) {
      const left = birth.slice(at).map(([c, ...a]) => `  ${describe(run(c as string, a, { cwd: dir }))}`);
      throw new Error(
        `${(error as Error).message}\nthe files are written; run the commands still to do by hand, in order:\n${left.join('\n')}`,
      );
    }
  return {
    dir,
    kind,
    templates: options.templates,
    answers: { ...result.answers, ...reads },
    files: [...tree.keys()].sort(),
    birth,
    unused: result.unused.filter((key) => given.includes(key)),
    written,
  };
}
