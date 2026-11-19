// plx update [dir]: this repo takes a version by its step and a schedule (§ 3
// PLX-Updates), as a pull request on `plexus/<version>`: copier update at every
// site, the marker, the lockfile, the workflow refs. A patch (a hotfix) is
// taken at once, a minor (routine) once the oldest version not taken is as old
// as the repo's interval, a major (a changed contract) only when asked (--now,
// or --to); otherwise the repo rests and says why. Mounted by the templates'
// plx-update.yml on a schedule in the tenant's own CI, and run by hand from a
// checkout otherwise; the checkout itself is never touched.
//
//   plx update                      # the version the schedule takes, if any
//   plx update --now                # the newest version, whatever its step
//   plx -n update --now             # preview in a worktree, push nothing
//   plx -y update --to 0.102.0   # unattended (CI): copier takes defaults
import { resolve } from 'node:path';
import { isClean, parseMaxAge, renderSummary, update } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf } from '../program.ts';

export function register(program: Command): void {
  program
    .command('update')
    .description(
      'take a version as a pull request on plexus/<version> (copier update at every site, the marker, the lockfile, the workflow refs): a patch at once, a minor at the next scheduled pull (--max-age), a major only when asked',
    )
    .argument('[dir]', 'a repo generated from the templates', '.')
    .option('--to <version>', 'take this version, whatever its step: asking')
    .option('--now', 'take the newest version, whatever its step: asking')
    .option(
      '--max-age <days>',
      "the interval: a minor version is taken once the oldest one not taken is this many days old (default: the repo's answer update_max_age, else 7; 0 takes every version)",
      (v: string) => parseMaxAge(v, '--max-age'),
    )
    .action(async (dir: string, opts: { to?: string; now?: boolean; maxAge?: number }, command: Command) => {
      const ctx = contextOf(command);
      const result = await update(ctx, { repo: resolve(dir), to: opts.to, now: opts.now, maxAge: opts.maxAge });
      ctx.result(result, (r) => renderSummary(r, `plx -y update --to ${r.version} ${dir}`, 'update'));
      if (!isClean(result)) process.exitCode = 1;
    });
}
