// update --recursive: `update` in every repo generated from the templates
// under a directory, at any depth (§ 3 PLX-Updates). The operator's
// convenience over the verb, for whoever has many repos checked out side by
// side, the maintainers or a tenant's own operator: it needs no checkout of
// the upstream, reads the published versions like `update` does, and decides
// each repo by the same rule: a patch at once, a minor at the repo's next
// scheduled pull, a major only when asked. A repo that takes nothing rests;
// `now` or a named version asks for every repo at once.
//
// What every repo would read alike is read once: the directory is walked
// once, the login checked once, and the versions listed once, then handed to
// `update` (update.ts) with each repo as the walk found it. Each repo is
// updated in a worktree of the branch the version lands on, so the checkouts
// stay as they are. Nothing aborts the run: a repo that fails is recorded and
// the rest continues; the outcomes, one per repo, say what rests, what is
// clean, conflicted or failed, and the pull requests.
//
//   plx update --recursive ~/dev               # every repo, the version its schedule takes
//   plx update -r ~/dev --now                  # every repo, the newest version whatever its step
//   plx -n update -r ~/dev --now               # preview in worktrees, push nothing
//   plx -y update -r ~/dev --to 0.66.0
import { findConsumers } from './consumers.ts';
import type { Context } from './context.ts';
import type { Release } from './need.ts';
import { overview } from './overview.ts';
import { detailOf } from './take.ts';
import { TEMPLATES, templateSource } from './templates.ts';
import { type Outcome, releasesOf, type UpdateOptions, update } from './update.ts';
import { isPlexusVersion, preflightForge, UsageError } from './version.ts';

export interface RecursiveOptions extends Omit<UpdateOptions, 'repo' | 'name'> {
  /** The directory the repos sit under, at any depth. */
  dir: string;
}

export async function updateRecursive(ctx: Context, options: RecursiveOptions): Promise<Outcome[]> {
  const { dir, ...rest } = options;
  if (options.to !== undefined && !isPlexusVersion(options.to))
    throw new UsageError(`'${options.to}' is not plain semver (X.Y.Z, no v)`);
  const consumers = await findConsumers(ctx, await overview(ctx, dir), TEMPLATES);
  if (consumers.length === 0)
    ctx.say(`• no repo generated from ${TEMPLATES.map(templateSource).join(', ')} found under ${dir}`);
  let releases: Release[] = [];
  if (consumers.some((c) => !c.skipped)) {
    await preflightForge(ctx);
    if (options.to === undefined) releases = await releasesOf(ctx);
  }
  const version = options.to ?? '';
  const outcomes: Outcome[] = [];
  for (const consumer of consumers) {
    if (consumer.skipped) {
      ctx.say(`⚠ ${consumer.rel}: ${consumer.skipped} — skipped (fix it, then re-run plx update --recursive)`);
      outcomes.push({ repo: consumer.rel, version, kind: 'skipped', reason: consumer.skipped });
      continue;
    }
    try {
      outcomes.push(await update(ctx, { repo: consumer.path, ...rest }, { consumer, releases }));
    } catch (error) {
      const why = detailOf(error);
      ctx.say(`  ✗ FAILED — ${consumer.rel}${why ? `: ${why}` : ''}`);
      outcomes.push({ repo: consumer.rel, version, kind: 'failed', detail: why });
    }
  }
  return outcomes;
}
