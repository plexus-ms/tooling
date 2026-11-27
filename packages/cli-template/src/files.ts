// A template's files rendered: which file lands where, and with what bytes.
// A file whose name ends in `.jinja` is rendered with the context and lands
// without the suffix; any other is copied as bytes. The mode is carried as it
// is, not yet reduced to the executable bit as types.ts states. A file whose
// Jinja fails is an error naming its path in the template.
import { messageOf } from './errors.ts';
import { type Context, renderString } from './jinja.ts';
import { FILES, type Template } from './manifest.ts';
import type { Entry, RenderError } from './types.ts';

/** A rendered entry, with the path below `files/` it came from. */
export interface Rendered {
  readonly entry: Entry;
  readonly source: string;
}

const SUFFIX = '.jinja';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** The entries `template` renders in `context`, by rendered path; its problems go to `errors`. */
export function renderFiles(template: Template, context: Context, errors: RenderError[]): Map<string, Rendered> {
  const rendered = new Map<string, Rendered>();
  for (const [source, entry] of template.files) {
    if (!source.endsWith(SUFFIX)) {
      rendered.set(source, { entry, source });
      continue;
    }
    try {
      const bytes = encoder.encode(renderString(utf8.decode(entry.bytes), context));
      rendered.set(source.slice(0, -SUFFIX.length), { entry: { bytes, mode: entry.mode }, source });
    } catch (error) {
      errors.push({ template: template.manifest.name, path: `${FILES}${source}`, message: messageOf(error) });
    }
  }
  return rendered;
}
