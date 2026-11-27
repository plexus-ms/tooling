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
// A given answer that no question of the render's manifests owns and none of them
// reads is unused.
//
// What the engine resolves is what copier (v9.19.1, see LICENSE.copier) resolves
// in `_ask` and `Question`, without prompts, answers files, `ask`, `secret`,
// `multiselect` or user defaults. Where it deliberately differs, a sentence below
// says so, and a test pins the engine's side.
//
// What a question sees. Its default, `when`, choices and validator are rendered
// in the scope, in every given answer to a question of this template, as given,
// and in the resolved answer of each question before it, which replaces the given
// one. A later question's default is not seen, and neither is a given answer that
// no question of this template owns.
//
// Strings in a manifest are Jinja, rendered to text. A list is rendered item by
// item, anything else is taken as it is. A default is rendered and then cast by
// the type, as copier does, so `"{{ n + 1 }}"` is 2 for `int` and "2" for `str`,
// `"true"` is true for `bool`, and `"{{ a }}-{{ b }}"` is text. `evaluate` of the
// adapter is not used: a native value and render-then-cast can differ, and one
// rule is better than two. An undefined variable is an error in every field,
// where copier's default Jinja renders an empty string.
//
// Type: the question's own, else that of its raw default (a string `str`, a bool
// `bool`, a whole number `int`, any other number `float`), else `yaml`. Casts:
//   str    a string; a number is its text, a bool is `True` or `False`; a list,
//          a map and null are errors
//   int    a safe integer, or a string of digits with a sign and whitespace
//   float  a number, or a string that reads as one: sign, fraction or leading
//          dot, exponent, whitespace
//   bool   as copier's `cast_to_bool`: a number, or a string Python's `float`
//          reads (`0_0` and `nan` included, `0x0` not), by its value; any other
//          string is true unless it is blank or one of n no f false off ~ null none,
//          in any case; a list or map by whether it is empty
//   json   a string is parsed as JSON; any other value is taken as it is
//   yaml   a string is parsed as YAML 1.1 (`yes`, `010`, `1:30`) by the `yaml`
//          package; any other value is taken as it is
// A null is an error for every type but `json` and `yaml`.
//
// `when` is rendered and read as a bool. A question it skips is left out of the
// reported answers. A given answer is always cast, checked against the choices and
// validated, as in copier, where `get_default` reads the given answer first; the
// default of a skipped question is cast and checked but not validated. A skipped
// question with neither a given answer nor a default is absent.
//
// `choices` is a list, a map of label to value, or a string of Jinja that renders
// YAML 1.1 of either, which must be a list or a map; an empty one restricts
// nothing. List items are rendered, every value is cast to the question's type,
// and the answer, once cast, must equal one of them deeply and strictly. In a map
// a null value stands for its label, as it does in copier; the answer is then the
// label. A manifest's choices keep their order, which the error message lists.
//
// `validator` is rendered with the cast answer added to the context; its output,
// trimmed, is the error message when it is not empty.
//
// Where the engine differs from copier on purpose:
// - `int` of 1.5 or of a bool is an error, where copier truncates and takes 1.
// - `int` beyond 2^53 - 1 is an error, where Python's integers have no limit.
// - A string with an underscore, `nan` or `inf` is no `int` or `float`, where
//   Python's `float` reads them; `bool` still follows Python for them.
// - A number carries no `.0`: a `float` of 1.0 prints `1`, a `str` of it is "1", and
//   an untyped default written `1.0` is inferred as `int`.
// - A two-item list among choices is a list value, not copier's label and value,
//   and a null item of a list is the value null; only a map has labels.
// - The extended choices of copier (`{value, validator}`) and `multiselect` do
//   not exist.
// - `float` of a bool is an error as well.
// - A given answer that no question of the template owns is not in view of its
//   questions, where copier shows every given answer.
// - YAML is read by the `yaml` package's 1.1 mode, not by PyYAML: `y` and `n` are
//   booleans here and strings there, and a duplicate key is an error here.
// - Characters Python counts as digits or whitespace and JavaScript does not
//   (fullwidth digits, U+0085, a byte order mark) read differently in the `bool`
//   cast.
// - An undefined variable is an error, as said above.
//
// Answers that no question owns and no template reads are unused.
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
      if (typeof answer === 'number' && Number.isSafeInteger(answer)) return answer;
      if (typeof answer === 'string' && INTEGER.test(answer) && Number.isSafeInteger(Number.parseInt(answer, 10)))
        return Number.parseInt(answer, 10);
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

const DECIMAL = '\\d+(?:_\\d+)*';
/** What Python's `float()` reads: a decimal with a sign, a fraction, an exponent and underscores between digits, or nan and inf. */
const PYTHON_FLOAT = new RegExp(
  `^[+-]?(?:(?:${DECIMAL}(?:\\.(?:${DECIMAL})?)?|\\.${DECIMAL})(?:e[+-]?${DECIMAL})?)$`,
  'i',
);
const FALSE_WORDS = ['', 'n', 'no', 'f', 'false', 'off', '~', 'null', 'none'];

/** `cast_to_bool` of copier: a number by its value, a string that Python reads as a number the same, a string else by its words, anything else by its truthiness. */
function toBool(source: unknown): boolean {
  if (typeof source === 'number') return source !== 0;
  if (typeof source === 'string') {
    const text = source.trim();
    if (PYTHON_FLOAT.test(text)) {
      const number = Number(text.replaceAll('_', ''));
      return number !== 0;
    }
    return !FALSE_WORDS.includes(text.toLowerCase());
  }
  if (Array.isArray(source)) return source.length > 0;
  if (typeof source === 'object' && source !== null) return Object.keys(source).length > 0;
  return Boolean(source);
}

/** YAML 1.1 by the `yaml` package, which copier's PyYAML is close to but not: `yes` and `on` are booleans, `010` is octal. */
function parseYaml11(text: string): unknown {
  return parseYaml(text, { version: '1.1' });
}

/** The values of a map of choices, in its order; a null value stands for its label. */
function labelled(entries: Iterable<[unknown, unknown]>): unknown[] {
  return [...entries].map(([label, choice]) => (choice === null ? cast('str', label) : choice));
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

const MISSING = Symbol('missing');

/** The answer of one question, cast, checked against its choices and validated, or `MISSING` where there is none to resolve. */
function resolve(question: Question, given: Answers, seen: Context, applies: boolean): unknown {
  const isGiven = Object.hasOwn(given, question.name);
  const hasDefault = Object.hasOwn(question, 'default');
  if (!isGiven && !hasDefault) return MISSING;
  const answer = isGiven
    ? accept(question, given[question.name], seen)
    : accept(question, field('default', question.default, seen), seen);
  // A default is not validated for a skipped question; a given answer always is.
  if (question.validator !== undefined && (applies || isGiven)) {
    const message = String(field('validator', question.validator, { ...seen, [question.name]: answer })).trim();
    if (message !== '') throw new Error(message);
  }
  return answer;
}

/** The questions `manifest` owns, resolved against `given` with `scope` in view; problems go to `errors`. */
export function resolveAnswers(manifest: Manifest, given: Answers, scope: Context, errors: RenderError[]): Resolution {
  const answers: Record<string, unknown> = {};
  // Every given answer to one of the template's questions is in view from the start, as it is given,
  // and gives way to the answer its question resolves to.
  const context: Context = {};
  for (const { name } of manifest.questions) if (Object.hasOwn(given, name)) context[name] = given[name];
  for (const question of manifest.questions) {
    try {
      // What the question sees: the scope, and this template's answers so far, given or resolved.
      const seen = { ...scope, ...context };
      const applies = question.when === undefined || toBool(field('when', question.when, seen));
      const answer = resolve(question, given, seen, applies);
      if (answer !== MISSING) {
        context[question.name] = answer;
        if (applies) answers[question.name] = answer;
      } else if (applies) {
        const help = question.help === undefined ? '' : `: ${question.help}`;
        errors.push({ template: manifest.name, question: question.name, message: `no answer and no default${help}` });
      }
    } catch (error) {
      errors.push({ template: manifest.name, question: question.name, message: messageOf(error) });
    }
  }
  return { answers, context };
}

/** The names of the `given` answers that no question of the render's `manifests` owns and none of them reads. */
export function unusedAnswers(manifests: readonly Manifest[], given: Answers): string[] {
  const used = new Set(manifests.flatMap(({ questions, reads }) => [...questions, ...reads].map(({ name }) => name)));
  return Object.keys(given).filter((name) => !used.has(name));
}
