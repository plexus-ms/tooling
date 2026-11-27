// render: templates and answers to one tree, and the result that describes it
// (types.ts states the shapes). Each template is read (manifest.ts), its
// questions resolved against the given answers (questions.ts), and its files
// rendered with those answers (files.ts). Every step adds what it finds wrong
// to one list of errors and carries on, so that one render reports them all;
// a render with errors returns no files.
import { renderFiles } from './files.ts';
import { readTemplate } from './manifest.ts';
import { resolveAnswers } from './questions.ts';
import type { Answers, BirthCommand, Entry, Origin, RenderError, RenderResult, Tree } from './types.ts';

/** The tree `templates` render with the `given` answers, and what it is made of. */
export function render(templates: readonly Tree[], given: Answers): RenderResult {
  const errors: RenderError[] = [];
  const tree = new Map<string, Entry>();
  const files = new Map<string, Origin>();
  const birth: BirthCommand[] = [];
  const answers: Record<string, unknown> = {};
  templates.forEach((source, i) => {
    const template = readTemplate(source, i + 1, errors);
    if (!template) return;
    const { name } = template.manifest;
    const own = resolveAnswers(template.manifest, given, errors);
    Object.assign(answers, own);
    for (const [path, { entry, source }] of renderFiles(template, own, errors)) {
      tree.set(path, entry);
      files.set(path, { template: name, policy: template.manifest.policies.get(source) ?? 'merge' });
    }
  });
  if (errors.length > 0) return { tree: new Map(), answers, unused: [], files: new Map(), birth: [], errors };
  return { tree, answers, unused: [], files, birth, errors };
}
