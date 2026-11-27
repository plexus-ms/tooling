// The bundled templates rendered in a test: each read from `templatesRoot()`
// and handed to the engine. Not shipped (excluded in tsconfig).
import { join } from 'node:path';
import { type Answers, type RenderResult, readTree, render } from '@plexus-ms/cli-template';
import { templatesRoot } from '../templatesRoot.ts';

/** The bundled templates `names`, rendered together with `answers`. */
export async function renderBundled(names: readonly string[], answers: Answers): Promise<RenderResult> {
  const trees = await Promise.all(names.map((name) => readTree(join(templatesRoot(), name))));
  return render(trees, answers);
}

/** The text of the rendered file at `path`. */
export function textOf(result: RenderResult, path: string): string {
  const entry = result.tree.get(path);
  if (entry === undefined) throw new Error(`the render holds no ${path}`);
  return new TextDecoder().decode(entry.bytes);
}

/** The rendered files, as sorted paths. */
export const pathsOf = (result: RenderResult): string[] => [...result.files.keys()].sort();
