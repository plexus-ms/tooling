// plx update [dir]: this repo takes a version by its step and a schedule (§ 3
// PLX-Updates), as a pull request on `plexus/<version>`: the templates of the
// version the repo is on and of the one it takes, rendered and merged at every
// site, the version in the root marker, the lockfile, the workflow refs; how,
// is lib's update.ts. A patch (a hotfix) is taken at once, a
// minor (routine) once the oldest version not taken is as old as the repo's
// interval, a major (a changed contract) only when asked (--now, or --to);
// otherwise the repo rests and says why. The pull request asks the users the
// root marker's answer pr_reviewers names for a review, or those --reviewer names
// instead (repeatable or comma-separated; an empty one asks nobody), once,
// when it is opened. Mounted by the templates'
// plx-update.yml on a schedule in the tenant's own CI, and run by hand from a
// checkout otherwise; the checkout itself is never touched.
//
// -r (--recursive) does the same in every repo generated from the templates
// under the directory, at any depth, with the same options for each: the
// operator's convenience for many repos checked out side by side, with one
// summary over all of them. Without it, the directory is the one repo.
//
//   plx update                      # the version the schedule takes, if any
//   plx update --now                # the newest version, whatever its step
//   plx -n update --now             # preview in a worktree, push nothing
//   plx -y update --to 0.102.0      # unattended (CI)
//   plx update -r ~/dev             # every repo under ~/dev, the version its schedule takes
//   plx -y update -r ~/dev --now    # every repo, the newest version, unattended
//   plx update --reviewer alice,bob # these two review it, whatever the answers say
import { resolve } from 'node:path';
import {
  isClean,
  parseMaxAge,
  parseReviewers,
  renderSummary,
  summarize,
  update,
  updateRecursive,
} from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf, version } from '../program.ts';

interface Opts {
  recursive?: boolean;
  to?: string;
  now?: boolean;
  maxAge?: number;
  reviewer?: string[];
}

export function register(program: Command): void {
  program
    .command('update')
    .description(
      'take a version as a pull request on plexus/<version> (the templates merged at every site, the version in the root marker, the lockfile, the workflow refs): a patch at once, a minor at the next scheduled pull (--max-age), a major only when asked; -r in every repo generated from the templates under a directory',
    )
    .argument('[dir]', 'a repo whose root PLEXUS.md names its version; with -r, a directory the repos sit under', '.')
    .option('-r, --recursive', 'run in every repo generated from the templates under the directory, at any depth')
    .option('--to <version>', 'take this version, whatever its step: asking')
    .option('--now', 'take the newest version, whatever its step: asking')
    .option(
      '--max-age <days>',
      "the interval: a minor version is taken once the oldest one not taken is this many days old (default: the root marker's answer update_max_age, else 7; 0 takes every version)",
      (v: string) => parseMaxAge(v, '--max-age'),
    )
    .option(
      '--reviewer <login>',
      "a GitHub user asked to review the pull request it opens, repeatable or comma-separated; instead of the root marker's answer pr_reviewers ('' asks nobody)",
      (v: string, previous: string[] = []) => [...previous, ...parseReviewers(v, '--reviewer')],
    )
    .action(async (dir: string, opts: Opts, command: Command) => {
      const ctx = contextOf(command);
      const { recursive, reviewer, ...asked } = opts;
      const options = { ...asked, plxVersion: version, ...(reviewer ? { reviewers: [...new Set(reviewer)] } : {}) };
      const outcomes = recursive
        ? await updateRecursive(ctx, { dir: resolve(dir), ...options })
        : [await update(ctx, { repo: resolve(dir), ...options })];
      const result = summarize(outcomes, ctx.dryRun, opts.to);
      // The real run of a clean preview: the one version taken, or, over many repos, what was asked of each.
      const flags = recursive
        ? ['-r', opts.to ? `--to ${opts.to}` : '', opts.now ? '--now' : '']
        : [`--to ${result.version}`];
      if (reviewer) flags.push(`--reviewer '${[...new Set(reviewer)].join(',')}'`);
      const real = `plx -y update ${flags.filter(Boolean).join(' ')} ${dir}`;
      ctx.result(result, (r) => renderSummary(r, real, recursive ? 'update --recursive' : 'update'));
      if (!isClean(result)) process.exitCode = 1;
    });
}
