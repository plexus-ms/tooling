// The templates a plx bundles: the root directory that holds one directory per
// template, and the loader of one template's manifest. A verb that renders
// takes the root as an input and defaults it to `bundledTemplatesRoot()`, the
// one place that knows where the bundled templates are; the engine reads them
// as it reads any template directory (`@plexus-ms/cli-template`).
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Manifest } from '@plexus-ms/cli-template';
import { engine } from './engine.ts';

/** The directory that holds the templates this plx bundles, one directory per template. */
export function bundledTemplatesRoot(): string {
  throw new Error('no bundled templates: this plx does not carry its templates yet; name a root with --templates');
}

/** What a template of a marker's `templates` list is called: the name of a directory below the root. */
const TEMPLATE_NAME = /^[a-z][a-z0-9-]*$/;

/** The directory of the template `name` below `root`; rejects when `name` is no template name or no such template is there. */
export async function templateDirectory(root: string, name: string): Promise<string> {
  if (!TEMPLATE_NAME.test(name))
    throw new Error(`${JSON.stringify(name)} is not a template name: lowercase letters, digits and hyphens`);
  const dir = join(root, name);
  if (
    !(await stat(dir).then(
      (s) => s.isDirectory(),
      () => false,
    ))
  )
    throw new Error(`no template ${name} in ${root}`);
  return dir;
}

/**
 * The manifest of the template `name` below `root`: its questions with their
 * defaults and help, its reads, policies and birth commands. Rejects naming
 * the root when the template is not there, and listing every problem when its
 * manifest cannot be read.
 */
export async function loadTemplate(root: string, name: string): Promise<Manifest> {
  const { readManifest } = await engine();
  return readManifest(await templateDirectory(root, name));
}
