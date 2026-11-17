// plx propagate [dir]: `plx update` in every repo generated from the templates
// under a directory (§ 3 PLX-Updates). The operator's convenience: the same
// verb, the same published versions and the same rule (a patch at once, a minor
// at the repo's next scheduled pull, a major only when asked), over many repos,
// with one summary of what rests, what is clean, conflicted or failed, and the
// pull requests. It needs no checkout of the upstream. --now and --to ask for
// every repo at once.
//
//   plx propagate ~/dev                   # every repo, the version its schedule takes
//   plx propagate ~/dev --now             # every repo, the newest version whatever its step
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
      'run update in every repo generated from the templates under a directory: a patch at once, a minor at the next scheduled pull (--max-age), a major only when asked, one pull request per repo',
    )
    .argument('[dir]', 'a directory the repos sit under, at any depth', '.')
    .option('--to <version>', 'the version every repo takes, whatever its step: asking')
    .option('--now', 'take the newest version in every repo, whatever its step: asking')
    .option(
      '--max-age <days>',
      "the interval for every repo, in days (default: each repo's answer update_max_age, else 7; 0 takes every version)",
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
