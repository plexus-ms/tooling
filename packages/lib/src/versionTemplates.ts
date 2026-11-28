// The templates of a Plexus version, and the engine that renders them: one side
// of `plx update` (update.ts), which renders the tree a repo's sites were last
// brought to with the templates of the version it is on, and the tree it is
// brought to with those of the version it takes (Decisions § 6 of the template
// composition). A version's templates are only ever rendered by that version's
// own plx-template, so that an engine change can never pass for a template
// change.
//
// The running version is the plx that runs: its templates are the ones it
// bundles (`templatesRoot()`), rendered by its own engine in this process, and
// nothing is fetched. Any other version is fetched from the npm registry: its
// `@plexus-ms/cli`, installed into a scratch directory with npm (`npm install
// --prefix <dir> @plexus-ms/cli@<version>`), brings the templates it bundles
// (`dist/templates`) and, as its dependency at the same version,
// `@plexus-ms/cli-template`, whose `plx-template` is run with the node that
// runs plx: `plx-template render --answers - <out> <template-dir>...`. Its
// render is read back with the policies file beside it (`readRender` of this
// plx's engine), and its resolved answers from what it prints. npm runs in the
// scratch directory, so the repo's own npm settings do not apply and the
// user's and the machine's do (a mirror, a proxy); install scripts are not run.
// A version is fetched once per run of a repo and rendered once per site and
// side.
//
// Every failure is loud: a version that cannot be fetched, a package that
// bundles no templates (a version before the engine), a plx-template that
// cannot run, is an error naming the version, never a render that changed
// nothing. A render that the version's plx-template refuses (an answer
// missing, a template error) is no failure of the run's own: its errors are
// returned, as this plx's engine returns its own, for the caller to list with
// the site and the side.
import { join } from 'node:path';
import type { Answers } from '@plexus-ms/cli-template';
import type { Context } from './context.ts';
import { run } from './effects.ts';
import { engine } from './engine.ts';
import { detailOf, ExecError } from './io.ts';
import { RESERVED_KEYS } from './marker.ts';
import type { RenderTemplates, Templates } from './sync.ts';
import { isDirectory, templatesRoot } from './templatesRoot.ts';

/** What fetching a version brings: its plx-template, a script for node, and the root of the templates it bundles. */
export interface Fetched {
  readonly plxTemplate: string;
  readonly templates: string;
}

/** Fetches the version into the directory `into`, which the caller owns; rejects, saying why, where it cannot. */
export type FetchVersion = (ctx: Context, version: string, into: string) => Promise<Fetched>;

export interface VersionOptions {
  /** The version of the running plx. */
  plxVersion: string;
  /** The templates this plx bundles; default `templatesRoot()`. */
  bundled?: string;
  /** How another version is fetched; default `fromRegistry`. */
  fetch?: FetchVersion;
  /** A directory the caller owns and removes, for what is fetched and rendered. */
  scratch: string;
}

/** The package that bundles the templates and depends on the engine at the same version. */
const CLI = '@plexus-ms/cli';
const ENGINE = '@plexus-ms/cli-template';

/** The templates of `version`, and how they are rendered, as the header says. */
export async function templatesOf(ctx: Context, version: string, options: VersionOptions): Promise<Templates> {
  if (version === options.plxVersion) return { root: options.bundled ?? templatesRoot() };
  const into = join(options.scratch, version);
  let fetched: Fetched;
  try {
    fetched = await (options.fetch ?? fromRegistry)(ctx, version, into);
  } catch (error) {
    throw new Error(`cannot take the templates of ${version}: ${(error as Error).message}`);
  }
  return {
    root: fetched.templates,
    render: renderBy(ctx, version, fetched, join(options.scratch, `${version}-renders`)),
  };
}

/** The render of another version's plx-template, each into a directory of its own below `renders`. */
function renderBy(ctx: Context, version: string, fetched: Fetched, renders: string): RenderTemplates {
  let count = 0;
  return async (names, answers) => {
    const out = join(renders, String(count++));
    const args = [
      fetched.plxTemplate,
      'render',
      '--answers',
      '-',
      out,
      ...names.map((n) => join(fetched.templates, n)),
    ];
    let printed: string;
    try {
      printed = (await ctx.stage(run(process.execPath, args, { input: JSON.stringify(answers) }))) ?? '';
    } catch (error) {
      // 3: the inputs are wrong, and each error is a line on standard error.
      if (error instanceof ExecError && error.code === 3) return { errors: renderErrors(error.stderr) };
      throw new Error(`the plx-template of ${version} failed: ${detailOf(error) || (error as Error).message}`);
    }
    let resolved: Answers;
    try {
      resolved = (JSON.parse(printed) as { answers: Answers }).answers;
    } catch {
      throw new Error(`the plx-template of ${version} printed no JSON`);
    }
    const reserved = RESERVED_KEYS.filter((key) => key in resolved);
    if (reserved.length > 0)
      return {
        errors: reserved.map((key) => `a template of ${version} declares \`${key}\`, a key of the marker`),
      };
    const { readRender } = await engine();
    return { rendered: { ...(await readRender(out)), answers: resolved }, errors: [] };
  };
}

/** The errors a refused render repeats on standard error, one a line. */
function renderErrors(stderr: string): string[] {
  const prefix = 'plx-template: error: ';
  const lines = stderr.split('\n').filter((l) => l.startsWith(prefix));
  return lines.length > 0 ? lines.map((l) => l.slice(prefix.length)) : [stderr.trim() || 'refused'];
}

/** The version's `@plexus-ms/cli` from the npm registry, installed below `into`, as the header says. */
export const fromRegistry: FetchVersion = async (ctx, version, into) => {
  const spec = `${CLI}@${version}`;
  try {
    await ctx.stage(
      run(
        'npm',
        [
          'install',
          '--prefix',
          into,
          '--no-save',
          '--no-package-lock',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--loglevel=error',
          spec,
        ],
        { cwd: await made(ctx, into) },
      ),
    );
  } catch (error) {
    throw new Error(`cannot fetch ${spec} from the registry: ${detailOf(error) || (error as Error).message}`);
  }
  const modules = join(into, 'node_modules');
  const templates = join(modules, CLI, 'dist', 'templates');
  if (!isDirectory(templates))
    throw new Error(`${spec} bundles no templates: ${version} predates plx-template, and is taken with copier`);
  let bin: unknown;
  try {
    bin = (JSON.parse(await ctx.readFile(join(modules, ENGINE, 'package.json'))) as { bin?: Record<string, unknown> })
      .bin?.['plx-template'];
  } catch (error) {
    throw new Error(`${spec} came without ${ENGINE}: ${(error as Error).message}`);
  }
  if (typeof bin !== 'string') throw new Error(`${ENGINE} of ${version} names no plx-template`);
  return { plxTemplate: join(modules, ENGINE, bin), templates };
};

/** The directory `dir`, made where it is missing. */
async function made(ctx: Context, dir: string): Promise<string> {
  await ctx.stage(run('mkdir', ['-p', dir]));
  return dir;
}
