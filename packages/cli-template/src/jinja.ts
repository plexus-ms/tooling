// The adapter to the template engine library, minijinja-js: the one file that
// imports it, so that the library can be replaced here alone. It offers two
// functions, render a string and evaluate an expression to a native value,
// over one environment configured once.
//
// A file's trailing newlines are kept, as copier's Jinja environment keeps
// them, and nothing is escaped: templates render config files and source code,
// never HTML for a browser. The library escapes only by a template name's
// suffix, such as `.html`, and a string is rendered here without a name. Line
// endings are carried as they are; Python's Jinja would turn every CRLF into LF.
//
// A variable the context lacks is an error wherever it is used, except under
// `is defined` and the `default` filter: a typo in a template fails the render
// instead of writing an empty string, as copier's lenient Jinja would. An
// expression whose whole value is undefined fails as well, which the library
// lets through even in strict mode.
//
// Strings, lists and maps offer the Python methods Jinja templates call on them
// (`split`, `strip`, `startswith`, `items` and the like), as in Python's Jinja.
import { Environment } from 'minijinja-js';

/** The variables a template or expression sees, by name. */
export type Context = Record<string, unknown>;

const env = new Environment();
env.keepTrailingNewline = true;
env.undefinedBehavior = 'strict';
env.pycompat = true;

/** The text a Jinja template source renders to in the context. */
export function renderString(source: string, context: Context): string {
  return env.renderStr(source, context);
}

/** The value of a Jinja expression in the context, as a JavaScript value: string, number, boolean, null, array or object. */
export function evaluate(expression: string, context: Context): unknown {
  const value: unknown = env.evalExpr(expression, context);
  if (value === undefined) throw new Error(`undefined value: \`${expression}\``);
  return value;
}
