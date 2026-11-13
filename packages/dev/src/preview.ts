// preview: what an unreleased version would do to the consumers in the
// maintainers' workspace, before it is cut. Not propagation: a maintainer's
// test, run by the dry run of `ship` and by nothing else, and due to leave
// `ship` for a canary of its own. Cutting a version needs no knowledge of any
// consumer, and the real run of `ship` has none.
//
// Each consumer found under the workspace is cloned from its origin at the
// branch a version lands on into a scratch directory, and copier-updated there
// from the LOCAL template checkout at main, so the diff and any conflicts show
// before a tag exists; nothing is committed to an origin, pushed or opened.
// The scratch work goes through `Context.stage`: performed although the run is
// a dry run, since nothing the operator owns changes.
import { join } from 'node:path';
import {
  type Context,
  detail,
  emptySummary,
  findConsumers,
  overview,
  run,
  type Summary,
  type Take,
  takeVersion,
  templateSource,
  VERSIONED_REPOS,
} from '@plexus-ms/lib';
import { UPSTREAM } from './version.ts';

export async function previewConsumers(ctx: Context, workspace: string, version: string): Promise<Summary> {
  const summary = emptySummary(version, ctx.dryRun);
  const upstream = join(workspace, UPSTREAM);
  const tree = await overview(ctx, workspace);
  const upstreamDir = tree.children.find((c) => c.path === upstream);
  const templates = VERSIONED_REPOS.filter((r) => upstreamDir?.children.some((c) => c.name === r && c.template));

  const consumers = await findConsumers(ctx, tree, templates);
  for (const c of consumers) {
    if (!c.skipped) continue;
    ctx.say(`⚠ ${c.rel}: ${c.skipped} — not previewed`);
    summary.skipped.push({ path: c.rel, reason: c.skipped });
  }
  for (const template of templates)
    if (!consumers.some((c) => c.sites.some((s) => s.template === template)))
      ctx.say(`• no consumers of ${templateSource(template)} found under ${workspace}`);

  const take: Take = { version, opener: '`plx-dev ship`', previewFrom: upstream };
  const scratch = (await ctx.stage(run('mktemp', ['-d'])))?.trim() ?? '';
  try {
    for (const consumer of consumers) {
      if (consumer.skipped || !consumer.origin) continue;
      const clone = join(scratch, consumer.rel);
      ctx.say(`→ ${consumer.rel}: clone ${consumer.origin} at ${consumer.branch}`);
      try {
        await ctx.stage(run('git', ['clone', '--quiet', '--branch', consumer.branch, consumer.origin, clone]));
      } catch (error) {
        ctx.say(`  ✗ FAILED — clone${detail(error)}`);
        summary.failed.push(consumer.rel);
        continue;
      }
      await takeVersion(ctx, consumer, clone, take, summary);
    }
  } finally {
    if (scratch) await ctx.stage(run('rm', ['-rf', scratch]));
  }
  return summary;
}
