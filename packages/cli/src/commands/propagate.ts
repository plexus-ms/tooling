// plx propagate [dir]: `plx update` in every repo generated from the templates
// under a directory (§ 3 PLX-Updates). The operator's convenience: the same
// verb, the same published versions and the same triggers, over many repos, with
// one summary of what rests, what is clean, conflicted or failed, and the pull
// requests. It needs no checkout of the upstream. --now and --to ask for
// every repo at once, which is how a hotfix reaches the repos that need it.
//
//   plx propagate ~/dev                   # every repo that needs the newest version
//   plx propagate ~/dev --now             # every repo, whatever its triggers say
//   plx -n propagate ~/dev --now          # preview in worktrees, push nothing
//   plx -y propagate ~/dev --to 0.66.0 # unattended: copier takes defaults
import { resolve } from 'node:path';
import { isClean, parseMaxAge, propagate, renderSummary } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf } from '../program.ts';

export function register(program: Command): void {
  program
    .command('propagate')
    .description(
      'run update in every repo generated from the templates under a directory: each takes the newest version when it needs it, as one pull request per repo',
    )
    .argument('[dir]', 'a directory the repos sit under, at any depth', '.')
    .option(
      '--to <version>',
      "the version every repo takes, whatever the triggers say (default: each template's newest)",
    )
    .option('--now', 'take the newest version in every repo, whatever the triggers say')
    .option(
      '--max-age <days>',
      "the backstop for every repo (default: each repo's answer update_max_age, else 30; 0 takes every version)",
      (v: string) => parseMaxAge(v, '--max-age'),
    )
    .action(async (dir: string, opts: { to?: string; now?: boolean; maxAge?: number }, command: Command) => {
      const ctx = contextOf(command);
      const result = await propagate(ctx, { dir: resolve(dir), to: opts.to, now: opts.now, maxAge: opts.maxAge });
      const flags = [opts.to ? `--to ${opts.to}` : '', opts.now ? '--now' : ''].filter(Boolean).join(' ');
      ctx.result(result, (r) => renderSummary(r, `plx -y propagate ${flags} ${dir}`.replace(/ +/g, ' ')));
      if (!isClean(result)) process.exitCode = 1;
    });
}
