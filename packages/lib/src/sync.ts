// sync: merge a render of each site's templates into the working tree. `apply`
// and `update` share everything but where the two sides come from, so this is
// the one place that renders, merges and writes defaults; a verb only decides
// which sites to take and what each side is.
//
// A site has two sides, the render it was last brought to (old) and the one it
// is being brought to (new). A side is either a `Source`, templates with the
// answers to render them with, or a `Rendered` tree that arrived already
// rendered, with its policies and the answers it resolved, as another
// version's `plx-template render` leaves them. The new side is always a
// source: its resolved answers are where the defaults of newly applicable
// questions come from.
//
// Each side's sources are rendered from that side's `Templates`: a root of
// templates, one directory each, rendered by this plx's engine, or by the
// side's own `render` where it brings one. `apply` gives one root to both
// sides, the templates this plx bundles; `update` gives each side the
// templates of its version and, for a version other than the running one, the
// render of that version's plx-template (versionTemplates.ts), so that a
// version's templates are only ever rendered by its own engine.
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
// wrote stays as it was. The root marker's `version` is written only when the
// caller gives one (`update`, never `apply`), and then in the root marker's
// one splice with its defaults, read when the plan is made: a write of its own
// before or after would be lost to the other. It is written whether or not the
// root renders anything or is merged, since every site of the repo moves to it.
//
// Performing a plan writes the merges, each site's in turn, then the markers.
// A conflicted path is left in the file between the engine's markers, or kept
// as it is where the template removed a file the user edited; either way the
// report says `conflicted` and the caller makes the verb fail on it.
//
// A key that the root's marker would receive as a default and that the template
// of any nested site of the repo declares, planned or not, or that a nested
// marker already answers, is refused before anything is written: it would
// stand in two markers, which no marker may do. The manifests are read from the
// new side's root; a nested site's template that cannot be read there is
// refused as well, since the check cannot be made without it. A render error is
// listed once, with the sides it came from.
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

/** A render of templates by name with answers, by another engine than this plx's: the render, or why there is none. */
export type RenderTemplates = (
  names: readonly string[],
  answers: Answers,
) => Promise<{ rendered?: Rendered; errors: readonly string[] }>;

/** Where one side's sources are rendered from: a root of templates, and the render of another engine where it is not this plx's. */
export interface Templates {
  /** The directory that holds one directory per template. */
  readonly root: string;
  /** Renders the templates below the root; default: this plx's engine. */
  readonly render?: RenderTemplates;
}

/** The templates of each side. */
export interface TemplateSides {
  readonly old: Templates;
  readonly new: Templates;
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
  /** The version to write into the root marker, which must be among the sites; none: the version is left as it is. */
  version?: string;
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

/** The render of a source with `templates`; its problems go to `errors`. */
async function renderSource(
  templates: Templates,
  dir: string,
  source: Source,
  label: string,
  errors: Errors,
): Promise<Rendered | undefined> {
  if (templates.render) {
    const { rendered, errors: found } = await templates.render(source.templates, source.answers);
    for (const e of found) errors.add(`${dir}: ${e}`, label);
    return found.length > 0 ? undefined : rendered;
  }
  const { render } = await engine();
  const trees = [];
  for (const name of source.templates) {
    try {
      trees.push((await readTemplate(templates.root, name)).tree);
    } catch (error) {
      errors.add(`${dir}: ${(error as Error).message}`, label);
    }
  }
  if (trees.length < source.templates.length) return undefined;
  const result = render(trees, source.answers);
  for (const e of result.errors) errors.add(describeError(dir, e), label);
  if (result.errors.length > 0) return undefined;
  return { tree: result.tree, policies: result.files, answers: result.answers };
}

/**
 * The merge of each of `sites` into the repo at `repo`, as the header says;
 * `templates` is the root of templates both sides are rendered from, or each
 * side's own.
 */
export async function planSync(
  ctx: Context,
  repo: string,
  templates: string | TemplateSides,
  sites: readonly SiteSides[],
  options: SyncOptions = {},
): Promise<SyncPlan> {
  const { planMerge } = await engine();
  const sides = typeof templates === 'string' ? { old: { root: templates }, new: { root: templates } } : templates;
  const labels = options.labels ?? { old: 'old side', new: 'new side' };
  const errors = new Errors();
  const rendered: { site: SiteSides; old: Rendered; new: Rendered; given: Answers }[] = [];
  let rootSides: { old: Rendered; new: Rendered } | undefined;
  for (const site of [...sites].sort((a, b) => Number(b.dir === '.') - Number(a.dir === '.'))) {
    const nested = site.dir !== '.';
    // A nested site's answers are the root's, resolved defaults included, plus its own.
    const old = isRendered(site.old)
      ? site.old
      : await renderSource(
          sides.old,
          site.dir,
          { ...site.old, answers: { ...(nested ? rootSides?.old.answers : {}), ...site.old.answers } },
          labels.old,
          errors,
        );
    const given = { ...(nested ? rootSides?.new.answers : {}), ...site.new.answers };
    const next = await renderSource(sides.new, site.dir, { ...site.new, answers: given }, labels.new, errors);
    if (!old || !next) continue;
    if (!nested) rootSides = { old, new: next };
    rendered.push({ site, old, new: next, given });
  }
  if (errors.any) throw new Error(errors.toString());

  const defaultsOf = ({ old, new: next, given }: (typeof rendered)[number]): Record<string, unknown> =>
    Object.fromEntries(Object.entries(next.answers).filter(([key]) => !(key in given) && !(key in old.answers)));
  const rootEntry = rendered.find((r) => r.site.dir === '.');
  const doubled = await doubledKeys(
    sides.new.root,
    rootEntry && { templates: rootEntry.site.new.templates, defaults: defaultsOf(rootEntry) },
    options.siblings ?? [],
  );
  if (doubled.length > 0) throw new Error(doubled.join('\n'));

  const merges: { dir: string; plan: MergePlan }[] = [];
  const markers: Plan = [];
  const planned: SiteMerge[] = [];
  if (options.version !== undefined && !rootEntry)
    throw new Error('the version goes into the root marker, and the root is not among the sites');
  for (const entry of rendered) {
    const { dir, contextOnly } = entry.site;
    const defaults = contextOnly ? {} : defaultsOf(entry);
    const keys = { ...defaults, ...(dir === '.' && options.version !== undefined ? { version: options.version } : {}) };
    if (Object.keys(keys).length > 0) {
      const path = join(repo, dir, MARKER_FILE);
      markers.push(write(path, setMarkerKeys(await ctx.readFile(path), keys)));
    }
    if (contextOnly) continue;
    const plan = await planMerge(join(repo, dir), entry.old, entry.new);
    merges.push({ dir, plan });
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

/**
 * The refusals for a root default that would stand in two markers: a nested
 * site declares it, or answers it. A nested site's template that cannot be
 * read is refused too, since whether it declares the key cannot be told: a
 * check that cannot be made is not passed. Where the nested site is rendered
 * as well, its render reports the template first; one that is not rendered, or
 * whose manifest only this plx cannot read (another version's), meets it here.
 */
async function doubledKeys(
  root: string,
  rootSide: { templates: readonly string[]; defaults: Record<string, unknown> } | undefined,
  siblings: NonNullable<SyncOptions['siblings']>,
): Promise<string[]> {
  if (!rootSide) return [];
  const lines: string[] = [];
  const fix = 'a key is answered in one marker only: answer it in the root marker and remove it from the nested one';
  const questionsOf = async (name: string): Promise<string[] | Error> =>
    loadTemplate(root, name).then(
      (manifest) => manifest.questions.map((q) => q.name),
      (error: Error) => error,
    );
  for (const key of Object.keys(rootSide.defaults)) {
    let rootTemplate: string | undefined;
    for (const name of rootSide.templates) {
      const questions = await questionsOf(name);
      if (!rootTemplate && Array.isArray(questions) && questions.includes(key)) rootTemplate = name;
    }
    const where = `${MARKER_FILE} would get \`${key}\` as the default of template ${rootTemplate}`;
    for (const { dir, templates, answers } of siblings) {
      const marker = join(dir, MARKER_FILE);
      for (const name of templates) {
        const questions = await questionsOf(name);
        if (questions instanceof Error)
          lines.push(
            `${where}, and template ${name} of ${marker} cannot be read, so whether it declares it too cannot be told: ${questions.message}`,
          );
        else if (questions.includes(key))
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
  const side = await renderSource({ root }, '.', source, '', new Errors());
  return { ...source.answers, ...side?.answers };
}
