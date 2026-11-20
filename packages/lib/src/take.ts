// take: one repo takes a version (§ 3 PLX-Updates), in a scratch checkout of the
// branch the version lands on (consumers.ts). `copier update` runs at the
// version plx pins (copier.ts) at every site (the repo root, then its apps/*),
// the lockfile refreshed where manifests moved, the hand-owned workflows pinned to the version; then one
// commit, pushed as `plexus/<version>`, and a pull request against the branch.
// A conflict is committed with its markers and reported, and the pull request
// is opened all the same, as a draft whose body opens with what needs a hand
// (pull.ts): that is where it gets resolved. Nothing here aborts
// a run: what became of each site, the lockfile and the pull request is
// returned as data (`Taken`), which the caller folds into the summary that
// says what needs a human (summary.ts). Reviewing and merging the pull
// request stays human.
//
// `update` (update.ts) is the verb on top of it, and the only thing that
// opens a version's pull request; `update --recursive` (recursive.ts) runs
// that verb over many repos. The maintainers' preview of an unreleased
// version (preview.ts of @plexus-ms/dev) uses the same steps with its own
// `SiteUpdate`, against the local template checkouts, and opens nothing.
import { join, relative } from 'node:path';
import { bumpWorkflowRefs, WORKFLOW_REF } from './bookkeeping.ts';
import { filesWithConflictMarkers, hasConflictMarkers, hasUnmergedEntries } from './conflicts.ts';
import type { Consumer, Site } from './consumers.ts';
import type { Context } from './context.ts';
import { ANSWERS_FILE, copierVia, parseAnswers, setAnswer } from './copier.ts';
import { run, write } from './effects.ts';
import { detailOf } from './io.ts';
import { needsAHand, openPullOf, type PullState, pullBody, versionBranch } from './pull.ts';
import { namesOldTemplate, templateSource } from './templates.ts';

/** What became of one site: merged clean, left with conflicts, or its copier run failed (`detail` says why). */
export interface SiteResult {
  rel: string;
  outcome: 'clean' | 'conflicted' | 'failed';
  detail?: string;
}

/** What one consumer's taking of the version came to, as data: the caller folds it into a summary. */
export interface Taken {
  rel: string;
  /** Every site, in the order they were updated. */
  sites: SiteResult[];
  /** The lockfile refresh, where manifests moved; undefined when nothing needed one. */
  lockfile?: 'refreshed' | 'failed';
  /** Tracked files of the scratch checkout that hold a conflict marker once the sites are updated. */
  marked?: string[];
  /** The pull request opened, a draft when something needs a hand; its URL unknown when the forge did not say it. */
  pull?: { branch: string; url?: string; draft: boolean };
  /** Why the commit, the push or the pull request failed, when one did. */
  failed?: string;
}

/** Whether the consumer needs a hand beyond reviewing its pull request. */
export const needsHand = (t: Taken): boolean =>
  t.sites.some((s) => s.outcome !== 'clean') ||
  (t.marked?.length ?? 0) > 0 ||
  t.lockfile === 'failed' ||
  t.failed !== undefined;

/**
 * How a site is brought to the version in the scratch checkout: `target` is
 * the site's directory there, `dir` the checkout's root. The default runs
 * copier against the published template; the maintainers' preview of an
 * unreleased version (preview.ts of @plexus-ms/dev) brings its own, against
 * the local template checkouts. Whatever it leaves is then judged and
 * staged the same way.
 */
export type SiteUpdate = (ctx: Context, site: Site, target: string, dir: string) => Promise<void>;

/** How a consumer takes the version. */
export interface Take {
  version: string;
  /** The template ref copier updates to; unset, copier takes the newest tag. */
  ref?: string;
  /** Who opened the pull request, named in its body. */
  opener: string;
  /** Why the repo takes the version now (need.ts), named in the body beside the opener. */
  why?: string;
  /** How each site is updated; default: copier against the published template, at `ref`. */
  update?: SiteUpdate;
}

/**
 * copier at the version plx pins, through mise, with the consumer's own mise
 * config ignored: copier needs no project tool, and a root `mise.toml` left
 * with conflict markers by the root site's update would otherwise fail every
 * later mise call in the directory, the apps' updates first of all.
 */
export const copierIn = (dir: string, args: string[]): [string, string[]] => [
  'env',
  [`MISE_IGNORED_CONFIG_PATHS=${dir}`, 'mise', ...copierVia(args)],
];

/**
 * One consumer takes the version in `dir`, a scratch checkout of its branch:
 * every site updated, the lockfile refreshed, the workflow refs bumped, then
 * the commit, the branch and the pull request.
 */
export async function takeVersion(ctx: Context, consumer: Consumer, dir: string, take: Take): Promise<Taken> {
  const base = (await ctx.read('git', ['rev-parse', 'HEAD'], { cwd: dir })).trim();
  const update = take.update ?? fromTemplate(take.ref);
  const sites: SiteResult[] = [];
  for (const site of consumer.sites) sites.push(await updateSite(ctx, consumer, site, dir, update));
  const lockfile = await refreshLockfile(ctx, consumer, dir, base);
  await bumpConsumerRefs(ctx, consumer, dir, take.version);
  const taken: Taken = { rel: consumer.rel, sites, ...(lockfile ? { lockfile } : {}) };
  return { ...taken, ...(await openPull(ctx, consumer, dir, take, taken)) };
}

/** A commit of plain plumbing on a scratch checkout: unsigned, no hooks, a stand-in identity. */
export const scratchCommit = (ctx: Context, dir: string, message: string) =>
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

/** copier against the published template, at `ref`. */
const fromTemplate =
  (ref: string | undefined): SiteUpdate =>
  async (ctx, site, target, dir) => {
    ctx.say(`→ ${site.rel}: copier update${ref ? ` to ${ref}` : ''}`);
    // A template renamed on a version: the answers still name the old source,
    // which copier would clone through the forge's redirect; point them at
    // the current name first, committed because copier refuses a dirty
    // subproject.
    const answers = await ctx.readFile(join(target, ANSWERS_FILE));
    const current = templateSource(site.template);
    const recorded = parseAnswers(answers).src;
    if (recorded && namesOldTemplate(recorded)) {
      ctx.say(`  ${site.rel}: the template is ${current} now; the answers follow`);
      await ctx.stage(write(join(target, ANSWERS_FILE), setAnswer(answers, '_src_path', current)));
      await scratchCommit(ctx, dir, `plx: ${site.rel} reads ${current}, the template's name since its rename`);
    }
    // Template tasks (mise install, hook setup) serve a developer's checkout,
    // not a pull request. Unattended, a new question takes its default; on a
    // terminal copier asks. A dry run previews on the scratch checkout, so
    // the step is staged there rather than only announced.
    const args = [
      'update',
      '--skip-answered',
      '--trust',
      '--skip-tasks',
      ...(ref ? ['--vcs-ref', ref] : []),
      ...(ctx.yes || ctx.dryRun ? ['--defaults'] : []),
    ];
    const step = run(...copierIn(dir, args), { cwd: target, interactive: !ctx.dryRun });
    if (ctx.dryRun) await ctx.stage(step);
    else await ctx.apply([step]);
  };

async function updateSite(
  ctx: Context,
  consumer: Consumer,
  site: Site,
  dir: string,
  update: SiteUpdate,
): Promise<SiteResult> {
  const target = join(dir, relative(consumer.path, site.path));
  try {
    await update(ctx, site, target, dir);
  } catch (error) {
    const why = detailOf(error);
    ctx.say(`  ✗ FAILED — copier update exited nonzero${why ? `: ${why}` : ''}`);
    return { rel: site.rel, outcome: 'failed', ...(why ? { detail: why } : {}) };
  }

  // copier applies the template diff with `git apply --3way`, which leaves
  // unmerged index entries and inline markers when a hunk does not apply.
  // Scoped to the site: the root site's changes are still in the tree when
  // its apps are updated.
  const status = await ctx.read('git', ['status', '--porcelain', '--', '.'], { cwd: target });
  let conflict = hasUnmergedEntries(status);
  const changed = (await ctx.read('git', ['diff', '--name-only', '--relative', '--', '.'], { cwd: target }))
    .split('\n')
    .filter(Boolean);
  for (const f of changed) {
    const text = await ctx.readFile(join(target, f)).catch(() => '');
    if (hasConflictMarkers(text)) conflict = true;
  }

  if (conflict) ctx.say('  ✗ CONFLICTS — committed with their <<<<<<< markers, to resolve in the pull request:');
  else ctx.say('  ✓ merged clean:');
  for (const line of status.split('\n').filter(Boolean)) ctx.say(`    ${line}`);
  // Staged, so that the next site starts from a whole index: a conflict
  // leaves unmerged entries, and copier's own git plumbing (`git
  // write-tree`) refuses an index with those, so the next site's update
  // would fail; staged, the markers are in the tree and the index is whole.
  await ctx.stage(run('git', ['add', '-A'], { cwd: dir }));
  return { rel: site.rel, outcome: conflict ? 'conflicted' : 'clean' };
}

/**
 * Refresh the lockfile when the updates touched a manifest (`mise exec` trusts the directory's own config).
 * The lockfile is what this step writes, so the install is never frozen: pnpm freezes it by default under CI,
 * where the update workflow runs.
 */
async function refreshLockfile(
  ctx: Context,
  consumer: Consumer,
  dir: string,
  base: string,
): Promise<Taken['lockfile']> {
  if ((await ctx.readFile(join(dir, 'pnpm-workspace.yaml')).catch(() => undefined)) === undefined) return undefined;
  const manifests = ['*package.json', 'pnpm-workspace.yaml'];
  const unchanged = await ctx
    .read('git', ['diff', '--quiet', base, '--', ...manifests], { cwd: dir })
    .then(() => true)
    .catch(() => false);
  if (unchanged) return undefined;
  ctx.say(`→ ${consumer.rel}: pnpm install (manifests changed)`);
  try {
    await ctx.apply([
      run('mise', ['exec', '--', 'pnpm', 'install', '--no-frozen-lockfile', '--reporter=silent'], { cwd: dir }),
    ]);
    return 'refreshed';
  } catch (error) {
    const why = detailOf(error);
    ctx.say(`  ✗ pnpm install failed${why ? `: ${why}` : ''}`);
    return 'failed';
  }
}

/** Consumers' hand-owned workflows pin the reusable workflows by tag; lockstep them to the version. */
async function bumpConsumerRefs(ctx: Context, consumer: Consumer, dir: string, version: string): Promise<void> {
  const workflows = join(dir, '.github', 'workflows');
  const entries = await ctx.readDir(workflows).catch(() => []);
  const files = entries
    .filter((e) => !e.directory && /\.ya?ml$/.test(e.name))
    .map((e) => e.name)
    .sort();
  for (const f of files) {
    const text = await ctx.readFile(join(workflows, f));
    if (!text.includes(WORKFLOW_REF)) continue;
    const bumped = bumpWorkflowRefs(text, version);
    if (bumped === text) continue;
    ctx.say(`→ ${consumer.rel}: ${f} workflow refs → @${version}`);
    await ctx.stage(write(join(workflows, f), bumped));
  }
}

/**
 * One commit, the version branch pushed, and a pull request against the
 * consumer's branch, opened once. The push only creates the branch: one
 * already on origin is never moved (pull.ts). Hooks are skipped: the checks
 * are the pull request's job, and the mount's own checkout may carry the
 * repo's hooks. The pull request is a draft when anything needs a hand, and
 * its body says what, from what the sites and the lockfile came to and the
 * detector over the committed tree.
 */
async function openPull(
  ctx: Context,
  consumer: Consumer,
  dir: string,
  take: Take,
  taken: Taken,
): Promise<Pick<Taken, 'pull' | 'failed' | 'marked'>> {
  const { version } = take;
  const branch = versionBranch(version);
  if (ctx.dryRun) {
    ctx.say(
      `  (preview) ${consumer.rel}: would commit, push ${branch} and open a pull request against ${consumer.branch}`,
    );
    return {};
  }
  if ((await ctx.read('git', ['status', '--porcelain'], { cwd: dir })).trim() === '') {
    ctx.say(`• ${consumer.rel}: nothing changed — no pull request`);
    return {};
  }
  const head = `${consumer.origin ?? 'origin'} ${branch}`;
  try {
    await ctx.apply([
      run('git', ['add', '-A'], { cwd: dir }),
      run('git', ['commit', '--quiet', '--no-verify', '-m', `chore: Plexus ${version}`], { cwd: dir }),
      // An empty expected value: the branch must not exist on origin yet.
      run(
        'git',
        [
          'push',
          '--quiet',
          '--no-verify',
          `--force-with-lease=refs/heads/${branch}:`,
          'origin',
          `HEAD:refs/heads/${branch}`,
        ],
        { cwd: dir },
      ),
    ]);
  } catch (error) {
    const why = detailOf(error);
    ctx.say(`  ✗ FAILED — push to ${head}${why ? `: ${why}` : ''}`);
    return { failed: `push to ${head}${why ? `: ${why}` : ''}` };
  }
  const marked = await filesWithConflictMarkers(ctx, dir);
  const of = (outcome: SiteResult['outcome']) =>
    taken.sites.filter((s) => s.outcome === outcome).map((s) => siteOf(consumer, s.rel));
  const state: PullState = {
    version,
    sites: consumer.sites.map((s) => relative(consumer.path, s.path) || '.'),
    conflicted: of('conflicted'),
    marked,
    failed: of('failed'),
    lockfile: taken.lockfile === 'failed',
    note: `Opened by ${take.opener}${take.why ? `: ${take.why}` : ''}.`,
  };
  const draft = needsAHand(state);
  if (marked.length > 0) ctx.say(`  ${consumer.rel}: conflict markers in ${marked.join(', ')}`);
  try {
    await ctx.apply([
      run(
        'gh',
        [
          'pr',
          'create',
          ...(draft ? ['--draft'] : []),
          '--base',
          consumer.branch,
          '--head',
          branch,
          '--title',
          `chore: Plexus ${version}`,
          '--body',
          pullBody(state),
        ],
        { cwd: dir },
      ),
    ]);
  } catch (error) {
    const why = detailOf(error);
    ctx.say(`  ✗ FAILED — pull request${why ? `: ${why}` : ''}`);
    return { marked, failed: `pull request${why ? `: ${why}` : ''}` };
  }
  const url = (await openPullOf(ctx, consumer, dir, version))?.url;
  ctx.say(`• ${consumer.rel}: ${draft ? 'draft ' : ''}pull request opened${url ? `: ${url}` : ''}`);
  return { marked, pull: { branch, draft, ...(url ? { url } : {}) } };
}

/** A site's name in the run, as the repo names it: `.` for its root. */
function siteOf(consumer: Consumer, rel: string): string {
  const s = consumer.sites.find((x) => x.rel === rel);
  return s ? relative(consumer.path, s.path) || '.' : rel;
}
