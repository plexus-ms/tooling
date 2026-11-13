// plx-dev ship [dir]: cut the version (§ 1.5 PLX), and nothing after it.
//
// ../ship.ts does the work: preflight, bookkeeping, tags, releases, the wait
// for npm. It opens no pull request: a repo takes the version itself, when it
// needs it (`plx update`), and `plx propagate --now` asks many at once. This
// file maps the arguments and renders the outcome. -n previews the release as
// its steps and tries the unreleased templates on the workspace's consumers in
// scratch clones, with a summary; -y is required off a terminal.
//
//   plx-dev ship ~/dev                 # next version = minor+1 over the latest
//   plx-dev -n ship ~/dev              # preview, change nothing in the workspace
//   plx-dev -y ship ~/dev --to 1.0.0
//   mise ship -- -n                    # the same from tooling, built first
import { resolve } from 'node:path';
import { isClean, renderSummary } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf } from '../program.ts';
import { ship } from '../ship.ts';

export function register(program: Command): void {
  program
    .command('ship')
    .description(
      'cut the version: tag and release every versioned repo identically; repos take it themselves (plx update, plx propagate)',
    )
    .argument('[dir]', 'the workspace: plexus-ms/ sits under it, and the consumers the dry run previews', '.')
    .option('--to <version>', 'the Plexus version, plain semver (default: minor+1 over the latest version)')
    .action(async (dir: string, opts: { to?: string }, command: Command) => {
      const ctx = contextOf(command);
      const result = await ship(ctx, { workspace: resolve(dir), to: opts.to });
      ctx.result(result, (r) =>
        r.preview
          ? renderSummary(r, `plx-dev -y ship --to ${r.version} ${dir}`, 'ship')
          : `✓ Plexus ${r.version} cut — repos take it themselves; to take it now where it matters: plx propagate --now ${dir}`,
      );
      if (!isClean(result)) process.exitCode = 1;
    });
}
