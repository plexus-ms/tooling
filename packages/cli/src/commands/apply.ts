// plx apply [dir]: bring a repo's files in line with its markers (the second
// step of edit, apply, commit). The procedure, and the one gap, are in
// lib's apply.ts; this file maps the arguments and prints the result.
//
// The result is one block per site that changed, `<outcome> <path>` per file
// the merge touched and `+ <answer>: <value>` per default written into the
// marker; `--json` prints the same as data. Exit code 1 when a file is
// conflicted: a conflict stays in the file between `<<<<<<< current` and
// `>>>>>>> new render`, or the file is kept as the user edited it where the
// template dropped it. Nothing is committed.
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
      if (applied.conflicted > 0) {
        ctx.done(`${applied.conflicted} conflicted: resolve them, then commit`, false);
        process.exitCode = 1;
      } else if (applied.applied) ctx.done('applied; review the diff, then commit');
      else if (applied.sites.length === 0) ctx.done('nothing to apply: no marker differs from HEAD');
    });
}

export function renderApplied(applied: Applied): string {
  return applied.sites
    .flatMap((s) => [
      s.dir,
      ...s.report.map((e) => `  ${e.outcome} ${e.path}`),
      ...Object.entries(s.defaults).map(([key, value]) => `  + ${key}: ${JSON.stringify(value)}`),
    ])
    .join('\n');
}
