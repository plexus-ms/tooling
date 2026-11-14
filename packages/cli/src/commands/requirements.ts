// plx requirements [dir]: the requirements check (§ 1.8 PLX) and the lints
// that keep one home per fact, over any repo.
//
// In the compendium: the map and every module page, no date or version number
// in prose; in a template: short file headers; everywhere: every cited section
// and requirement name exists, no issue identifier. lib's `checkRepo` does the
// work against the repo's baseline; defects are the result, one per line, and
// the exit code is 1 when there is any. Citations resolve against the
// compendium checked, a checkout given with --compendium, or the index this plx
// carries, its own Plexus version's.
//
//   plx requirements .                         # lint; the hooks' and `mise check`'s step
//   plx requirements . --write-baseline        # record today's violations as known
//   plx requirements --commit-msg .git/COMMIT_EDITMSG   # the commit-msg hook
//   plx requirements . --extract contracts/app.md
import { join, resolve } from 'node:path';
import {
  BASELINE_FILE,
  checkCommitMessage,
  checkRepo,
  extractRequirements,
  planBaseline,
  type RepoCheck,
  renderViolation,
} from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf } from '../program.ts';

interface Options {
  extract?: string;
  writeBaseline?: boolean;
  commitMsg?: string;
  compendium?: string;
}

export function register(program: Command): void {
  program
    .command('requirements')
    .description(
      "lint a repo: the standard's pages in the compendium, citations, dates, template headers and issue identifiers everywhere",
    )
    .argument('[dir]', 'a repo checkout: the compendium, a template or any other repo', '.')
    .option('--extract <page>', "print a module page's requirement lines instead of linting (path relative to dir)")
    .option('--write-baseline', `record every current violation in ${BASELINE_FILE} as known, instead of checking`)
    .option('--commit-msg <file>', 'check a commit message for issue identifiers instead (the commit-msg hook)')
    .option('--compendium <dir>', "resolve citations against this compendium checkout, not this plx's own index")
    .action(async (dir: string, opts: Options, command: Command) => {
      const ctx = contextOf(command);
      const repo = resolve(dir);
      const options = { compendium: opts.compendium ? resolve(opts.compendium) : undefined };
      if (opts.extract) {
        ctx.result(extractRequirements(await ctx.readFile(join(repo, opts.extract))));
        return;
      }
      if (opts.commitMsg) {
        const violations = await checkCommitMessage(ctx, resolve(opts.commitMsg), repo);
        ctx.result(violations, (vs) => vs.map(renderViolation).join('\n'));
        if (violations.length > 0) process.exitCode = 1;
        return;
      }
      if (opts.writeBaseline) {
        await ctx.apply(await planBaseline(ctx, repo, options));
        return;
      }
      const check = await checkRepo(ctx, repo, options);
      ctx.result(check, renderCheck);
      if (check.defects.length > 0) process.exitCode = 1;
    });
}

export function renderCheck(c: RepoCheck): string {
  if (c.defects.length > 0) return c.defects.join('\n');
  const what =
    c.kind === 'compendium' ? `the map, ${c.contracts} contracts and ${c.approaches} approaches are well-formed; ` : '';
  const known = c.known > 0 ? `, ${c.known} known violations in ${BASELINE_FILE}` : '';
  return `✓ ${what}citations resolve against ${c.against}${known}`;
}
