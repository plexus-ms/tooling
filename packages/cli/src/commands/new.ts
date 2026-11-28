// plx new <dir> <template>...: create a repo or an app from templates and
// answers, the verb that replaces `copier copy`. The procedure is in lib's
// newSite.ts; this file maps the arguments and prints the result.
//
// The directory must be empty or absent. In a git repo whose root holds a
// PLEXUS.md, tracked or not (a repo just born has committed nothing), it is a
// new app, rendered with the root's answers plus the given ones, and refused
// where the root lists templates and is on another version than this plx or
// names none; anywhere else it is a
// new repo. The templates are the ones this
// plx bundles, named as the directories of `templates/` are (repo-turbo,
// repo-operations, app-nextjs). Answers come as `-a key=value`, repeatable,
// and as a JSON object in a file (`--answers`); a flag wins over the file, a
// value is cast to its question's type. Nothing is ever asked: a missing
// answer fails the run, listing every missing question with its help. A given
// answer that no template asks is named and ignored.
//
// The result is `<repo|app> <dir>` and one `+ <path>` line per file written,
// as data under --json; the birth commands the templates declare run in the
// directory after the files are written, each printed before it runs. A dry
// run writes and runs nothing and prints the same. Nothing is committed.
//
//   plx new ~/dev/acme/web repo-turbo -a tenant=acme
//   plx new ~/dev/acme/web/apps/shop app-nextjs -a name=shop -a profile=stateful
//   plx new ./ops repo-operations --answers ops.json
//   plx -n new ./web repo-turbo -a tenant=acme      # what it would write and run
import { resolve } from 'node:path';
import { type Context, type Created, newSite, UsageError } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf, version } from '../program.ts';

interface Opts {
  answer: string[];
  answers?: string;
  templates?: string;
}

/** `key=value` as one answer; the value is everything after the first `=`, a string for the engine to cast. */
export function parseAnswer(pair: string): [string, string] {
  const at = pair.indexOf('=');
  if (at < 1) throw new UsageError(`an answer is written key=value, not ${JSON.stringify(pair)}`);
  return [pair.slice(0, at), pair.slice(at + 1)];
}

/** The JSON object of answers in `file`; a file that is missing, no JSON or no object is a usage error naming `--answers`. */
export async function readAnswersFile(ctx: Context, file: string): Promise<Record<string, unknown>> {
  const text = await ctx.readFile(resolve(file)).catch((error: Error) => {
    throw new UsageError(`--answers ${file} cannot be read: ${error.message}`);
  });
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`--answers ${file} is not JSON: ${(error as Error).message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new UsageError(`--answers ${file} must hold a JSON object of answers by name`);
  return data as Record<string, unknown>;
}

export function register(program: Command): void {
  program
    .command('new')
    .description(
      'create a repo, or an app inside a repo, from templates and answers: render, write the files and the marker, run the birth commands; never asks a question',
    )
    .argument('<dir>', 'the directory to create, empty or absent: an app in the repo it lies in, else a new repo')
    .argument('<template...>', 'the templates to render together, by name')
    .option(
      '-a, --answer <key=value>',
      'an answer, repeatable; a value is cast to its question’s type',
      (pair: string, previous: string[]) => [...previous, pair],
      [] as string[],
    )
    .option('--answers <file>', 'a JSON object of answers by name; an --answer flag wins over it')
    .option(
      '--templates <dir>',
      'the root of the templates, one directory per template (default: the templates this plx bundles)',
    )
    .action(async (dir: string, names: string[], opts: Opts, command: Command) => {
      const ctx = contextOf(command);
      const fromFile = opts.answers ? await readAnswersFile(ctx, opts.answers) : {};
      const answers = { ...fromFile, ...Object.fromEntries(opts.answer.map(parseAnswer)) };
      const created = await newSite(ctx, {
        dir: resolve(dir),
        templates: names,
        answers,
        plxVersion: version,
        ...(opts.templates ? { root: resolve(opts.templates) } : {}),
      });
      ctx.result(created, renderCreated);
      if (created.unused.length > 0)
        ctx.say(`no template asks ${created.unused.map((key) => `\`${key}\``).join(', ')}: ignored`);
      ctx.done(`${ctx.dryRun ? 'dry run: nothing written, for the' : 'created'} ${created.kind} at ${created.dir}`);
    });
}

export function renderCreated(created: Created): string {
  return [`${created.kind} ${created.dir}`, ...created.files.map((path) => `  + ${path}`)].join('\n');
}
