// sync: merge a render of each site's templates into the working tree. `apply`
// and `update` share everything but where the two sides come from, so this is
// the one place that renders, merges and writes defaults; a verb only decides
// which sites to take and what each side is.
//
// A site has two sides, the render it was last brought to (old) and the one it
// is being brought to (new). A side is either a `Source`, templates with the
// answers to render them with, rendered here from a root of templates, or a
// `Rendered` tree that arrived already rendered, with its policies and the
// answers it resolved, as another version's `plx-template render` leaves them.
// The new side is always a source: its resolved answers are where the
// defaults of newly applicable questions come from.
//
// Planning reads and renders, and writes nothing: every site is rendered
// before any is merged, and every render error of every site is reported
// together, so that a failure costs nothing. Each site's merge is then
// planned by the engine (`planMerge`) against the site's directory in the
// working tree; a site's old and new tree are relative to that directory.
// A site is planned in the order given, which is the root first.
//
// A default is written to a site's marker when the question is applicable on
// the new side and was not on the old one (a template added, a `when` that
// became true) and the marker's answers, the root's included, do not give it.
// The write splices the marker's text (`setMarkerKeys`), so everything a human
// wrote stays as it was; the root marker's `version` is never touched here.
//
// Performing a plan writes the merges, each site's in turn, then the markers.
// A conflicted path is left in the file between the engine's markers, or kept
// as it is where the template removed a file the user edited; either way the
// report says `conflicted` and the caller makes the verb fail on it.
import { join } from 'node:path';
import {
  type Answers,
  type MergeEntry,
  type MergePlan,
  planMerge,
  type RenderError,
  type RenderedSide,
  readTree,
  render,
  type Tree,
} from '@plexus-ms/cli-template';
import { templateDirectory } from './bundled.ts';
import type { Context } from './context.ts';
import { type Plan, write } from './effects.ts';
import { MARKER_FILE, setMarkerKeys } from './marker.ts';

/** Templates, by name below a root, and the answers to render them with. */
export interface Source {
  readonly templates: readonly string[];
  readonly answers: Answers;
}

/** A render that arrived as a tree: its policies, and the answers it resolved. */
export interface Rendered extends RenderedSide {
  readonly answers: Answers;
}

export interface SiteSides {
  /** The site's directory relative to the repo, `.` for the root. */
  readonly dir: string;
  readonly old: Source | Rendered;
  readonly new: Source;
}

/** What planning decided for one site. */
export interface SiteMerge {
  dir: string;
  report: readonly MergeEntry[];
  /** The answers to write into the site's marker. */
  defaults: Record<string, unknown>;
}

export interface SyncPlan {
  sites: SiteMerge[];
  /** The paths reported `conflicted`, over all sites. */
  conflicted: number;
  /** Writes the merges and the markers; narrated, and skipped under --dry-run. */
  perform(): Promise<void>;
}

const isRendered = (side: Source | Rendered): side is Rendered => 'tree' in side;

/** Every error as a line naming the site and what it concerns. */
const describeError = (dir: string, e: RenderError): string => {
  const about = [e.template && `template ${e.template}`, e.path, e.question && `question ${e.question}`].filter(
    Boolean,
  );
  return `${dir}: ${e.message}${about.length > 0 ? ` (${about.join(', ')})` : ''}`;
};

/** The render of a source with the templates below `root`; its problems go to `errors`. */
async function renderSource(
  root: string,
  dir: string,
  source: Source,
  errors: string[],
): Promise<Rendered | undefined> {
  if (source.templates.length === 0) return { tree: new Map(), policies: new Map(), answers: {} };
  const trees: Tree[] = [];
  for (const name of source.templates) {
    try {
      trees.push(await readTree(await templateDirectory(root, name)));
    } catch (error) {
      errors.push(`${dir}: ${(error as Error).message}`);
    }
  }
  if (trees.length < source.templates.length) return undefined;
  const result = render(trees, source.answers);
  errors.push(...result.errors.map((e) => describeError(dir, e)));
  return result.errors.length > 0 ? undefined : { tree: result.tree, policies: result.files, answers: result.answers };
}

/** The merge of each of `sites` into the repo at `repo`, as the header says; the templates are below `root`. */
export async function planSync(
  ctx: Context,
  repo: string,
  root: string,
  sites: readonly SiteSides[],
): Promise<SyncPlan> {
  const errors: string[] = [];
  const rendered: { dir: string; old: Rendered; new: Rendered; given: Answers }[] = [];
  for (const site of sites) {
    const old = isRendered(site.old) ? site.old : await renderSource(root, site.dir, site.old, errors);
    const next = await renderSource(root, site.dir, site.new, errors);
    if (old && next) rendered.push({ dir: site.dir, old, new: next, given: site.new.answers });
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));

  const merges: { dir: string; plan: MergePlan }[] = [];
  const markers: Plan = [];
  const planned: SiteMerge[] = [];
  for (const { dir, old, new: next, given } of rendered) {
    const plan = await planMerge(join(repo, dir), old, next);
    merges.push({ dir, plan });
    const defaults = Object.fromEntries(
      Object.entries(next.answers).filter(([key]) => !(key in given) && !(key in old.answers)),
    );
    if (Object.keys(defaults).length > 0) {
      const path = join(repo, dir, MARKER_FILE);
      markers.push(write(path, setMarkerKeys(await ctx.readFile(path), defaults)));
    }
    planned.push({ dir, report: plan.report, defaults });
  }
  return {
    sites: planned,
    conflicted: planned.flatMap((s) => s.report).filter((e) => e.outcome === 'conflicted').length,
    async perform() {
      for (const { dir, plan } of merges) {
        for (const { path, outcome } of plan.report)
          ctx.say(`${ctx.dryRun ? '[dry-run] ' : ''}${outcome} ${join(dir, path)}`);
        if (!ctx.dryRun) await plan.apply();
      }
      await ctx.apply(markers);
    },
  };
}
