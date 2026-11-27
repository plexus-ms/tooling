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
// The root is rendered first, whatever the order given, and what it resolved,
// its defaults included, is a root answer: a nested site's answers are the
// root marker's plus its own (§ 5), so the nested renders are given the
// root's resolved answers on each side. Where the root's resolved answer and a
// nested marker's own meet on one key, a state only a human can have written
// (a root default is never written beside one), the nested marker's own answer
// wins: an answer a person wrote is not overridden by a default nobody wrote.
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
//
// A key that the root's marker would receive as a default and that the template
// of any nested site of the repo declares, planned or not, or that a nested
// marker already answers, is refused before anything is written: it would
// stand in two markers, which no marker may do. A render error is listed once, with the sides it came from.
import { join } from 'node:path';
import type { Answers, MergeEntry, MergePlan, RenderError, RenderedSide } from '@plexus-ms/cli-template';
import { loadTemplate, readTemplate } from './bundled.ts';
import type { Context } from './context.ts';
import { type Plan, write } from './effects.ts';
import { engine } from './engine.ts';
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
  /** Render the site for what it gives the nested sites, and merge nothing into it. */
  readonly contextOnly?: boolean;
}

export interface SyncOptions {
  /** What the old and the new side are called in an error. */
  labels?: { old: string; new: string };
  /** Every nested site of the repo, the ones not planned included: its templates and its marker's own answers. */
  siblings?: readonly { dir: string; templates: readonly string[]; answers: Answers }[];
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

/** A render, with the questions each of its templates declares. */
interface Side extends Rendered {
  readonly declared: ReadonlyMap<string, readonly string[]>;
}

const isRendered = (side: Source | Rendered): side is Rendered => 'tree' in side;

/** An error as a line naming the site and what it concerns. */
const describeError = (dir: string, e: RenderError): string => {
  const about = [e.template && `template ${e.template}`, e.path, e.question && `question ${e.question}`].filter(
    Boolean,
  );
  return `${dir}: ${e.message}${about.length > 0 ? ` (${about.join(', ')})` : ''}`;
};

/** Errors by line, each with the sides it came from, so that one found on both is listed once. */
class Errors {
  readonly lines = new Map<string, Set<string>>();
  add(line: string, label: string): void {
    this.lines.set(line, (this.lines.get(line) ?? new Set()).add(label));
  }
  get any(): boolean {
    return this.lines.size > 0;
  }
  toString(): string {
    return [...this.lines].map(([line, labels]) => `${line} [${[...labels].join(' and ')}]`).join('\n');
  }
}

/** The render of a source with the templates below `root`; its problems go to `errors`. */
async function renderSource(
  root: string,
  dir: string,
  source: Source,
  label: string,
  errors: Errors,
): Promise<Side | undefined> {
  const { render } = await engine();
  const trees = [];
  const declared = new Map<string, readonly string[]>();
  for (const name of source.templates) {
    try {
      const template = await readTemplate(root, name);
      trees.push(template.tree);
      declared.set(
        name,
        template.manifest.questions.map((q) => q.name),
      );
    } catch (error) {
      errors.add(`${dir}: ${(error as Error).message}`, label);
    }
  }
  if (trees.length < source.templates.length) return undefined;
  const result = render(trees, source.answers);
  for (const e of result.errors) errors.add(describeError(dir, e), label);
  if (result.errors.length > 0) return undefined;
  return { tree: result.tree, policies: result.files, answers: result.answers, declared };
}

/** The merge of each of `sites` into the repo at `repo`, as the header says; the templates are below `root`. */
export async function planSync(
  ctx: Context,
  repo: string,
  root: string,
  sites: readonly SiteSides[],
  options: SyncOptions = {},
): Promise<SyncPlan> {
  const { planMerge } = await engine();
  const labels = options.labels ?? { old: 'old side', new: 'new side' };
  const errors = new Errors();
  const rendered: { site: SiteSides; old: Side; new: Side; given: Answers }[] = [];
  let rootSides: { old: Side; new: Side } | undefined;
  for (const site of [...sites].sort((a, b) => Number(b.dir === '.') - Number(a.dir === '.'))) {
    const nested = site.dir !== '.';
    // A nested site's answers are the root's, resolved defaults included, plus its own.
    const old = isRendered(site.old)
      ? { ...site.old, declared: new Map<string, readonly string[]>() }
      : await renderSource(
          root,
          site.dir,
          { ...site.old, answers: { ...(nested ? rootSides?.old.answers : {}), ...site.old.answers } },
          labels.old,
          errors,
        );
    const given = { ...(nested ? rootSides?.new.answers : {}), ...site.new.answers };
    const next = await renderSource(root, site.dir, { ...site.new, answers: given }, labels.new, errors);
    if (!old || !next) continue;
    if (!nested) rootSides = { old, new: next };
    rendered.push({ site, old, new: next, given });
  }
  if (errors.any) throw new Error(errors.toString());

  const defaultsOf = ({ old, new: next, given }: (typeof rendered)[number]): Record<string, unknown> =>
    Object.fromEntries(Object.entries(next.answers).filter(([key]) => !(key in given) && !(key in old.answers)));
  const rootEntry = rendered.find((r) => r.site.dir === '.');
  const doubled = await doubledKeys(
    root,
    rootEntry && { declared: rootEntry.new.declared, defaults: defaultsOf(rootEntry) },
    options.siblings ?? [],
  );
  if (doubled.length > 0) throw new Error(doubled.join('\n'));

  const merges: { dir: string; plan: MergePlan }[] = [];
  const markers: Plan = [];
  const planned: SiteMerge[] = [];
  for (const entry of rendered) {
    if (entry.site.contextOnly) continue;
    const { dir } = entry.site;
    const plan = await planMerge(join(repo, dir), entry.old, entry.new);
    merges.push({ dir, plan });
    const defaults = defaultsOf(entry);
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

/** The refusals for a root default that would stand in two markers: a nested site declares it, or answers it. */
async function doubledKeys(
  root: string,
  rootSide: { declared: ReadonlyMap<string, readonly string[]>; defaults: Record<string, unknown> } | undefined,
  siblings: NonNullable<SyncOptions['siblings']>,
): Promise<string[]> {
  if (!rootSide) return [];
  const lines: string[] = [];
  const fix = 'a key is answered in one marker only: answer it in the root marker and remove it from the nested one';
  for (const key of Object.keys(rootSide.defaults)) {
    const rootTemplate = [...rootSide.declared].find(([, questions]) => questions.includes(key))?.[0];
    const where = `${MARKER_FILE} would get \`${key}\` as the default of template ${rootTemplate}`;
    for (const { dir, templates, answers } of siblings) {
      const marker = join(dir, MARKER_FILE);
      for (const name of templates) {
        // A template that cannot be loaded is the render's error to report.
        const manifest = await loadTemplate(root, name).catch(() => undefined);
        if (manifest?.questions.some((q) => q.name === key))
          lines.push(`${where}, and template ${name} of ${marker} declares it too: ${fix}`);
      }
      if (key in answers) lines.push(`${where}, and ${marker} answers it already: ${fix}`);
    }
  }
  return lines;
}

/**
 * The answers a site's templates resolve to, with the given answers under
 * them: what a nested site reads of the root. A render that fails gives the
 * given answers alone; the error is the plan's to report.
 */
export async function resolvedAnswers(root: string, source: Source): Promise<Answers> {
  const side = await renderSource(root, '.', source, '', new Errors());
  return { ...source.answers, ...side?.answers };
}
