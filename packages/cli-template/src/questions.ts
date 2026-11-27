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
// For now a question takes the given answer of its name and nothing else, and
// a question without one is absent from both; no answer is reported unused.
import type { Context } from './jinja.ts';
import type { Answers, Manifest, RenderError } from './types.ts';

/** One template's questions, resolved. */
export interface Resolution {
  /** The answers `render` reports: given or defaulted, without the questions `when` skipped. */
  readonly answers: Answers;
  /** What the questions add to the template's context: the answers, and the default of each skipped question that has one. */
  readonly context: Context;
}

/** The questions `manifest` owns, resolved against `given` with `scope` in view; problems go to `errors`. */
export function resolveAnswers(
  manifest: Manifest,
  given: Answers,
  _scope: Context,
  _errors: RenderError[],
): Resolution {
  const answers = Object.fromEntries(
    manifest.questions.filter((q) => Object.hasOwn(given, q.name)).map((q) => [q.name, given[q.name]]),
  );
  return { answers, context: answers };
}

/** The names of the `given` answers that no template of the render owns or reads, `manifests` being the render's. */
export function unusedAnswers(_manifests: readonly Manifest[], _given: Answers): string[] {
  return [];
}
