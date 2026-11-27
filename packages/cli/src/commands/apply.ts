// plx apply [dir]: bring a repo's files in line with its markers (the second
// step of edit, apply, commit). The procedure, and the one gap, are in
// lib's apply.ts; this file maps the arguments and prints the result.
//
// The result is one block per site that changed, `<outcome> <path>` per file
// the merge touched and `+ <answer>: <value>` per default written into the
// marker; `--json` prints the same as data. Exit code 1 when a file is
// conflicted or the answer to the prompt was no; a dry run writes nothing and
// exits 0, saying how many files would be conflicted. A conflict stays in the
// file between `<<<<<<< current` and `>>>>>>> new render`, or the file is kept
// as the user edited it where the template dropped it. Nothing is committed.
//
//   plx apply                  # this repo, after editing a marker
//   plx -n apply               # what it would write, and nothing written
//   plx apply --templates ~/dev/plexus-ms/tooling/templates ~/dev/some-repo
import { resolve } from 'node:path';
import { type Applied, apply } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf, version } from '../program.ts';

export function register(program: Command): void {
  program
    .command('apply')
    .description(
      're-render the sites whose marker changed since HEAD (answers or templates), merge into the working tree, write the defaults of new questions into the markers; commits nothing, exits 1 on a conflict',
    )
    .argument('[dir]', 'the repo, a directory inside its working tree at its top', '.')
    .option(
      '--templates <dir>',
      'the root of the templates, one directory per template (default: the templates this plx bundles)',
    )
    .action(async (dir: string, opts: { templates?: string }, command: Command) => {
      const ctx = contextOf(command);
      const applied = await apply(ctx, {
        repo: resolve(dir),
        plxVersion: version,
        ...(opts.templates ? { templates: resolve(opts.templates) } : {}),
      });
      ctx.result(applied, renderApplied);
      const { line, ok, code } = outcomeOf(applied, ctx.dryRun);
      ctx.done(line, ok);
      if (code !== 0) process.exitCode = code;
    });
}

/**
 * The last line and the exit code, true to what happened. A conflict fails
 * the run that wrote it. A dry run wrote nothing, did what it promised and
 * exits 0, naming the conflicts it foresees. An answer of no wrote nothing
 * that was asked for and exits 1, so that a script does not go on as if it had.
 */
export function outcomeOf(applied: Applied, dryRun: boolean): { line: string; ok: boolean; code: 0 | 1 } {
  if (applied.declined) return { line: 'nothing written: the answer was no', ok: false, code: 1 };
  if (applied.sites.length === 0)
    return { line: 'nothing to apply: no site that lists templates changed since HEAD', ok: true, code: 0 };
  if (dryRun) {
    const would =
      applied.conflicted > 0
        ? `, ${applied.conflicted} file${applied.conflicted === 1 ? '' : 's'} would be conflicted`
        : '';
    return { line: `dry run: nothing written${would}`, ok: true, code: 0 };
  }
  if (applied.conflicted > 0)
    return { line: `${applied.conflicted} conflicted: resolve them, then commit`, ok: false, code: 1 };
  if (applied.applied) return { line: 'applied; review the diff, then commit', ok: true, code: 0 };
  return { line: 'the markers changed nothing in the files', ok: true, code: 0 };
}

export function renderApplied(applied: Applied): string {
  return applied.sites
    .flatMap((s) =>
      s.report.length + Object.keys(s.defaults).length === 0
        ? [`${s.dir}: re-rendered, no file changed`]
        : [
            s.dir,
            ...s.report.map((e) => `  ${e.outcome} ${e.path}`),
            ...Object.entries(s.defaults).map(([key, value]) => `  + ${key}: ${JSON.stringify(value)}`),
          ],
    )
    .join('\n');
}
