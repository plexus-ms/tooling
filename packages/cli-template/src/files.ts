// A template's files rendered: which file lands where, and with what bytes.
//
// Every part of a path is Jinja and is rendered by itself, so that a part can
// be a condition: a part that renders empty skips the file, or the whole
// subtree for a directory. A file whose name ends in `.jinja` is rendered with
// the context and lands without the suffix; any other is copied as bytes. The
// mode is carried as it is, not yet reduced to the executable bit as types.ts
// states. A file whose Jinja fails is an error naming its path in the template.
//
// A directory that renders to a path and holds nothing in the result, because
// the template holds nothing there or because every file below it was skipped,
// lands as an empty directory, as copier creates it.
import { messageOf } from './errors.ts';
import { type Context, renderString } from './jinja.ts';
import { FILES, type Template } from './manifest.ts';
import { DIRECTORY, type Entry, MODE_TYPE, type RenderError } from './types.ts';

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

/** The directory of a source path: everything before its last `/`, or `''`. */
const parentOf = (source: string): string => source.slice(0, Math.max(0, source.lastIndexOf('/')));

/** The entries `template` renders in `context`, by rendered path; its problems go to `errors`. */
export function renderFiles(template: Template, context: Context, errors: RenderError[]): Map<string, Rendered> {
  const rendered = new Map<string, Rendered>();

  // The rendered path of each source directory, or undefined where it is skipped.
  const directories = new Map<string, string | undefined>([['', '']]);
  const directoryOf = (source: string): string | undefined => {
    if (directories.has(source)) return directories.get(source);
    const parent = directoryOf(parentOf(source));
    const part = parent === undefined ? '' : renderString(source.slice(source.lastIndexOf('/') + 1), context);
    const path = part === '' ? undefined : `${parent === '' ? '' : `${parent}/`}${part}`;
    directories.set(source, path);
    return path;
  };

  for (const [source, entry] of template.files) {
    if ((entry.mode & MODE_TYPE) === DIRECTORY) {
      directoryOf(source);
      continue;
    }
    const parent = directoryOf(parentOf(source));
    const isTemplate = source.endsWith(SUFFIX);
    const name = source.slice(source.lastIndexOf('/') + 1, isTemplate ? -SUFFIX.length : undefined);
    const part = parent === undefined ? '' : renderString(name, context);
    if (part === '') continue;
    const path = `${parent === '' ? '' : `${parent}/`}${part}`;
    if (!isTemplate) {
      rendered.set(path, { entry, source });
      continue;
    }
    try {
      const bytes = encoder.encode(renderString(utf8.decode(entry.bytes), context));
      rendered.set(path, { entry: { bytes, mode: entry.mode }, source });
    } catch (error) {
      errors.push({ template: template.manifest.name, path: `${FILES}${source}`, message: messageOf(error) });
    }
  }

  const paths = [...directories.values(), ...rendered.keys()];
  for (const [source, path] of directories) {
    if (path === undefined || path === '' || paths.some((other) => other?.startsWith(`${path}/`))) continue;
    rendered.set(path, { entry: EMPTY_DIRECTORY, source });
  }
  return rendered;
}
