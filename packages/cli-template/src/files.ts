// A template's files rendered: which file lands where, and with what bytes.
// Ported from copier v9.19.1 (MIT, see LICENSE.copier): `_render_path` and
// `_render_parts` for the paths, and the render-or-copy part of `_render_file`
// of copier/_main.py for the content and the mode.
//
// Every part of a path is Jinja and is rendered by itself, so that a part can
// be a condition: a part that renders empty skips the file, or the whole
// subtree for a directory. A directory part is rendered once per source
// directory, not once per file below it, which is why an error in it is
// reported once. A rendered part may hold slashes and lands nested; `.` and
// `..` are resolved, and a path that leaves the output, is absolute, holds a
// NUL character, or is a file at the output's root is an error.
//
// A file whose name ends in `.jinja` is rendered with the context and lands
// without the suffix; any other is copied as bytes. A `.jinja` file
// that is not valid text is copied as bytes, under the name without the
// suffix; its content is otherwise carried as it is, a byte order mark
// included. The mode is reduced to 0o644 or, where its owner may execute it,
// 0o755, as types.ts states. A file whose Jinja fails is an error naming its
// path in the template.
//
// The templates of a render land in one tree, and every path is written once,
// by one template. Two sources that render to one path are an error naming
// both, a file beside its `.jinja` sibling included, as is a file with another
// path rendered below it; where the two belong to two templates, the error
// names both templates as well, the first source's in `template`. Copier
// differs here: the `.jinja` file wins and the other is silently not written.
// Two directories of one template at one path are one directory. A directory
// that renders to a path and holds nothing in the result, because the
// template holds nothing there or because every file below it was skipped,
// lands as an empty directory, as copier creates it; only the innermost of
// nested ones is kept, and one below which another template writes is implied
// by that template's paths. Two templates that both leave one directory empty
// are two writers of one path, an error.
// A symlink anywhere in a template is rejected where the template is read
// (manifest.ts).
import { messageOf } from './errors.ts';
import { type Context, renderString } from './jinja.ts';
import { FILES, type Template } from './manifest.ts';
import { DIRECTORY, type Entry, fileMode, isExecutable, MODE_TYPE, REGULAR, type RenderError } from './types.ts';

/** A rendered entry, with the template and the path below `files/` it came from. */
export interface Rendered {
  readonly entry: Entry;
  readonly source: string;
  readonly owner: Template;
}

/** A template, and the context its files render in. */
export interface Rendering {
  readonly template: Template;
  readonly context: Context;
}

const SUFFIX = '.jinja';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** What an empty directory is written as. */
const EMPTY_DIRECTORY: Entry = { bytes: new Uint8Array(), mode: DIRECTORY | 0o755 };

/** A file's entry as `render` writes it: its bytes, and a mode of 0o644 or 0o755. */
const written = (bytes: Uint8Array, mode: number): Entry => ({ bytes, mode: fileMode(isExecutable(mode)) });

/** The text of `bytes`, or undefined where they are not valid UTF-8. */
function textOf(bytes: Uint8Array): string | undefined {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

/** The last part of a source path. */
const nameOf = (source: string): string => source.slice(source.lastIndexOf('/') + 1);

/** The directory of a source path: everything before its last `/`, or `''`. */
const parentOf = (source: string): string => source.slice(0, Math.max(0, source.lastIndexOf('/')));

/** `part` below `parent`, both of the output and with `..` and `.` resolved; undefined where it leaves the output. */
function join(parent: string, part: string): string | undefined {
  // An absolute part, or one with a NUL character, is no path inside the output.
  if (part.startsWith('/') || part.includes('\0')) return undefined;
  const parts = parent === '' ? [] : parent.split('/');
  for (const segment of part.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') parts.push(segment);
    else if (parts.pop() === undefined) return undefined;
  }
  return parts.join('/');
}

/**
 * Where a source name lands. A path of `''` is the output's root. Both
 * `skipped` (an empty part, or a parent that is skipped or failed) and
 * `failed` (an error was recorded) leave nothing to write.
 */
type Location = { readonly path: string } | 'skipped' | 'failed';

/** The entries the templates of `renderings` render together, by rendered path; their problems go to `errors`. */
export function renderFiles(renderings: readonly Rendering[], errors: RenderError[]): Map<string, Rendered> {
  const rendered = new Map<string, Rendered>();
  // Two entries that cannot both be written: an error naming both sources, and
  // their templates where they differ, the first one's in `template`.
  const clash = (first: Rendered, second: Rendered, message: (a: string, b: string) => string): void => {
    const template = first.owner.manifest.name;
    if (first.owner === second.owner) {
      errors.push({ template, path: `${FILES}${second.source}`, message: message(first.source, second.source) });
      return;
    }
    const other = second.owner.manifest.name;
    const text = message(`${template}'s ${first.source}`, `${other}'s ${second.source}`);
    errors.push({ template, other, path: `${FILES}${first.source}`, message: text });
  };
  const put = (path: string, value: Rendered): void => {
    const first = rendered.get(path);
    if (first === undefined) rendered.set(path, value);
    else clash(first, value, (a, b) => `${a} and ${b} both render to ${path}`);
  };

  // The directories that may land empty, by rendered path, each with the first source of each template at it.
  const directories = new Map<string, Rendered[]>();
  for (const { template, context } of renderings) {
    for (const [path, source] of renderTemplate(template, context, put, errors)) {
      directories.set(path, [...(directories.get(path) ?? []), { entry: EMPTY_DIRECTORY, source, owner: template }]);
    }
  }

  // A directory is kept where nothing is written below it. Directories of one
  // template at one path are one; two templates keeping one are two writers.
  const taken = [...rendered.keys(), ...directories.keys()];
  for (const [path, sources] of directories) {
    if (!taken.some((other) => other.startsWith(`${path}/`))) for (const value of sources) put(path, value);
  }
  for (const [path, below] of rendered) {
    for (let up = parentOf(path); up !== ''; up = parentOf(up)) {
      const above = rendered.get(up);
      if (above !== undefined && (above.entry.mode & MODE_TYPE) === REGULAR) {
        clash(above, below, (a, b) => `${a} renders to ${up}, a file, and ${b} renders to ${path} below it`);
      }
    }
  }
  return rendered;
}

/**
 * Puts the files `template` renders in `context`, and returns the paths its
 * source directories render to, each with its first source; its problems go
 * to `errors`.
 */
function renderTemplate(
  template: Template,
  context: Context,
  put: (path: string, value: Rendered) => void,
  errors: RenderError[],
): Map<string, string> {
  const fail = (source: string, message: string): 'failed' => {
    errors.push({ template: template.manifest.name, path: `${FILES}${source}`, message });
    return 'failed';
  };

  // Where the source name `name`, which is the last part of `source`, lands below the rendered directory `parent`.
  const locate = (parent: Location, name: string, source: string): Location => {
    if (typeof parent === 'string') return 'skipped';
    let part: string;
    try {
      part = renderString(name, context);
    } catch (error) {
      return fail(source, `error rendering template path ${source}: ${messageOf(error)}`);
    }
    if (part === '') return 'skipped';
    const path = join(parent.path, part);
    if (path === undefined) {
      const shown = parent.path === '' || part.startsWith('/') ? part : `${parent.path}/${part}`;
      return fail(source, `${JSON.stringify(shown)} is forbidden: it is not inside the output`);
    }
    return { path };
  };

  // Each source directory is located once, with the root as `''`.
  const directories = new Map<string, Location>([['', { path: '' }]]);
  const directoryOf = (source: string): Location => {
    const known = directories.get(source);
    if (known !== undefined) return known;
    const located = locate(directoryOf(parentOf(source)), nameOf(source), source);
    directories.set(source, located);
    return located;
  };

  for (const [source, entry] of template.files) {
    if ((entry.mode & MODE_TYPE) === DIRECTORY) {
      directoryOf(source);
      continue;
    }
    const isTemplate = source.endsWith(SUFFIX);
    if (nameOf(source) === SUFFIX) {
      fail(source, `${source} has no name besides the ${SUFFIX} suffix`);
      continue;
    }
    const name = isTemplate ? nameOf(source).slice(0, -SUFFIX.length) : nameOf(source);
    const located = locate(directoryOf(parentOf(source)), name, source);
    if (typeof located === 'string') continue;
    const path = located.path;
    if (path === '') {
      fail(source, `${source} renders to the output's root, which is no file`);
      continue;
    }
    const text = isTemplate ? textOf(entry.bytes) : undefined;
    if (text === undefined) {
      put(path, { entry: written(entry.bytes, entry.mode), source, owner: template });
      continue;
    }
    try {
      put(path, { entry: written(encoder.encode(renderString(text, context)), entry.mode), source, owner: template });
    } catch (error) {
      fail(source, messageOf(error));
    }
  }

  // Directories at one path are one, and the first source names it.
  const located = new Map<string, string>();
  for (const [source, at] of directories) {
    if (typeof at !== 'string' && at.path !== '' && !located.has(at.path)) located.set(at.path, source);
  }
  return located;
}
