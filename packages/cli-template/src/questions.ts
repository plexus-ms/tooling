// The answers of a template's questions, resolved against the given answers,
// and the given answers a render leaves unused.
//
// `resolveAnswers` resolves one template's questions in the manifest's order.
// What a default, `when`, `choices` or `validator` may use is the template's
// earlier answers and the scope `render` passes in, the variables that do not
// come from the template's own questions. It returns two views of the result:
// the answers `render` reports, and what the questions add to the context the
// template's files render in. The two differ where a question is skipped: it
// is absent from the answers, while its default, where it has one, is in the
// context.
//
// A question takes the given answer of its name, and without one its default.
// A string default is Jinja, in the scope and the answers before it: one `{{ }}`
// holding a whole expression is evaluated to a native value, any other string is
// rendered to text (`value`). Nothing else of a manifest value is touched.
import { messageOf } from './errors.ts';
import { type Context, evaluate, renderString } from './jinja.ts';
import type { Answers, Manifest, RenderError } from './types.ts';

/** One template's questions, resolved. */
export interface Resolution {
  /** The answers `render` reports: given or defaulted, without the questions `when` skipped. */
  readonly answers: Answers;
  /** What the questions add to the template's context: the answers, and the default of each skipped question that has one. */
  readonly context: Context;
}

/** A string that is one `{{ expression }}` and nothing else, as the expression. */
const EXPRESSION = /^\s*\{\{((?:(?!\{\{|\}\}).)*)\}\}\s*$/s;

/** What a manifest value is in `context`: a string is Jinja, a whole `{{ expression }}` its native value and any other its text; other values are as they are. */
function value(source: unknown, context: Context): unknown {
  if (typeof source !== 'string') return source;
  const expression = EXPRESSION.exec(source)?.[1];
  return expression === undefined ? renderString(source, context) : evaluate(expression, context);
}

/** `value` of the field `what` of a question, an error naming the field's source where it fails. */
function field(what: string, source: unknown, context: Context): unknown {
  try {
    return value(source, context);
  } catch (error) {
    throw new Error(`${what} \`${String(source)}\`: ${messageOf(error)}`);
  }
}

/** The questions `manifest` owns, resolved against `given` with `scope` in view; problems go to `errors`. */
export function resolveAnswers(manifest: Manifest, given: Answers, scope: Context, errors: RenderError[]): Resolution {
  const answers: Record<string, unknown> = {};
  const context: Context = {};
  for (const question of manifest.questions) {
    try {
      const seen = { ...scope, ...context };
      let answer: unknown;
      if (Object.hasOwn(given, question.name)) answer = given[question.name];
      else if (Object.hasOwn(question, 'default')) answer = field('default', question.default, seen);
      else continue;
      answers[question.name] = answer;
      context[question.name] = answer;
    } catch (error) {
      errors.push({ template: manifest.name, question: question.name, message: messageOf(error) });
    }
  }
  return { answers, context };
}

/** The names of the `given` answers that no template of the render owns or reads, `manifests` being the render's. */
export function unusedAnswers(_manifests: readonly Manifest[], _given: Answers): string[] {
  return [];
}
