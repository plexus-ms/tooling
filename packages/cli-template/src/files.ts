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
// without the suffix; any other is copied as bytes, unless a `.jinja` file of
// the template stands beside it, by its own name or by the name it renders to:
// the template wins and the file is not written, as in copier. A `.jinja` file
// that is not valid text is copied as bytes, under the name without the
// suffix; its content is otherwise carried as it is, a byte order mark
// included. The mode is reduced to 0o644 or, where its owner may execute it,
// 0o755, as types.ts states. A file whose Jinja fails is an error naming its
// path in the template.
//
// Every path is written once: two sources that render to one path are an
// error naming both, as is a file with another path rendered below it. Two
// directories at one path are one directory. A directory that renders to a
// path and holds nothing in the result, because the template holds nothing
// there or because every file below it was skipped, lands as an empty
// directory, as copier creates it; only the innermost of nested ones is kept.
// A symlink anywhere in a template is rejected where the template is read
// (manifest.ts).
import { messageOf } from './errors.ts';
import { type Context, renderString } from './jinja.ts';
import { FILES, type Template } from './manifest.ts';
import { DIRECTORY, type Entry, fileMode, isExecutable, MODE_TYPE, REGULAR, type RenderError } from './types.ts';

/** A rendered entry, with the path below `files/` it came from. */
export interface Rendered {
  readonly entry: Entry;
  readonly source: string;
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

/** The entries `template` renders in `context`, by rendered path; its problems go to `errors`. */
export function renderFiles(template: Template, context: Context, errors: RenderError[]): Map<string, Rendered> {
  const fail = (source: string, message: string): 'failed' => {
    errors.push({ template: template.manifest.name, path: `${FILES}${source}`, message });
    return 'failed';
  };

  const rendered = new Map<string, Rendered>();
  const put = (path: string, value: Rendered): void => {
    const first = rendered.get(path);
    if (first === undefined) rendered.set(path, value);
    else fail(value.source, `${first.source} and ${value.source} both render to ${path}`);
  };

  const isTemplateFile = (source: string): boolean => {
    const entry = template.files.get(source);
    return entry !== undefined && (entry.mode & MODE_TYPE) === REGULAR;
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
    // As copier does, a `.jinja` file beside a file wins. A rendered path is
    // looked up among the source paths, as copier does.
    if (!isTemplate && (isTemplateFile(source + SUFFIX) || isTemplateFile(path + SUFFIX))) continue;
    const text = isTemplate ? textOf(entry.bytes) : undefined;
    if (text === undefined) {
      put(path, { entry: written(entry.bytes, entry.mode), source });
      continue;
    }
    try {
      put(path, { entry: written(encoder.encode(renderString(text, context)), entry.mode), source });
    } catch (error) {
      fail(source, messageOf(error));
    }
  }

  // A directory is kept where nothing is written below it. Directories at one
  // path are one, and the first source names it.
  const candidates = new Map<string, string>();
  for (const [source, located] of directories) {
    if (typeof located !== 'string' && located.path !== '' && !candidates.has(located.path)) {
      candidates.set(located.path, source);
    }
  }
  const taken = [...rendered.keys(), ...candidates.keys()];
  for (const [path, source] of candidates) {
    if (!taken.some((other) => other.startsWith(`${path}/`))) put(path, { entry: EMPTY_DIRECTORY, source });
  }
  for (const [path, { source }] of rendered) {
    for (let up = parentOf(path); up !== ''; up = parentOf(up)) {
      const above = rendered.get(up);
      if (above !== undefined && (above.entry.mode & MODE_TYPE) === REGULAR) {
        fail(source, `${above.source} renders to ${up}, a file, and ${source} renders to ${path} below it`);
      }
    }
  }
  return rendered;
}
