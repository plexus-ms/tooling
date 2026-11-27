// plx-template, the command line around the core: the shell that reads
// directories and JSON, calls `render` or `merge`, and writes the results. It
// holds no decision of its own; every one is the core's (types.ts, render.ts,
// merge.ts). `plx-template --help` says how to call it; this says what it does.
//
// An update by hand, in three commands. A directory `project` was rendered
// from version 1 of the templates, and its owner has edited it since. Version
// 1 of the templates is in `v1/`, version 2 in `v2/`, and `answers.json`
// holds the answers the project was rendered with:
//
//   plx-template render --answers answers.json old v1/basket v1/shelf
//   plx-template render --answers answers.json new v2/basket v2/shelf
//   plx-template merge old new project
//
// The first two write the two renders, `old` and `new`, which must not exist
// yet or be empty; the third changes `project` and prints what it did to each
// path. Look at `diff -r old new` to see what the template changed, and at the
// markers the third left (below) to see what is yours to decide. Nothing else
// is needed: no state is kept, no command is run, git is run only to merge the
// text of a file that both sides changed, `git merge-file`, and its results are
// the ones `git merge-file -p -L current -L "old render" -L "new render"` gives.
//
// What `render` does. It reads each template directory into a tree (its
// manifest `template.yml` and its `files/`, manifest.ts), reads the answers,
// gives both to the core, and, where the core reports no error, writes the
// rendered tree to the output directory, creating it where it is missing, and
// the policies file beside it. It refuses an output directory that is not
// empty, and a template or an answers file it cannot read, as errors in the
// inputs; it writes nothing at all when there is any. It runs no birth
// command: they are in the JSON, for the caller.
//
// How the policies travel from `render` to `merge`. `merge` needs the policy
// of every path of both renders (`merge` or `born-once`, types.ts). `render`
// writes them to `<output-dir>.plx-template.json` beside the rendered
// directory, `{ "files": { "<path>": { "template": ..., "policy": ... } } }`,
// the `files` of its own JSON; `merge` reads the file beside each of its two
// directories. It is beside the render and not in it so that the directory
// holds exactly the files the templates rendered: a file inside would be taken
// for one of them by `merge` and by a person comparing two renders with
// `diff -r`. A render moved or copied needs its policies file moved with it;
// `merge` fails, naming the file it expected, where one is missing or is not
// what `render` writes. Output directory `old/` or `old` give the same file.
//
// What `merge` reads of the target directory. Not all of it: for each path of
// either render, the entry at the path (a file with its bytes and mode, a
// symlink with its target), the first leaf below it where it is a directory,
// and each directory above it that is a symlink or a file, where the walk
// stops. That answers every rule of merge.ts, which looks at the path and at
// "entries below it" and at the directories the path lies in, and it leaves
// `.git`, `node_modules` and everything the templates do not name unread.
// Nothing is read through a symlink.
//
// How `merge` writes. It applies the report of the core to the target:
// `added`, `clean` and `conflicted` paths are written where the merged entry
// differs from what is on disk, `deleted` ones are removed, `kept` ones are
// left alone, and a path the report does not name is never touched (directory.ts
// has the details). A conflict stays in the file between the markers
// `<<<<<<< current` and `>>>>>>> new render`, the user's lines first, so that
// it can be found with `grep -rn '^<<<<<<< current'`. Nothing is written
// through a symlink or deleted through one. An existing file keeps its
// permissions but for its executable bits, and is never given more than
// execute where it may already read: 0o600 becomes 0o700 and 0o644 becomes
// 0o755. A deletion that leaves a directory empty removes it, upward to the
// target and no further, as copier does, unless the new render holds it as an
// empty directory; `merge` itself never deletes a directory, and an empty
// directory that was there already stays.
//
// Standard output carries only JSON, messages for people go to standard error.
//   render prints { answers, unused, files, birth, errors }: the core's result
//          without the tree, `files` and `answers` by name. `files` maps each
//          path, an empty directory too, to { template, policy }; `birth` lists
//          { template, command } as the templates declare them. `errors` is
//          empty on success.
//   merge  prints { report: [{ path, outcome }] } in path order, `outcome` one
//          of clean, added, deleted, conflicted or kept (types.ts).
//   an error in the inputs prints, for merge, { errors }, and for render its
//          usual object with `errors` filled; each error is { message,
//          template?, path?, question?, other? }, every one found is listed,
//          and each is repeated on standard error with what it concerns.
//
// The exit codes (`EXIT`): 0 done, a merge that left conflicts too; 1 failed:
// something other than the inputs went wrong, a file that cannot be written or
// git that cannot be run; 2 a usage error, with nothing on standard output;
// 3 an error in the inputs: a missing answer, paths two templates write, a bad
// manifest, a directory or policies file that is missing, an output directory
// that is not empty.
//
// Answers arrive as JSON, a file or `-` for standard input, and are never
// asked for. The command is the only code of the package, with directory.ts and
// git-merge-file.ts, that touches the filesystem or runs a command
// (boundary.test.ts).
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { text as readAll } from 'node:stream/consumers';
import { parseArgs } from 'node:util';
import { applyChanges, readCurrent, readTree, requireDirectory, requireEmpty } from './directory.ts';
import { InputError, messageOf } from './errors.ts';
import { gitMergeFile, merge, render } from './index.ts';
import {
  type Answers,
  DIRECTORY,
  type Entry,
  MODE_TYPE,
  type Policies,
  type Policy,
  type RenderError,
  type RenderResult,
  SYMLINK,
  type Tree,
} from './types.ts';

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
  errors    instead of report, where the inputs are wrong: { message, path? }

Exit codes: 0 merged, also when conflicts are left; 1 failed; 2 usage error;
3 errors in the inputs, such as a missing policies file, listed under errors
and on standard error, with nothing written.
`;

class UsageError extends Error {}

const POLICIES: readonly string[] = ['merge', 'born-once'] satisfies Policy[];

/** Runs steps that may fail with an input error, keeping each failure, so that a command reports them all. */
function collector() {
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
  /** Whether `step` passed, for a step that gives nothing. */
  const holds = async (step: () => Promise<void>): Promise<boolean> =>
    (await attempt(() => step().then(() => true))) === true;
  return { problems, attempt, holds };
}

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

/** The policies `render` wrote beside the render in `dir`. */
async function readPolicies(dir: string): Promise<Policies> {
  const file = policiesOf(dir);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new InputError(`no policies file for ${dir}: \`render\` writes one beside the render it writes`, file);
  }
  let files: unknown;
  try {
    files = (JSON.parse(text) as { files?: unknown }).files;
  } catch (error) {
    throw new InputError(`the policies file is no JSON: ${messageOf(error)}`, file);
  }
  const entries = typeof files === 'object' && files !== null ? Object.entries(files) : undefined;
  if (
    entries === undefined ||
    entries.some(([, v]) => !POLICIES.includes((v as { policy?: string } | null)?.policy as string))
  )
    throw new InputError('the policies file is not what `render` writes: files by path, each with a policy', file);
  return new Map(entries as [string, { policy: Policy }][]);
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

/** The JSON a command prints when its inputs are wrong. */
function refuse(errors: readonly RenderError[]): number {
  print({ errors });
  complain(errors);
  return EXIT.input;
}

/** A render directory as a tree with its policies; a symlink in it is an input error, for it is no render. */
async function readRender(
  dir: string,
  { problems, attempt }: ReturnType<typeof collector>,
): Promise<{ tree: Tree; policies: Policies } | undefined> {
  const tree = await attempt(() => readTree(dir));
  if (tree === undefined) return undefined;
  const links = [...tree].filter(([, e]) => (e.mode & MODE_TYPE) === SYMLINK).map(([path]) => join(dir, path));
  for (const path of links) problems.push({ message: 'is a symlink, and a render holds none', path });
  if (links.length > 0) return undefined;
  const policies = await attempt(() => readPolicies(dir));
  return policies && { tree, policies };
}

async function mergeCommand(oldDir: string, newDir: string, target: string): Promise<number> {
  const found = collector();
  const { problems, attempt, holds } = found;
  const oldRender = await readRender(oldDir, found);
  const newRender = await readRender(newDir, found);
  const present = await holds(() => requireDirectory(target));
  const current =
    present &&
    oldRender &&
    newRender &&
    (await attempt(() => readCurrent(target, new Set([...oldRender.tree.keys(), ...newRender.tree.keys()]))));
  if (!oldRender || !newRender || !current || problems.length > 0) return refuse(problems);
  const old = oldRender.tree;
  const next = newRender.tree;
  const oldPolicies = oldRender.policies;
  const newPolicies = newRender.policies;
  const { tree, report } = await merge(
    { old, new: next, current, files: { old: oldPolicies, new: newPolicies } },
    gitMergeFile,
  );
  const changes = new Map<string, Entry | undefined>();
  for (const { path, outcome } of report) {
    if (outcome === 'deleted') changes.set(path, undefined);
    else if (outcome !== 'kept' && tree.has(path)) changes.set(path, tree.get(path));
  }
  const directories = new Set([...next].filter(([, e]) => (e.mode & MODE_TYPE) === DIRECTORY).map(([path]) => path));
  await applyChanges(target, changes, directories);
  print({ report });
  return EXIT.ok;
}

async function renderCommand(
  answersFile: string | undefined,
  out: string,
  templates: readonly string[],
): Promise<number> {
  const { problems, attempt } = collector();
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
      const [oldDir, newDir, target, ...extra] = positionals;
      if (oldDir === undefined || newDir === undefined || target === undefined || extra.length > 0)
        throw new UsageError('merge takes three directories');
      return await mergeCommand(oldDir, newDir, target);
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
