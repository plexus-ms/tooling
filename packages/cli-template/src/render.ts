// render: templates and answers to one tree, and the result that describes it
// (types.ts states the shapes). It runs in three passes over the templates, so
// that each pass can see what the one before produced for all of them:
//
//   1. read each template: its manifest and its files (manifest.ts)
//   2. resolve each template's questions against the given answers
//      (questions.ts), in the scope `scopeOf` builds
//   3. render each template's files (files.ts) in the context `contextOf`
//      builds, and give each path its owner and policy
//
// Every step adds what it finds wrong to one list of errors and carries on, so
// that one render reports them all; a render with errors returns no files.
//
// For now the scope is empty and the context is a template's own answers, so
// several templates render one after the other into the same tree, each seeing
// only the answers to its own questions.
import { renderFiles } from './files.ts';
import type { Context } from './jinja.ts';
import { MANIFEST, readTemplate, type Template } from './manifest.ts';
import { type Resolution, resolveAnswers, unusedAnswers } from './questions.ts';
import type { Answers, BirthCommand, Entry, Origin, RenderError, RenderResult, Tree } from './types.ts';

/** The tree `templates` render with the `given` answers, and what it is made of. */
export function render(templates: readonly Tree[], given: Answers): RenderResult {
  const errors: RenderError[] = [];
  const read = readAll(templates, errors);
  const owners = ownersOf(read, errors);
  const engine = engineVariables(read);
  const resolved = new Map<Template, Resolved>();
  for (const template of resolutionOrder(read, owners, errors)) {
    const own: RenderError[] = [];
    const reads = readsOf(template, owners, resolved, given, own);
    const scope = scopeOf(engine, reads.values);
    const resolution = resolveAnswers(template.manifest, given, scope, own);
    errors.push(...own);
    const unresolved = new Set(own.flatMap(({ question }) => question ?? []));
    resolved.set(template, { scope, resolution, unresolved, failed: own.length > 0 || !reads.complete });
  }

  const renderings = read.flatMap((template) => {
    const done = resolved.get(template);
    return done === undefined || done.failed ? [] : [{ template, context: contextOf(done.scope, done.resolution) }];
  });
  const tree = new Map<string, Entry>();
  const files = new Map<string, Origin>();
  for (const [path, { entry, source, owner }] of renderFiles(renderings, errors)) {
    tree.set(path, entry);
    files.set(path, { template: owner.manifest.name, policy: owner.manifest.policies.get(source) ?? 'merge' });
  }
  const birth: BirthCommand[] = read.flatMap(({ manifest }) =>
    manifest.birth.map((command) => ({ template: manifest.name, command })),
  );

  const answers: Answers = Object.assign({}, ...read.map((template) => resolved.get(template)?.resolution.answers));
  const unused = unusedAnswers(
    read.map(({ manifest }) => manifest),
    given,
  );
  if (errors.length > 0) return { tree: new Map(), answers, unused, files: new Map(), birth: [], errors };
  return { tree, answers, unused, files, birth, errors };
}

/** The templates read, in the order given; a template named like one before it is an error and is left out. */
function readAll(templates: readonly Tree[], errors: RenderError[]): Template[] {
  const positions = new Map<string, number>();
  return templates.flatMap((tree, i) => {
    const template = readTemplate(tree, i + 1, errors);
    if (template === undefined) return [];
    const { name } = template.manifest;
    const first = positions.get(name);
    if (first === undefined) {
      positions.set(name, i + 1);
      return [template];
    }
    const message = `templates ${first} and ${i + 1} are both named ${name}`;
    errors.push({ template: name, other: name, path: MANIFEST, message });
    return [];
  });
}

/** A template's questions resolved, the scope they were resolved in, and what failed. */
interface Resolved {
  readonly scope: Context;
  readonly resolution: Resolution;
  /** The questions and reads whose resolution failed. */
  readonly unresolved: ReadonlySet<string>;
  /** Whether any read or question failed, its own or an owner's: its files are not rendered. */
  readonly failed: boolean;
}

/**
 * The templates in the order they resolve: each after the owners of the answers
 * it reads, else in the order given. Templates whose reads form a cycle are an
 * error naming them, and are left out with every template that reads from them.
 */
function resolutionOrder(
  read: readonly Template[],
  owners: ReadonlyMap<string, Template>,
  errors: RenderError[],
): Template[] {
  /** The reads of `template` that another template owns, each with its owner. */
  const edges = (template: Template) =>
    template.manifest.reads.flatMap(({ name }) => {
      const owner = owners.get(name);
      return owner === undefined ? [] : [{ name, owner }];
    });
  const order: Template[] = [];
  const pending = [...read];
  for (;;) {
    const next = pending.findIndex((template) => edges(template).every(({ owner }) => order.includes(owner)));
    if (next === -1) break;
    order.push(...pending.splice(next, 1));
  }
  // Each pending template reads from another pending one. Following those
  // reads from each leads into a cycle, which is reported the first time a
  // walk meets it.
  const walked = new Set<Template>();
  for (const start of pending) {
    const walk: Template[] = [];
    let at: Template | undefined = start;
    while (at !== undefined && !walked.has(at)) {
      walked.add(at);
      walk.push(at);
      at = edges(at).find(({ owner }) => pending.includes(owner))?.owner;
    }
    if (at === undefined || !walk.includes(at)) continue;
    const cycle = walk.slice(walk.indexOf(at));
    const first = cycle.reduce((a, b) => (read.indexOf(b) < read.indexOf(a) ? b : a));
    const ordered = [...cycle.slice(cycle.indexOf(first)), ...cycle.slice(0, cycle.indexOf(first))];
    const names = ordered.map(({ manifest }) => manifest.name);
    const steps = ordered.map((template, i) => {
      const owner = ordered[(i + 1) % ordered.length];
      const name = edges(template).find((edge) => edge.owner === owner)?.name;
      return `${template.manifest.name} reads ${name} from ${owner?.manifest.name}`;
    });
    const listed = `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    errors.push({
      template: names[0],
      other: names[1],
      path: MANIFEST,
      message: `the reads of ${listed} form a cycle: ${steps.join(', ')}`,
    });
  }
  return order;
}

/** The template that declares each question; a question two templates declare is an error naming both. */
function ownersOf(read: readonly Template[], errors: RenderError[]): Map<string, Template> {
  const owners = new Map<string, Template>();
  for (const template of read) {
    for (const { name } of template.manifest.questions) {
      const first = owners.get(name);
      if (first === undefined) owners.set(name, template);
      else
        errors.push({
          template: first.manifest.name,
          other: template.manifest.name,
          path: MANIFEST,
          question: name,
          message: `${first.manifest.name} and ${template.manifest.name} both declare the question ${name}`,
        });
    }
  }
  return owners;
}

/**
 * The value of each answer `template` reads: what its owner resolved, else the
 * given answer, else the read's default; a read that nothing supplies is an error,
 * naming the owner where its owner skipped the question. A read whose owner failed to resolve it has no value and adds no error, the
 * owner's being the one; `complete` is false where a read has no value.
 */
function readsOf(
  template: Template,
  owners: ReadonlyMap<string, Template>,
  resolved: ReadonlyMap<Template, Resolved>,
  given: Answers,
  errors: RenderError[],
): { values: Context; complete: boolean } {
  const values: Context = {};
  let complete = true;
  for (const read of template.manifest.reads) {
    const owner = owners.get(read.name);
    const done = owner === undefined ? undefined : resolved.get(owner);
    const owned = done?.resolution.context ?? {};
    if (done?.unresolved.has(read.name)) complete = false;
    else if (Object.hasOwn(owned, read.name)) values[read.name] = owned[read.name];
    else if (Object.hasOwn(given, read.name)) values[read.name] = given[read.name];
    else if (Object.hasOwn(read, 'default')) values[read.name] = read.default;
    else {
      complete = false;
      const name = template.manifest.name;
      const error = { template: name, path: MANIFEST, question: read.name };
      if (owner === undefined)
        errors.push({
          ...error,
          message: `${name} reads ${read.name}, which no template of the render owns and no answer gives`,
        });
      else {
        const other = owner.manifest.name;
        errors.push({
          ...error,
          other,
          message: `${name} reads ${read.name}, which ${other} owns and skips without a default`,
        });
      }
    }
  }
  return { values, complete };
}

/** The engine's variables, the same for every template of a render. */
function engineVariables(read: readonly Template[]): Context {
  return { _templates: read.map(({ manifest }) => manifest.name).sort() };
}

/** What a template's questions see besides its own earlier answers: the engine's variables and the answers it reads. */
function scopeOf(engine: Context, reads: Context): Context {
  return { ...engine, ...reads };
}

/** What a template's files render with: its scope and its own answers. */
function contextOf(scope: Context, resolution: Resolution): Context {
  return { ...scope, ...resolution.context };
}
