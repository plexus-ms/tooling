// propagate: `update` in every repo generated from the templates under a
// directory (§ 3 PLX-Updates). The operator's convenience over the verb, for
// whoever has many repos checked out side by side, the maintainers or a
// tenant's own operator: it needs no checkout of the upstream, reads the
// published versions like `update` does, and obeys the same triggers. A repo
// that needs no version rests; `now` or a named version asks for every repo at
// once, which is how a hotfix reaches the repos that need it.
//
// Each repo is handled by `update` (update.ts) in a worktree of the branch the
// version lands on, so the checkouts stay as they are. Nothing aborts the run: a
// repo that fails is recorded and the rest continues; the summary says what
// rests, what is clean, conflicted or failed, and the pull requests.
//
//   plx propagate ~/dev                  # every repo that needs the newest version
//   plx propagate ~/dev --now            # every repo, whatever its triggers say
//   plx -n propagate ~/dev --now         # preview in worktrees, push nothing
//   plx -y propagate ~/dev --to 0.66.0
import { findConsumers, TEMPLATES, templateSource } from './consumers.ts';
import type { Context } from './context.ts';
import { overview } from './overview.ts';
import { detail, emptySummary, mergeSummary, type Summary } from './take.ts';
import { update } from './update.ts';
import { isPlexusVersion, UsageError } from './version.ts';

export interface PropagateOptions {
  /** The directory the repos sit under, at any depth. */
  dir: string;
  /** The version every repo takes, which is asking for it; default: each template's newest release. */
  to?: string;
  /** Take the newest version whatever the triggers say. */
  now?: boolean;
  /** The backstop age in days for every repo; default: each repo's own answer, else 30. */
  maxAge?: number;
  /** The clock the backstop is measured against, as a date; default: now. */
  today?: string;
}

export async function propagate(ctx: Context, options: PropagateOptions): Promise<Summary> {
  const { dir, ...rest } = options;
  if (options.to !== undefined && !isPlexusVersion(options.to))
    throw new UsageError(`'${options.to}' is not plain semver (X.Y.Z, no v)`);
  const summary = emptySummary(options.to ?? '', ctx.dryRun);
  const consumers = await findConsumers(ctx, await overview(ctx, dir), TEMPLATES);
  if (consumers.length === 0)
    ctx.say(`• no repo generated from ${TEMPLATES.map(templateSource).join(', ')} found under ${dir}`);
  for (const consumer of consumers) {
    if (consumer.skipped) {
      ctx.say(`⚠ ${consumer.rel}: ${consumer.skipped} — skipped (fix it, then re-run propagate)`);
      summary.skipped.push({ path: consumer.rel, reason: consumer.skipped });
      continue;
    }
    try {
      const one = await update(ctx, { repo: consumer.path, name: consumer.rel, ...rest });
      mergeSummary(summary, one);
      summary.version ||= one.version;
    } catch (error) {
      ctx.say(`  ✗ FAILED — ${consumer.rel}${detail(error)}`);
      summary.failed.push(consumer.rel);
    }
  }
  return summary;
}
