// plx-template, the command line around the core: the shell that reads
// directories and JSON, calls `render` or `merge`, and writes the results. It
// holds no decision of its own.
import { parseArgs } from 'node:util';

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
      if (command === 'render' && positionals.length < 2)
        throw new UsageError('render takes an output directory and a template');
      if (command === 'merge' && positionals.length !== 3) throw new UsageError('merge takes three directories');
      throw new Error(`${command} is not implemented`);
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
