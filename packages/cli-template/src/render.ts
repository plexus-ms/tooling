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
  const resolutions = new Map<Template, Resolution>();
  const resolved = read.map((template) => {
    const scope = scopeOf(readsOf(template, owners, resolutions, given, errors));
    const resolution = resolveAnswers(template.manifest, given, scope, errors);
    resolutions.set(template, resolution);
    return { template, scope, resolution };
  });

  const tree = new Map<string, Entry>();
  const files = new Map<string, Origin>();
  const birth: BirthCommand[] = [];
  for (const { template, scope, resolution } of resolved) {
    const { name, policies } = template.manifest;
    for (const [path, { entry, source }] of renderFiles(template, contextOf(scope, resolution), errors)) {
      tree.set(path, entry);
      files.set(path, { template: name, policy: policies.get(source) ?? 'merge' });
    }
    birth.push(...template.manifest.birth.map((command) => ({ template: name, command })));
  }

  const answers: Answers = Object.assign({}, ...resolved.map(({ resolution }) => resolution.answers));
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
 * given answer, else the read's default; a read that nothing supplies is an error.
 */
function readsOf(
  template: Template,
  owners: ReadonlyMap<string, Template>,
  resolutions: ReadonlyMap<Template, Resolution>,
  given: Answers,
  errors: RenderError[],
): Context {
  const reads: Context = {};
  for (const read of template.manifest.reads) {
    const owner = owners.get(read.name);
    const resolved = owner === undefined ? undefined : resolutions.get(owner)?.context;
    if (resolved !== undefined && Object.hasOwn(resolved, read.name)) reads[read.name] = resolved[read.name];
    else if (Object.hasOwn(given, read.name)) reads[read.name] = given[read.name];
    else if (Object.hasOwn(read, 'default')) reads[read.name] = read.default;
    else {
      const message = `${template.manifest.name} reads ${read.name}, which no template of the render owns and no answer gives`;
      errors.push({ template: template.manifest.name, path: MANIFEST, question: read.name, message });
    }
  }
  return reads;
}

/** What a template's questions see besides its own earlier answers: the answers it reads. */
function scopeOf(reads: Context): Context {
  return { ...reads };
}

/** What a template's files render with: its scope and its own answers. */
function contextOf(scope: Context, resolution: Resolution): Context {
  return { ...scope, ...resolution.context };
}
