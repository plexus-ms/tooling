// Where the templates are: the one function that says, so that no caller
// builds the path itself. The templates are `templates/` at the root of
// `tooling`, a directory per template; `@plexus-ms/cli` carries a
// copy of that directory beside its bundle, `dist/templates`, which its build
// makes (packages/cli/build.js), so that the published package has them.
//
// Two layouts, told apart by what exists next to the running file: a
// `templates` directory beside it is the built package's, and without one the
// file is in a package of the workspace (`packages/<name>/src` or `dist`), and
// the root is the repo's, three directories up. Tests and a workspace build run
// the second; an installed `plx` the first. Where neither exists, as in an
// installed package that was not bundled, it throws and names both places. `from` is the file's URL and
// defaults to this one's, so that a bundle, which is one file, answers for
// itself; a caller passes none.
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The directory that holds one directory per bundled template. */
export function templatesRoot(from: string = import.meta.url): string {
  const here = dirname(fileURLToPath(from));
  const beside = join(here, 'templates');
  const repo = join(here, '..', '..', '..', 'templates');
  for (const root of [beside, repo]) if (isDirectory(root)) return root;
  throw new Error(`no bundled templates: looked for ${beside} and ${resolve(repo)}`);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
