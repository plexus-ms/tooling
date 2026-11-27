// render: templates and answers to one tree, and the result that describes it
// (types.ts states the shapes). It runs in three passes over the templates, so
// that each pass can see what the one before produced for all of them:
//
//   1. read each template: its manifest and its files (manifest.ts)
//   2. resolve each template's reads and questions against the given answers
//      (questions.ts), in the scope `scopeOf` builds
//   3. render the files of all templates together (files.ts), each template's
//      in the context `contextOf` builds, and give each path its owner and
//      policy
//
// Every step adds what it finds wrong to one list of errors and carries on, so
// that one render reports them all; a render with errors returns no files.
//
// The rules of composing several templates into one tree:
//
// Templates. Each template has a name of its own: two templates of one name
// are an error naming both by their position in the list, and the second is
// left out.
//
// Answers. The given answers are one flat namespace for the whole render. Each
// question is declared by exactly one template, its owner: two templates
// declaring the same question are an error naming both, and the one whose name
// sorts first owns it for the templates that read it. A template takes the
// given answers to its own questions, and declares as reads the answers it
// uses but does not own.
//
// Reads. The value of a read is what its owner in the render resolved, cast
// to the owner's type; else the given answer, as it is given, which is how a
// caller passes an answer that no template of the render owns; else the read's
// default from the manifest. A supplied value always wins over the default.
// A read without a default that nothing supplies is an error naming the
// template and the read. A read sees what its owner's files see: where the
// owner's `when` skips the question, that is the owner's given answer or
// default, and where the owner has neither, the read falls to its own default,
// and without one it is an error naming the owner as well.
//
// Order. A template is resolved after the owners of the answers it reads, and
// otherwise by name, so that the order of the templates does not change the
// tree; there are no dependencies between templates besides their
// reads. Templates whose reads form a cycle, and the templates that read from
// them, are one error naming them all by name, and none of them is resolved.
//
// Scope. A template sees only its own slice of the namespace: the engine's
// variables, its declared reads, and its own questions. Its questions'
// defaults, `when`, choices and validators see the scope (the engine's
// variables and its reads) and its own answers as questions.ts states; its
// file names and contents see the scope and its own answers. A variable
// outside the slice is undefined, which is an error wherever it is used, even
// when another template of the render owns it.
//
// Engine variables. Their names start with `_`, which the manifest reader
// forbids for questions and reads. There is one: `_templates`, the names of
// the templates rendered together, sorted by name so that it does not depend
// on the order given, for a file that is written only when another template
// is present (`{% if 'shelf' in _templates %}`).
//
// One cause, one error. A template whose read or question fails renders no
// files, since every file that uses the failed variable would add an error of
// its own; its other files are checked by the render that follows the fix. A
// read of a question whose owner failed to resolve it has no value and adds no
// error, and the reader renders no files; the reader's own questions are still
// resolved, so that every missing answer is listed, and one that uses that
// read reports it as undefined. Where a template of the render failed to read,
// whether its manifest is wrong or its name is taken, what it owns is unknown:
// a read that nothing supplies then adds no error of its own either, and the
// reader renders no files.
//
// Paths. Each path is written by exactly one template; files.ts checks it
// across the templates where it checks it within one. The result names each
// path's owner and policy, and lists the birth commands of each template in
// the order the templates were given, which `render` does not run.
//
// Unused answers. A given answer that no template owns or reads is listed as
// unused and is no error: a caller may pass more than one render needs.
import { renderFiles } from './files.ts';
import type { Context } from './jinja.ts';
import { MANIFEST, readTemplate, type Template } from './manifest.ts';
import { type Resolution, resolveAnswers, unusedAnswers } from './questions.ts';
import type { Answers, BirthCommand, Entry, Origin, RenderError, RenderResult, Tree } from './types.ts';

/** The tree `templates` render with the `given` answers, and what it is made of. */
export function render(templates: readonly Tree[], given: Answers): RenderResult {
  const errors: RenderError[] = [];
  // In the order given for the birth commands, and by name for everything else.
  const listed = readAll(templates, errors);
  const read = listed.toSorted((a, b) => (a.manifest.name < b.manifest.name ? -1 : 1));
  const owners = ownersOf(read, errors);
  const engine = engineVariables(read);
  const resolved = new Map<Template, Resolved>();
  for (const template of resolutionOrder(read, owners, errors)) {
    const own: RenderError[] = [];
    const reads = readsOf(template, owners, resolved, listed.length < templates.length, given, own);
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
  const birth: BirthCommand[] = listed.flatMap(({ manifest }) =>
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
 * it reads, else in the order of `read`. The templates left over each read from
 * another left over, in a cycle or from one; they are one error naming them
 * all, and none of them is resolved.
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
  if (pending.length === 0) return order;
  const left = pending.toSorted((a, b) => (a.manifest.name < b.manifest.name ? -1 : 1));
  const names = left.map(({ manifest }) => manifest.name);
  const waits = left.flatMap((template) =>
    edges(template)
      .filter(({ owner }) => pending.includes(owner))
      .map(({ name, owner }) => `${template.manifest.name} reads ${name} from ${owner.manifest.name}`),
  );
  const listed = `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const message = `the reads of ${listed} wait on each other: ${waits.join(', ')}`;
  errors.push({ template: names[0], other: names[1], path: MANIFEST, message });
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
 * given answer, else the read's default. A read that nothing supplies is an
 * error, naming the owner where the owner skipped the question. A read adds no
 * error where the error is another's: where its owner failed to resolve it, or
 * where it has no owner and a template of the render failed to read (`unread`),
 * which may have owned it. `complete` is false where a read has no value.
 */
function readsOf(
  template: Template,
  owners: ReadonlyMap<string, Template>,
  resolved: ReadonlyMap<Template, Resolved>,
  unread: boolean,
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
      if (owner !== undefined) {
        const other = owner.manifest.name;
        const message = `${name} reads ${read.name}, which ${other} owns and skips without a default`;
        errors.push({ ...error, other, message });
      } else if (!unread) {
        const message = `${name} reads ${read.name}, which no template of the render owns and no answer gives`;
        errors.push({ ...error, message });
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
