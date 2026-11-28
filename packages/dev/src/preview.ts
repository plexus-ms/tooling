// preview: what an unreleased version would do to the consumers in the
// maintainers' workspace, before it is cut. Not a repo taking the version: a
// maintainer's test, run by the dry run of `ship` and by nothing else, and
// due to leave `ship` for a canary of its own. Cutting a version needs no
// knowledge of any consumer, and the real run of `ship` has none.
//
// Each consumer found under the workspace by its copier answers is cloned from
// its origin at the branch a version lands on into a scratch directory, and
// taken through lib's `takeVersion` with a sites step of its own: at each site
// in turn, the answers pointed at the LOCAL template checkout, committed
// (copier refuses a dirty subproject), and copier updated from it at main, so
// the diff and any conflicts show before a tag exists; nothing is committed to
// an origin, pushed or opened. A conflict is told by unmerged index entries
// and by the markers in the files copier changed, scoped to the site, and the
// site is staged before the next one, since copier's own git plumbing refuses
// an index with unmerged entries. The scratch work goes through
// `Context.stage`: performed although the run is a dry run, since nothing the
// operator owns changes. What each consumer came to is folded into one
// summary here.
//
// copier is the template repos' engine until the cutover, when the preview
// goes with them; `plx update` no longer runs it (update.ts of @plexus-ms/lib).
import { join, relative } from 'node:path';
import {
  ANSWERS_FILE,
  type Consumer,
  type Context,
  copierVia,
  detailOf,
  findConsumers,
  hasConflictMarkers,
  hasUnmergedEntries,
  type Outcome,
  overview,
  run,
  type SiteResult,
  type Summary,
  setAnswer,
  summarize,
  takeVersion,
  templateSource,
  VERSIONED_REPOS,
  write,
} from '@plexus-ms/lib';
import { UPSTREAM } from './version.ts';

/**
 * copier at the version plx pins, through mise, with the consumer's own mise
 * config ignored: copier needs no project tool, and a root `mise.toml` left
 * with conflict markers by the root site's update would otherwise fail every
 * later mise call in the directory, the apps' updates first of all.
 */
const copierIn = (dir: string, args: string[]): [string, string[]] => [
  'env',
  [`MISE_IGNORED_CONFIG_PATHS=${dir}`, 'mise', ...copierVia(args)],
];

/** A commit of plain plumbing on a scratch checkout: unsigned, no hooks, a stand-in identity. */
const scratchCommit = (ctx: Context, dir: string, message: string) =>
  ctx
    .stage(run('git', ['add', '-A'], { cwd: dir }))
    .then(() =>
      ctx.stage(
        run(
          'git',
          [
            '-c',
            'commit.gpgsign=false',
            '-c',
            'user.name=plx',
            '-c',
            'user.email=plx@localhost',
            'commit',
            '--quiet',
            '--no-verify',
            '--allow-empty',
            '-m',
            message,
          ],
          { cwd: dir },
        ),
      ),
    );

/** Every site of the consumer brought to the local template checkouts under `upstream` at main, as the header says. */
const fromLocal =
  (upstream: string) =>
  async (ctx: Context, consumer: Consumer, dir: string): Promise<SiteResult[]> => {
    const results: SiteResult[] = [];
    for (const site of consumer.sites) {
      const target = join(dir, relative(consumer.path, site.path));
      const result = { rel: site.rel, dir: relative(consumer.path, site.path) || '.' };
      const localTemplate = join(upstream, site.template);
      ctx.say(`→ ${site.rel}: copier update (preview from ${localTemplate}@main)`);
      try {
        const answers = await ctx.readFile(join(target, ANSWERS_FILE));
        await ctx.stage(write(join(target, ANSWERS_FILE), setAnswer(answers, '_src_path', localTemplate)));
        await scratchCommit(ctx, dir, `plx preview: ${site.rel} reads ${localTemplate} from the local checkout`);
        await ctx.stage(
          run(
            ...copierIn(dir, [
              'update',
              '--skip-answered',
              '--trust',
              '--defaults',
              '--skip-tasks',
              '--vcs-ref',
              'main',
            ]),
            { cwd: target },
          ),
        );
      } catch (error) {
        const why = detailOf(error);
        ctx.say(`  ✗ FAILED — copier update exited nonzero${why ? `: ${why}` : ''}`);
        results.push({ ...result, outcome: 'failed', ...(why ? { detail: why } : {}) });
        continue;
      }
      const status = await ctx.read('git', ['status', '--porcelain', '--', '.'], { cwd: target });
      let conflict = hasUnmergedEntries(status);
      const changed = (await ctx.read('git', ['diff', '--name-only', '--relative', '--', '.'], { cwd: target }))
        .split('\n')
        .filter(Boolean);
      for (const f of changed)
        if (hasConflictMarkers(await ctx.readFile(join(target, f)).catch(() => ''))) conflict = true;
      ctx.say(conflict ? '  ✗ CONFLICTS — left with their <<<<<<< markers:' : '  ✓ merged clean:');
      for (const line of status.split('\n').filter(Boolean)) ctx.say(`    ${line}`);
      await ctx.stage(run('git', ['add', '-A'], { cwd: dir }));
      results.push({ ...result, outcome: conflict ? 'conflicted' : 'clean' });
    }
    return results;
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

  const take = { version, opener: '`plx-dev ship`', sites: fromLocal(upstream) };
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
