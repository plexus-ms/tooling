// plx-template, the command line around the core: the shell that reads
// directories and JSON, calls `render` or `merge`, and writes the results. It
// holds no decision of its own.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { text as readAll } from 'node:stream/consumers';
import { parseArgs } from 'node:util';
import { applyChanges, readTree, requireEmpty } from './directory.ts';
import { InputError, messageOf } from './errors.ts';
import { render } from './index.ts';
import type { Answers, RenderError, RenderResult, Tree } from './types.ts';

/** The exit codes. */
export const EXIT = { ok: 0, failed: 1, usage: 2, input: 3 } as const;

const HELP = `plx-template: render templates into a directory, and merge a new render into a directory that has local edits.

Usage:
  plx-template render [--answers <file|->] <output-dir> <template-dir>...
  plx-template merge <old-dir> <new-dir> <target-dir>
  plx-template <command> --help

render   Renders the templates with the answers into <output-dir>, and writes the
         policy of each path beside it.
merge    Three-way merges what changed from <old-dir> to <new-dir>, two renders,
         into <target-dir>, and prints what happened to each path.

Answers are JSON, from a file or from standard input. Standard output carries
only JSON; messages for people go to standard error.
The exit codes are:
  0  done; a merge that left conflicts is done, its report says which
  1  failed: the command could not read or write, or git is missing
  2  a usage error: an unknown command or option, a missing argument
  3  an error in the inputs, each listed in the JSON and on standard error
`;

const RENDER_HELP = `Usage: plx-template render [--answers <file|->] <output-dir> <template-dir>...

Renders the templates, which are rendered together as one, into <output-dir>.
<output-dir> must be empty or missing, and is created. Beside it, in
<output-dir>.plx-template.json, the command writes the owner and policy of each
path, which \`merge\` reads; nothing is written when the render has errors.

  --answers <file|->  A JSON object of answers, from a file or, with -, from
                      standard input. Without it there are none: the command
                      never asks.

Standard output is one JSON object:
  answers   the resolved answers, defaults of new questions included
  unused    the names of given answers no template owns or reads
  files     each rendered path with its template and policy
  birth     the birth commands the templates declare, never run: { template, command }
  errors    every error: { message, template?, path?, question?, other? }

Exit codes: 0 rendered; 1 failed; 2 usage error; 3 errors in the inputs, which
are listed under errors and on standard error, with nothing written.
`;

const MERGE_HELP = `Usage: plx-template merge <old-dir> <new-dir> <target-dir>

Takes two renders, <old-dir> and <new-dir>, as \`render\` wrote them with their
<dir>.plx-template.json files beside them, and merges what the template changed
into <target-dir>, which is edited in place. A conflict stays in the file as
markers; a file the template removed and the user edited is kept.

Standard output is one JSON object:
  report    one entry per path touched: { path, outcome }, in path order, the
            outcome one of clean, added, deleted, conflicted or kept

Exit codes: 0 merged, also when conflicts are left; 1 failed; 2 usage error;
3 errors in the inputs, such as a missing policies file, listed under errors
and on standard error, with nothing written.
`;

class UsageError extends Error {}

/** Where `render` writes the policies of the render in `dir`: beside it, so that no file of the render is one it did not render. */
export const policiesOf = (dir: string): string => `${resolve(dir)}.plx-template.json`;

/** Writes `value` as JSON to standard output. */
function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Prints each error to standard error, with what it concerns. */
function complain(errors: readonly RenderError[]): void {
  for (const e of errors) {
    const about = [
      e.template && `template ${e.template}`,
      e.path && `path ${e.path}`,
      e.question && `question ${e.question}`,
      e.other && `other template ${e.other}`,
    ].filter(Boolean);
    process.stderr.write(`plx-template: error: ${e.message}${about.length > 0 ? ` (${about.join(', ')})` : ''}\n`);
  }
}

/** The answers: a JSON object from `source`, a file or, for `-`, standard input; none without one. */
async function readAnswers(source: string | undefined): Promise<Answers> {
  if (source === undefined) return {};
  let text: string;
  try {
    text = source === '-' ? await readAll(process.stdin) : await readFile(source, 'utf8');
  } catch (error) {
    throw new InputError(`cannot read the answers: ${messageOf(error)}`, source);
  }
  let answers: unknown;
  try {
    answers = JSON.parse(text);
  } catch (error) {
    throw new InputError(`the answers are no JSON: ${messageOf(error)}`, source);
  }
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers))
    throw new InputError('the answers are not a JSON object', source);
  return answers as Answers;
}

/** The JSON a render prints: the core's result, but for its tree. */
function renderJson(result: RenderResult | undefined, errors: readonly RenderError[]) {
  return {
    answers: result?.answers ?? {},
    unused: result?.unused ?? [],
    files: Object.fromEntries(result?.files ?? []),
    birth: result?.birth ?? [],
    errors,
  };
}

async function renderCommand(
  answersFile: string | undefined,
  out: string,
  templates: readonly string[],
): Promise<number> {
  const problems: RenderError[] = [];
  const attempt = async <T>(step: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await step();
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      problems.push(
        error.path === undefined ? { message: error.message } : { message: error.message, path: error.path },
      );
    }
  };
  const answers = await attempt(() => readAnswers(answersFile));
  const trees: Tree[] = [];
  for (const dir of templates) {
    const tree = await attempt(() => readTree(dir));
    if (tree !== undefined) trees.push(tree);
  }
  await attempt(() => requireEmpty(out));
  const result = problems.length === 0 && answers !== undefined ? render(trees, answers) : undefined;
  const errors = result === undefined ? problems : result.errors;
  print(renderJson(result, errors));
  if (result === undefined || errors.length > 0) {
    complain(errors);
    return EXIT.input;
  }
  await applyChanges(out, result.tree);
  await writeFile(policiesOf(out), `${JSON.stringify({ files: Object.fromEntries(result.files) }, null, 2)}\n`);
  return EXIT.ok;
}

/** Runs the command `argv` names and returns its exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (command === undefined || command === '--help' || command === '-h') {
      if (command === undefined) throw new UsageError('no command');
      process.stdout.write(HELP);
      return EXIT.ok;
    }
    if (command === 'render' || command === 'merge') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          help: { type: 'boolean', short: 'h' },
          ...(command === 'render' ? { answers: { type: 'string' } } : {}),
        },
      });
      if (values.help) {
        process.stdout.write(command === 'render' ? RENDER_HELP : MERGE_HELP);
        return EXIT.ok;
      }
      if (command === 'render') {
        const [out, ...templates] = positionals;
        if (out === undefined || templates.length === 0)
          throw new UsageError('render takes an output directory and a template');
        return await renderCommand(values.answers as string | undefined, out, templates);
      }
      if (positionals.length !== 3) throw new UsageError('merge takes three directories');
      throw new Error('merge is not implemented');
    }
    throw new UsageError(`unknown command ${command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`plx-template: ${message}\n(run with --help for usage)\n`);
      return EXIT.usage;
    }
    process.stderr.write(`plx-template: ${message}\n`);
    return EXIT.failed;
  }
}
