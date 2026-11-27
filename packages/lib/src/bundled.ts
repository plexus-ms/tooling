// The templates a plx bundles: the root directory that holds one directory per
// template, and the loader of one template's manifest. A verb that renders
// takes the root as an input and defaults it to `bundledTemplatesRoot()`, the
// one place that knows where the bundled templates are; the engine reads them
// as it reads any template directory (`@plexus-ms/cli-template`).
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Manifest } from '@plexus-ms/cli-template';
import { engine } from './engine.ts';
import { RESERVED_KEYS } from './marker.ts';

/** The directory that holds the templates this plx bundles, one directory per template. */
export function bundledTemplatesRoot(): string {
  throw new Error('no bundled templates: this plx does not carry its templates yet; name a root with --templates');
}

/** The directory of the template `name` below `root`; rejects when `name` is no template name or no such template is there. */
export async function templateDirectory(root: string, name: string): Promise<string> {
  const { TEMPLATE_NAME } = await engine();
  if (!TEMPLATE_NAME.test(name))
    throw new Error(`${JSON.stringify(name)} is not a template name: lowercase letters, digits and hyphens`);
  const dir = join(root, name);
  if (!(await isDirectory(dir))) throw new Error(`no template ${name} in ${root}`);
  return dir;
}

const isDirectory = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );

/**
 * The manifest of the template `name` below `root`: its questions with their
 * defaults and help, its reads, policies and birth commands. Rejects naming
 * the root when the template is not there, listing every problem when its
 * manifest cannot be read, and when it declares a question named like a key
 * of the marker (`RESERVED_KEYS`), which the marker's own keys would shadow.
 */
export async function loadTemplate(root: string, name: string): Promise<Manifest> {
  const { readManifest } = await engine();
  const manifest = await readManifest(await templateDirectory(root, name));
  const reserved = manifest.questions
    .map((q) => q.name)
    .filter((q) => (RESERVED_KEYS as readonly string[]).includes(q));
  if (reserved.length > 0)
    throw new Error(
      `template ${name} declares ${reserved.map((q) => `\`${q}\``).join(', ')}, which ${reserved.length === 1 ? 'is a key' : 'are keys'} of the marker and no question's name: rename it in the template`,
    );
  return manifest;
}
