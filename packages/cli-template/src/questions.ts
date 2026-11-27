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
// A question takes the given answer of its name, and without one its default; a
// question with neither is an error, one per question, naming its help text, so
// that one render lists all of them. Either is then cast to the question's type
// and checked against its choices, and a failure is an error naming the question.
// Only the questions of the render's manifests own answers; the rest are unused.
//
// Strings in a manifest are Jinja, rendered as copier renders them, to text, in
// the scope and the answers before the question (so a later question's name is
// undefined, which fails). A list is rendered item by item, anything else taken as
// it is. There is no second path for "an expression": a default is rendered to
// text and then cast by the type, so `"{{ n + 1 }}"` is 2 for `int` and "2" for
// `str`, `"true"` is true for `bool`, and `"{{ a }}-{{ b }}"` is text. The adapter's
// `evaluate` is not used here, since a native value and render-then-cast can
// differ (a float with no fraction), and one rule is better than two.
//
// Type: the question's own, else that of its raw default (a string `str`, a bool
// `bool`, a whole number `int`, any other number `float`), else `yaml`, as copier
// does. Casts follow copier's, with Python's int and float told apart by the number
// rather than by how it was written:
//   str    a string; a number is its text, a bool is `True` or `False`
//   int    a whole number, or a string of digits; 1.5 and "1.0" are errors
//   float  a number, or a string that reads as one
//   bool   a number by whether it is 0; a string, trimmed and lower-cased, by the
//          words y yes t true on and n no f false off ~ null none, a blank one
//          false, a numeric one by its value, any other true
//   json   a string is parsed as JSON; any other value is taken as it is
//   yaml   a string is parsed as YAML; any other value is taken as it is
// A null is an error for every type but `json` and `yaml`.
//
// `when` is rendered and read as a bool. A question it skips is left out of the
// reported answers and is not validated; where it has a given answer or a default,
// the context still holds it, the given answer first, as it does in copier, so
// that later questions and the template's files see it; where it has neither, the
// variable is absent and no error is made. A skipped question's choices are still
// checked against the value it holds.
//
// `choices` is a list, a map of label to value (only the values restrict, in the
// manifest's order), or a string of Jinja that renders YAML of either. List items
// are rendered; every value is cast to the question's type, and the answer must
// equal one of them, deeply. No choices, or an empty list, restrict nothing. The
// extended forms of copier (pairs, `{value, validator}`) and `multiselect` are not
// part of the engine.
//
// `validator` is rendered with the cast answer added to the context; its output,
// trimmed, is the error message when it is not empty, and a validator that fails to
// render is an error as well.
//
// Answers no question owns are unused. Declared reads and several templates are
// the render's composition, which extends `unusedAnswers`.
//
// Ported from copier v9.19.1 (see LICENSE.copier): `copier/_main.py` `_ask`,
// `copier/_user_data.py` `Question` and `copier/_tools.py` `cast_to_bool`, without
// prompts, answers files, `ask`, `secret`, `multiselect` or user defaults.
import { isDeepStrictEqual } from 'node:util';
import { isMap, isNode, isSeq, parseDocument, parse as parseYaml } from 'yaml';
import { messageOf } from './errors.ts';
import { type Context, renderString } from './jinja.ts';
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
      return typeof answer === 'string' ? parseYaml11(answer) : answer;
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

/** YAML as copier reads it, version 1.1: `yes` and `on` are booleans, `010` is octal. */
function parseYaml11(text: string): unknown {
  return parseYaml(text, { version: '1.1' });
}

/** The values of a map of choices, in its order; a null value stands for its label. */
function labelled(entries: Iterable<[unknown, unknown]>): unknown[] {
  return [...entries].map(([label, choice]) => (choice === null ? String(label) : choice));
}

/** The choices that YAML text holds, a list or a map in the order it is written. */
function parseChoices(text: string): unknown[] {
  const doc = parseDocument(text, { version: '1.1' });
  const [error] = doc.errors;
  if (error !== undefined) throw error;
  const js = (node: unknown) => (isNode(node) ? node.toJS(doc) : node);
  if (isMap(doc.contents)) return labelled(doc.contents.items.map((pair) => [js(pair.key), js(pair.value)]));
  if (isSeq(doc.contents)) return js(doc.contents) as unknown[];
  throw new Error('they render to neither a list nor a map');
}

/** The values a question's choices allow, rendered and cast to its type, in the manifest's order. */
function allowed(question: Question, type: QuestionType, context: Context): unknown[] {
  const { choices } = question;
  let values: unknown[];
  if (typeof choices === 'string') {
    try {
      values = parseChoices(renderString(choices, context));
    } catch (error) {
      throw new Error(`choices \`${choices}\`: ${messageOf(error)}`);
    }
  } else if (choices instanceof Map) {
    values = labelled([...choices].map(([label, choice]) => [value(label, context), value(choice, context)]));
  } else values = Array.isArray(choices) ? choices.map((choice) => value(choice, context)) : [];
  return values.map((choice) => cast(type, choice));
}

/** `answer` cast to the question's type, and checked against its choices. */
function accept(question: Question, answer: unknown, context: Context): unknown {
  const type = typeOf(question);
  const result = cast(type, answer);
  if (question.choices === undefined) return result;
  const choices = allowed(question, type, context);
  if (choices.length > 0 && !choices.some((choice) => isDeepStrictEqual(choice, result))) {
    const listed = choices.map((choice) => (typeof choice === 'string' ? choice : JSON.stringify(choice)));
    throw new Error(`${JSON.stringify(result)} is not one of ${listed.join(', ')}`);
  }
  return result;
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
      if (Object.hasOwn(given, question.name)) answer = accept(question, given[question.name], seen);
      else if (Object.hasOwn(question, 'default'))
        answer = accept(question, field('default', question.default, seen), seen);
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
      if (applies && question.validator !== undefined) {
        const message = renderString(question.validator, { ...seen, [question.name]: answer }).trim();
        if (message !== '') throw new Error(message);
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
export function unusedAnswers(manifests: readonly Manifest[], given: Answers): string[] {
  const owned = new Set(manifests.flatMap(({ questions }) => questions.map(({ name }) => name)));
  return Object.keys(given).filter((name) => !owned.has(name));
}
