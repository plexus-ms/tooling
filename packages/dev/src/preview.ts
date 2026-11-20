// preview: what an unreleased version would do to the consumers in the
// maintainers' workspace, before it is cut. Not a repo taking the version: a
// maintainer's test, run by the dry run of `ship` and by nothing else, and
// due to leave `ship` for a canary of its own. Cutting a version needs no
// knowledge of any consumer, and the real run of `ship` has none.
//
// Each consumer found under the workspace is cloned from its origin at the
// branch a version lands on into a scratch directory, and taken through
// lib's `takeVersion` with a site update of its own (`fromLocal`): the
// answers pointed at the LOCAL template checkout, committed, and copier
// updated from it at main, so the diff and any conflicts show before a tag
// exists; nothing is committed to an origin, pushed or opened. The scratch
// work goes through `Context.stage`: performed although the run is a dry
// run, since nothing the operator owns changes. What each consumer came to
// is folded into one summary here.
import { join } from 'node:path';
import {
  ANSWERS_FILE,
  type Context,
  copierIn,
  detailOf,
  findConsumers,
  type Outcome,
  overview,
  run,
  type SiteUpdate,
  type Summary,
  scratchCommit,
  setAnswer,
  summarize,
  takeVersion,
  templateSource,
  VERSIONED_REPOS,
  write,
} from '@plexus-ms/lib';
import { UPSTREAM } from './version.ts';

/**
 * copier from the local template checkout under `upstream`, at main: the
 * answers point at it, committed because copier refuses a dirty subproject
 * (the commit takes the sites before along); copier takes defaults, a preview
 * never prompts.
 */
const fromLocal =
  (upstream: string): SiteUpdate =>
  async (ctx, site, target, dir) => {
    const localTemplate = join(upstream, site.template);
    ctx.say(`→ ${site.rel}: copier update (preview from ${localTemplate}@main)`);
    const answers = await ctx.readFile(join(target, ANSWERS_FILE));
    await ctx.stage(write(join(target, ANSWERS_FILE), setAnswer(answers, '_src_path', localTemplate)));
    await scratchCommit(ctx, dir, `plx preview: ${site.rel} reads ${localTemplate} from the local checkout`);
    await ctx.stage(
      run(
        ...copierIn(dir, ['update', '--skip-answered', '--trust', '--defaults', '--skip-tasks', '--vcs-ref', 'main']),
        {
          cwd: target,
        },
      ),
    );
  };

export async function previewConsumers(ctx: Context, workspace: string, version: string): Promise<Summary> {
  const upstream = join(workspace, UPSTREAM);
  const tree = await overview(ctx, workspace);
  const upstreamDir = tree.children.find((c) => c.path === upstream);
  const templates = VERSIONED_REPOS.filter((r) => upstreamDir?.children.some((c) => c.name === r && c.template));

  const outcomes: Outcome[] = [];
  const consumers = await findConsumers(ctx, tree, templates);
  for (const c of consumers) {
    if (!c.skipped) continue;
    ctx.say(`⚠ ${c.rel}: ${c.skipped} — not previewed`);
    outcomes.push({ repo: c.rel, version, kind: 'skipped', reason: c.skipped });
  }
  for (const template of templates)
    if (!consumers.some((c) => c.sites.some((s) => s.template === template)))
      ctx.say(`• no consumers of ${templateSource(template)} found under ${workspace}`);

  const take = { version, opener: '`plx-dev ship`', update: fromLocal(upstream) };
  const scratch = (await ctx.stage(run('mktemp', ['-d'])))?.trim() ?? '';
  try {
    for (const consumer of consumers) {
      if (consumer.skipped || !consumer.origin) continue;
      const clone = join(scratch, consumer.rel);
      ctx.say(`→ ${consumer.rel}: clone ${consumer.origin} at ${consumer.branch}`);
      try {
        await ctx.stage(run('git', ['clone', '--quiet', '--branch', consumer.branch, consumer.origin, clone]));
      } catch (error) {
        const why = detailOf(error);
        ctx.say(`  ✗ FAILED — clone${why ? `: ${why}` : ''}`);
        outcomes.push({ repo: consumer.rel, version, kind: 'failed', detail: `clone: ${why}` });
        continue;
      }
      outcomes.push({
        repo: consumer.rel,
        version,
        kind: 'taken',
        taken: await takeVersion(ctx, consumer, clone, take),
      });
    }
  } finally {
    if (scratch) await ctx.stage(run('rm', ['-rf', scratch]));
  }
  return summarize(outcomes, ctx.dryRun, version);
}
