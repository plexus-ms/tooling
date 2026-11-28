// take: one repo takes a version (§ 3 PLX-Updates), in a scratch checkout of the
// branch the version lands on (consumers.ts): its sites brought to the
// version by the caller's step, the lockfile refreshed where manifests moved,
// the hand-owned workflows pinned to the version; then one commit, pushed as
// `plexus/<version>`, and a pull request against the branch. A conflict is
// committed with its markers and reported, and the pull request is opened all
// the same, as a draft where the forge offers one, whose body opens with what
// needs a hand (pull.ts): that is where it gets resolved. Nothing here aborts
// a run but the sites' step itself: what became of each site, the lockfile and
// the pull request is returned as data (`Taken`), which the caller folds into
// the summary that says what needs a human (summary.ts). Reviewing and merging
// the pull request stays human.
//
// `update` (update.ts) is the verb on top of it, and the only thing that
// opens a version's pull request, with the engine's step: both sides rendered
// and merged at every site, the version written into the root marker.
// `update --recursive` (recursive.ts) runs that verb over many repos. The
// maintainers' preview of an unreleased version (preview.ts of @plexus-ms/dev)
// uses the same steps with a step of its own, copier against the local
// template checkouts, under a dry run, and opens nothing.
import { join } from 'node:path';
import { bumpWorkflowRefs, WORKFLOW_REF } from './bookkeeping.ts';
import { filesWithConflictMarkers } from './conflicts.ts';
import type { Consumer } from './consumers.ts';
import type { Context } from './context.ts';
import { run, write } from './effects.ts';
import { detailOf } from './io.ts';
import { MARKER_FILE } from './marker.ts';
import {
  askForReviews,
  createPull,
  needsAHand,
  type PullState,
  pullBody,
  pullOf,
  type Review,
  type Reviewers,
  versionBranch,
} from './pull.ts';

/** What became of one site: merged clean, left with conflicts, or its step failed (`detail` says why). */
export interface SiteResult {
  /** The site as the run names it. */
  rel: string;
  /** Its directory relative to the repo, `.` for the root. */
  dir: string;
  outcome: 'clean' | 'conflicted' | 'failed';
  detail?: string;
}

/** What one consumer's taking of the version came to, as data: the caller folds it into a summary. */
export interface Taken {
  rel: string;
  /** Every site, in the order they were brought to the version. */
  sites: SiteResult[];
  /** The lockfile refresh, where manifests moved; undefined when nothing needed one. */
  lockfile?: 'refreshed' | 'failed';
  /** Tracked files of the scratch checkout that hold a conflict marker once the sites are updated. */
  marked?: string[];
  /** The pull request opened, a draft when something needs a hand and the forge took one; its URL unknown when the forge did not say it. */
  pull?: { branch: string; url?: string; draft: boolean };
  /** Why the commit, the push or the pull request failed, when one did. */
  failed?: string;
  /** The users asked to review the pull request, or why asking them failed. */
  review?: Review;
}

/** Whether the consumer needs a hand beyond reviewing its pull request. */
export const needsHand = (t: Taken): boolean =>
  t.sites.some((s) => s.outcome !== 'clean') ||
  (t.marked?.length ?? 0) > 0 ||
  t.lockfile === 'failed' ||
  t.failed !== undefined;

/**
 * How the sites are brought to the version in the scratch checkout `dir`, its
 * files and markers changed in place, and what became of each. A step that
 * throws stops the taking before anything is committed.
 */
export type SitesStep = (ctx: Context, consumer: Consumer, dir: string) => Promise<SiteResult[]>;

/** How a consumer takes the version. */
export interface Take {
  version: string;
  /** Who opened the pull request, named in its body. */
  opener: string;
  /** Why the repo takes the version now (need.ts), named in the body beside the opener. */
  why?: string;
  /** How the sites are brought to the version. */
  sites: SitesStep;
  /** Who is asked to review the pull request when it is opened; default: the root marker's `pr_reviewers` once the sites are brought to it. */
  reviewers?: Reviewers;
}

/**
 * One consumer takes the version in `dir`, a scratch checkout of its branch:
 * every site updated, the lockfile refreshed, the workflow refs bumped, then
 * the commit, the branch and the pull request.
 */
export async function takeVersion(ctx: Context, consumer: Consumer, dir: string, take: Take): Promise<Taken> {
  const base = (await ctx.read('git', ['rev-parse', 'HEAD'], { cwd: dir })).trim();
  const sites = await take.sites(ctx, consumer, dir);
  const lockfile = await refreshLockfile(ctx, consumer, dir, base);
  await bumpConsumerRefs(ctx, consumer, dir, take.version);
  const taken: Taken = { rel: consumer.rel, sites, ...(lockfile ? { lockfile } : {}) };
  return { ...taken, ...(await openPull(ctx, consumer, dir, base, take, taken)) };
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
  base: string,
  take: Take,
  taken: Taken,
): Promise<Pick<Taken, 'pull' | 'failed' | 'marked' | 'review'>> {
  const { version } = take;
  const branch = versionBranch(version);
  if (ctx.dryRun) {
    ctx.say(
      `  (preview) ${consumer.rel}: would commit, push ${branch} and open a pull request against ${consumer.branch}`,
    );
    return {};
  }
  const moved = (await ctx.read('git', ['rev-parse', 'HEAD'], { cwd: dir })).trim() !== base;
  if (!moved && (await ctx.read('git', ['status', '--porcelain'], { cwd: dir })).trim() === '') {
    ctx.say(`• ${consumer.rel}: nothing changed — no pull request`);
    return {};
  }
  const head = `${consumer.origin ?? 'origin'} ${branch}`;
  try {
    await ctx.apply([
      // Staged first: a site's step can leave unmerged entries, which a reset refuses.
      run('git', ['add', '-A'], { cwd: dir }),
      // One commit on the branch, any scratch ones folded in: a later run tells it from a human's by the count.
      run('git', ['reset', '--quiet', '--soft', base], { cwd: dir }),
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
  const of = (outcome: SiteResult['outcome']) => taken.sites.filter((s) => s.outcome === outcome).map((s) => s.dir);
  const state: PullState = {
    version,
    sites: taken.sites.map((s) => s.dir),
    conflicted: of('conflicted'),
    marked,
    failed: of('failed'),
    lockfile: taken.lockfile === 'failed',
    note: `Opened by ${take.opener}${take.why ? `: ${take.why}` : ''}.`,
  };
  if (marked.length > 0) ctx.say(`  ${consumer.rel}: conflict markers in ${marked.join(', ')}`);
  let draft: boolean;
  try {
    draft = await createPull(
      ctx,
      consumer.rel,
      { base: consumer.branch, version, body: pullBody(state), draft: needsAHand(state) },
      dir,
    );
  } catch (error) {
    const why = detailOf(error);
    ctx.say(`  ✗ FAILED — pull request${why ? `: ${why}` : ''}`);
    return { marked, failed: `pull request${why ? `: ${why}` : ''}` };
  }
  // Asking the forge for what it opened is a read like any other: a failure is reported, never "none".
  let opened: Awaited<ReturnType<typeof pullOf>>;
  try {
    opened = await pullOf(ctx, consumer, dir, version);
  } catch (error) {
    const why = detailOf(error);
    ctx.say(`  ✗ FAILED — ${consumer.rel}: the pull request opened, but listing it failed${why ? `: ${why}` : ''}`);
    return { marked, pull: { branch, draft }, failed: `listing the pull request: ${why}` };
  }
  const url = opened?.url;
  ctx.say(`• ${consumer.rel}: ${draft ? 'draft ' : ''}pull request opened${url ? `: ${url}` : ''}`);
  const pull = { branch, draft, ...(url ? { url } : {}) };
  if (!opened) return { marked, pull, failed: 'the forge did not list the pull request it opened' };
  // Unless named, from the root marker as the sites' step left it: a default it wrote counts.
  const from = take.reviewers ?? { marker: await ctx.readFile(join(dir, MARKER_FILE)).catch(() => '') };
  const review = await askForReviews(ctx, consumer.rel, opened, from, dir);
  return { marked, pull, ...(review ? { review } : {}) };
}
