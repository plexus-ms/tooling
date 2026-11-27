// A template's files rendered: which file lands where, and with what bytes.
//
// Every part of a path is Jinja and is rendered by itself, so that a part can
// be a condition: a part that renders empty skips the file, or the whole
// subtree for a directory. A file whose name ends in `.jinja` is rendered with
// the context and lands without the suffix; any other is copied as bytes, unless
// a `.jinja` file of the template stands beside it, by its own name or by the
// name it renders to: the template wins and the file is not written. The
// mode is reduced to 0o644 or, where its owner may execute it, 0o755, as
// types.ts states. A `.jinja` file that is not valid text
// is copied as bytes, under the name without the suffix. A file whose Jinja
// fails is an error naming its path in the template.
//
// A symlink in the template is an error, and so are two sources
// that render to one path.
//
// A directory that renders to a path and holds nothing in the result, because
// the template holds nothing there or because every file below it was skipped,
// lands as an empty directory, as copier creates it.
import { messageOf } from './errors.ts';
import { type Context, renderString } from './jinja.ts';
import { FILES, type Template } from './manifest.ts';
import { DIRECTORY, type Entry, MODE_TYPE, REGULAR, type RenderError, SYMLINK } from './types.ts';

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
const written = (bytes: Uint8Array, mode: number): Entry => ({ bytes, mode: REGULAR | (mode & 0o100 ? 0o755 : 0o644) });

/** The text of `bytes`, or undefined where they are not valid UTF-8. */
function textOf(bytes: Uint8Array): string | undefined {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

/** The directory of a source path: everything before its last `/`, or `''`. */
const parentOf = (source: string): string => source.slice(0, Math.max(0, source.lastIndexOf('/')));

/** `part` below `parent`, both of the output and with `..` and `.` resolved; undefined where it leaves the output. */
function join(parent: string, part: string): string | undefined {
  if (part.startsWith('/')) return undefined;
  const parts = parent === '' ? [] : parent.split('/');
  for (const segment of part.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') parts.push(segment);
    else if (parts.pop() === undefined) return undefined;
  }
  return parts.join('/');
}

/** The entries `template` renders in `context`, by rendered path; its problems go to `errors`. */
export function renderFiles(template: Template, context: Context, errors: RenderError[]): Map<string, Rendered> {
  const rendered = new Map<string, Rendered>();
  const put = (path: string, value: Rendered): void => {
    const first = rendered.get(path);
    if (first === undefined) {
      rendered.set(path, value);
      return;
    }
    errors.push({
      template: template.manifest.name,
      path: `${FILES}${value.source}`,
      message: `${first.source} and ${value.source} both render to ${path}`,
    });
  };

  // The rendered path of each source directory, or undefined where it is skipped.
  const directories = new Map<string, string | undefined>([['', '']]);
  const directoryOf = (source: string): string | undefined => {
    if (directories.has(source)) return directories.get(source);
    const path = place(directoryOf(parentOf(source)), source.slice(source.lastIndexOf('/') + 1), source, true);
    directories.set(source, path);
    return path;
  };

  // The path a source name renders to below its rendered directory, or
  // undefined where it is skipped or leaves the output, the latter an error.
  const place = (
    parent: string | undefined,
    name: string,
    source: string,
    isDirectory: boolean,
  ): string | undefined => {
    let part = '';
    try {
      if (parent !== undefined) part = renderString(name, context);
    } catch (error) {
      errors.push({
        template: template.manifest.name,
        path: `${FILES}${source}`,
        message: `error rendering template path ${source}: ${messageOf(error)}`,
      });
    }
    if (part === '') return undefined;
    const path = join(parent ?? '', part);
    if (path === undefined || (path === '' && !isDirectory)) {
      const shown = parent === '' ? part : `${parent}/${part}`;
      errors.push({
        template: template.manifest.name,
        path: `${FILES}${source}`,
        message: `"${shown}" is forbidden: it is not inside the output`,
      });
    }
    return path || undefined;
  };

  for (const [source, entry] of template.files) {
    if ((entry.mode & MODE_TYPE) === DIRECTORY) {
      directoryOf(source);
      continue;
    }
    if ((entry.mode & MODE_TYPE) === SYMLINK) {
      errors.push({
        template: template.manifest.name,
        path: `${FILES}${source}`,
        message: `${source} is a symlink, and a template may not hold one`,
      });
      continue;
    }
    const isTemplate = source.endsWith(SUFFIX);
    const name = source.slice(source.lastIndexOf('/') + 1, isTemplate ? -SUFFIX.length : undefined);
    const path = place(directoryOf(parentOf(source)), name, source, false);
    if (path === undefined) continue;
    // As copier does, a template beside a file wins, by either name.
    if (!isTemplate && (template.files.has(source + SUFFIX) || template.files.has(path + SUFFIX))) continue;
    const text = isTemplate ? textOf(entry.bytes) : undefined;
    if (text === undefined) {
      put(path, { entry: written(entry.bytes, entry.mode), source });
      continue;
    }
    try {
      const bytes = encoder.encode(renderString(text, context));
      put(path, { entry: written(bytes, entry.mode), source });
    } catch (error) {
      errors.push({ template: template.manifest.name, path: `${FILES}${source}`, message: messageOf(error) });
    }
  }

  const paths = [...directories.values(), ...rendered.keys()];
  for (const [source, path] of directories) {
    if (path === undefined || path === '' || paths.some((other) => other?.startsWith(`${path}/`))) continue;
    put(path, { entry: EMPTY_DIRECTORY, source });
  }
  return rendered;
}
