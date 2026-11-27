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

import { parse as parseYaml } from 'yaml';
import { messageOf } from './errors.ts';
import { type Context, evaluate, renderString } from './jinja.ts';
import type { Answers, Manifest, Question, QuestionType, RenderError } from './types.ts';

/** One template's questions, resolved. */
export interface Resolution {
  /** The answers `render` reports: given or defaulted, without the questions `when` skipped. */
  readonly answers: Answers;
  /** What the questions add to the template's context: the answers, and the default of each skipped question that has one. */
  readonly context: Context;
}

/** What a manifest value is in `context`: a string is Jinja rendered to text, a list is rendered item by item; other values are as they are. */
function value(source: unknown, context: Context): unknown {
  if (typeof source === 'string') return renderString(source, context);
  if (Array.isArray(source)) return source.map((item: unknown) => value(item, context));
  return source;
}

/** The type of a question: its own, else its raw default's, else `yaml`. */
function typeOf(question: Question): QuestionType {
  if (question.type !== undefined) return question.type;
  const raw = question.default;
  if (typeof raw === 'string') return 'str';
  if (typeof raw === 'boolean') return 'bool';
  if (typeof raw === 'number') return Number.isInteger(raw) ? 'int' : 'float';
  return 'yaml';
}

const INTEGER = /^\s*[+-]?\d+\s*$/;
const NUMBER = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;

/** `answer` as a value of `type`; throws where it is none. */
function cast(type: QuestionType, answer: unknown): unknown {
  const fail = () => new Error(`${JSON.stringify(answer)} is no ${type}`);
  if (answer === null && type !== 'json' && type !== 'yaml') throw fail();
  switch (type) {
    case 'str':
      if (typeof answer === 'string') return answer;
      if (typeof answer === 'number') return String(answer);
      if (typeof answer === 'boolean') return answer ? 'True' : 'False';
      throw fail();
    case 'int':
      if (typeof answer === 'number' && Number.isInteger(answer)) return answer;
      if (typeof answer === 'string' && INTEGER.test(answer)) return Number.parseInt(answer, 10);
      throw fail();
    case 'float':
      if (typeof answer === 'number') return answer;
      if (typeof answer === 'string' && NUMBER.test(answer)) return Number(answer);
      throw fail();
    case 'bool':
      return toBool(answer);
    case 'json':
      return typeof answer === 'string' ? JSON.parse(answer) : answer;
    case 'yaml':
      return typeof answer === 'string' ? parseYaml(answer) : answer;
  }
}

/** A value as a boolean the way copier reads one: a number by its truth, a string by its YAML boolean words, anything else by its truthiness. */
function toBool(source: unknown): boolean {
  if (typeof source === 'number') return source !== 0;
  if (typeof source === 'string') {
    const text = source.trim().toLowerCase();
    if (text === '') return false;
    if (Number.isFinite(Number(text))) return Number(text) !== 0;
    if (['y', 'yes', 't', 'true', 'on'].includes(text)) return true;
    if (['n', 'no', 'f', 'false', 'off', '~', 'null', 'none'].includes(text)) return false;
    return true;
  }
  if (Array.isArray(source)) return source.length > 0;
  if (typeof source === 'object' && source !== null) return Object.keys(source).length > 0;
  return Boolean(source);
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
      const applies = question.when === undefined || toBool(field('when', question.when, seen));
      let answer: unknown;
      if (Object.hasOwn(given, question.name)) answer = cast(typeOf(question), given[question.name]);
      else if (Object.hasOwn(question, 'default'))
        answer = cast(typeOf(question), field('default', question.default, seen));
      else {
        if (applies) {
          const help = question.help === undefined ? '' : `: ${question.help}`;
          errors.push({
            template: manifest.name,
            question: question.name,
            message: `no answer and no default${help}`,
          });
        }
        continue;
      }
      context[question.name] = answer;
      if (applies) answers[question.name] = answer;
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
