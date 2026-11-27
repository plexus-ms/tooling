// The adapter to the template engine library, minijinja-js: the one file that
// imports it, so that the library can be replaced here alone. It offers two
// functions, render a string and evaluate an expression to a native value,
// over one environment configured once. A file's trailing newlines are kept,
// as copier's Jinja environment keeps them, and nothing is escaped: templates
// render config files and source code, never HTML for a browser.
import { Environment } from 'minijinja-js';

/** The variables a template or expression sees, by name. */
export type Context = Record<string, unknown>;

const env = new Environment();
env.keepTrailingNewline = true;
env.setAutoEscapeCallback(() => false);

/** The text a Jinja template source renders to in the context. */
export function renderString(source: string, context: Context): string {
  return env.renderStr(source, context);
}
