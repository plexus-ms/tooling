// The answers a template sees: its questions resolved against the given
// answers. For now each question takes the given answer of its name, and one
// without a given answer is left out.
import type { Answers, Manifest, RenderError } from './types.ts';

/** The answers to the questions `manifest` owns, from `given`; its problems go to `errors`. */
export function resolveAnswers(manifest: Manifest, given: Answers, _errors: RenderError[]): Answers {
  return Object.fromEntries(
    manifest.questions.filter((q) => Object.hasOwn(given, q.name)).map((q) => [q.name, given[q.name]]),
  );
}
