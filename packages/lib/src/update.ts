// update: a repo generated from the templates takes the version itself (§ 3
// PLX-Updates), from inside the repo, in the tenant's own CI or by hand; it is
// the only thing that opens a version's pull request.
//
// Which version it takes, if any, is need.ts's decision, by the step of the
// version number: a patch (a hotfix) at once, a minor (routine) at the repo's
// next scheduled pull, once the oldest version it has not taken is as old as
// its interval (`update_max_age` in its answers, in days; 7 when they do not
// say, zero for every version), a major (a changed contract) only when asked.
// Asked (`--now`, or a version named), it takes the newest version, or the one
// named, whatever its step. Otherwise the repo rests: one line saying why,
// exit 0.
//
// The versions are the compendium's GitHub releases (every version tag is locked
// by one, § 1.6 PLX, and the compendium is released last, so a version shows
// there once it is cut everywhere), asked of the forge as an operator would
// (`gh api repos/plexus-ms/compendium/releases`): their numbers are the steps,
// and their dates are what the interval is measured against. The work happens in a
// worktree of origin's branch, never in the checkout: a developer's branch and
// edits stay as they are, and in CI the worktree shares the checkout's
// credentials, so the push and the pull request need no second token. Then
// `takeVersion` (take.ts): copier update at every site, lockfile,
// workflow refs, one commit on `plexus/<version>`, one pull request.
//
// What the run came to is returned as data, one `Outcome` for the repo, which
// the caller folds into the summary (summary.ts). Run over many repos
// (`--recursive`, recursive.ts), it is handed what that run read once for all
// of them: the repo as found, and the versions.
//
// The version is pulled once per repo: a `plexus/<version>` branch already on
// origin, from an earlier run or from a human resolving its conflicts, is
// never moved, so a daily run never touches a branch somebody is working on;
// deleting the branch is how a pull is redone. With its pull request open, the
// run looks at it again (pull.ts): the branch read as origin has it, the body
// rewritten to what still needs a hand, ready once no conflict marker remains.
// With no pull request in any state (opening it failed after the push), the
// run opens it then; a closed or merged one stays as a human left it.
// A repo whose every site already records the newest version does nothing at
// all.
//
// The pull request it opens asks for a review from the users the repo's root
// answers name (`pr_reviewers`), or from those `reviewers` names instead
// (pull.ts), once, when it is opened. The answer is read and checked only
// then: a bad one fails no run that opens nothing, and the pull request is
// opened all the same, with the refused answer reported.
//
//   plx update                      # the version the repo's schedule takes, if any
//   plx update --now                # the newest version, whatever its step
//   plx -n update --now             # preview in a worktree, push nothing
//   plx -y update --to 0.102.0      # unattended, an explicit version
//   plx update --recursive ~/dev    # every repo under a directory (recursive.ts)
import { basename, join, relative } from 'node:path';
import { type Consumer, findConsumers } from './consumers.ts';
import type { Context } from './context.ts';
import { ANSWERS_FILE, parseAnswers } from './copier.ts';
import { run } from './effects.ts';
import { detailOf, ExecError } from './io.ts';
import { maxAgeOf, type Need, needOf, type Release } from './need.ts';
import { overview } from './overview.ts';
import { openLate, pullOf, type Review, type Reviewers, revisit, versionBranch } from './pull.ts';
import { type Taken, takeVersion } from './take.ts';
import { TEMPLATES, templateSource } from './templates.ts';
import { COMPENDIUM, compareVersions, isPlexusVersion, preflightForge, UsageError } from './version.ts';

export interface UpdateOptions {
  /** The repo to update: a checkout whose root is a site of a repo template. */
  repo: string;
  /** What the repo is called in the narration and the summary; default: its directory's name. */
  name?: string;
  /** The version to take, which is asking for it; default: the template's newest release. */
  to?: string;
  /** Take the newest version whatever its step: somebody asks. */
  now?: boolean;
  /** The interval in days; default: the repo's answer `update_max_age`, else 7. */
  maxAge?: number;
  /** The clock the interval is measured against, as a date; default: now. */
  today?: string;
  /** The users asked to review the pull request it opens; default: the repo's answer `pr_reviewers`, else none. */
  reviewers?: string[];
}

/**
 * What a run over many repos (recursive.ts) has read once for all of them,
 * so that `update` reads none of it again: the repo as the walk found it,
 * named as that run names it, and the versions, listed after the login was
 * checked (none when a version is named).
 */
export interface Known {
  consumer: Consumer;
  releases: Release[];
}

/**
 * What one repo's run came to; `version` is the one it took, looked at, or
 * would take. `current`: every site records it already. `skipped`: left
 * untouched, with why. `resting`: needs no version yet (need.ts), with what
 * would end the rest. `found`: its version branch is on origin already, with
 * the pull request found or, when there was none, opened there, the files of
 * the branch that hold conflict markers, whether it is ready to merge, why
 * looking at it failed, if it did, and the review request of one opened.
 * A closed or merged one is no pull to list.
 * `taken`: it took the version. `failed`: it could not be worked on, with why.
 */
export type Outcome = { repo: string; version: string } & (
  | { kind: 'current' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'resting'; reason: string }
  | { kind: 'found'; pull?: string; marked: string[]; mergeable: boolean; failed?: string; review?: Review }
  | { kind: 'taken'; taken: Taken }
  | { kind: 'failed'; detail: string }
);

export async function update(ctx: Context, options: UpdateOptions, known?: Known): Promise<Outcome> {
  if (options.to !== undefined && !isPlexusVersion(options.to))
    throw new UsageError(`'${options.to}' is not plain semver (X.Y.Z, no v)`);
  const consumer = known?.consumer ?? (await repoAt(ctx, options.repo, options.name ?? basename(options.repo)));
  const { path: repo, rel: name } = consumer;
  const root = consumer.sites.find((s) => s.path === consumer.path);
  if (!root) throw new Error(`${name}: its root is not a site of a repo template`);

  if (!known) await preflightForge(ctx);
  const releases = known?.releases ?? (options.to === undefined ? await releasesOf(ctx) : []);
  const newest = options.to ?? newestOf(releases);

  // The repo is judged by what its origin has on the branch the version lands
  // on, not by the checkout, which may be behind it or on a branch of its own.
  // Without that branch on origin there is nothing to take the version on.
  if ((await onOrigin(ctx, repo, consumer.branch)) === false) {
    const reason = `origin has no branch \`${consumer.branch}\`, the one the version lands on`;
    ctx.say(`⚠ ${name}: ${reason} — skipped`);
    return { repo: name, version: newest, kind: 'skipped', reason };
  }
  await ctx.read('git', ['fetch', '--quiet', 'origin', consumer.branch], { cwd: repo }).catch(() => '');
  const answers = await Promise.all(
    consumer.sites.map(async (s) => {
      const file = join(relative(consumer.path, s.path), ANSWERS_FILE);
      const onOrigin = await ctx
        .read('git', ['show', `origin/${consumer.branch}:${file}`], { cwd: repo })
        .catch(() => undefined);
      return parseAnswers(onOrigin ?? (await ctx.readFile(join(s.path, ANSWERS_FILE))));
    }),
  );
  const recorded = answers.map((a) => a.commit);
  if (recorded.every((c) => c === newest)) {
    ctx.say(`• ${name}: already at ${newest}`);
    return { repo: name, version: newest, kind: 'current' };
  }
  // copier refuses a downgrade; say so before a worktree is made for nothing.
  const past = recorded.find((c) => c && isPlexusVersion(c) && compareVersions(c, newest) > 0);
  if (past) throw new Error(`${name} is at ${past}, past ${newest}; a repo is never taken back to an older version`);

  const asked = options.to !== undefined || options.now === true;
  const need: Need = asked
    ? { take: true, version: newest, why: `asked for (${options.to !== undefined ? `--to ${newest}` : '--now'})` }
    : needOf({
        recorded,
        releases,
        maxAge: options.maxAge ?? maxAgeOf(answers[consumer.sites.indexOf(root)]?.answers ?? {}),
        now: options.today === undefined ? new Date() : new Date(options.today),
      });
  if (need.held) ctx.say(`• ${name}: ${need.held} (plx update --now takes it)`);
  // Checked only when a pull request is opened: a run that opens none never reads it.
  const reviewers: Reviewers = options.reviewers
    ? { named: options.reviewers }
    : { answers: answers[consumer.sites.indexOf(root)]?.answers ?? {} };
  // A repo that rests is looked at for the newest version: one asked for earlier may be on origin.
  const version = need.take ? need.version : newest;

  const branch = versionBranch(version);
  if (await onOrigin(ctx, repo, branch)) {
    // A forge that cannot be asked fails the run here: it is never taken for "no pull request".
    const pull = await pullOf(ctx, consumer, repo, version);
    if (!pull) {
      try {
        const late = await openLate(ctx, consumer, version, reviewers);
        if (late.failed) ctx.say(`  ✗ FAILED — ${late.failed}`);
        return {
          repo: name,
          version,
          kind: 'found',
          ...(late.pull ? { pull: late.pull.url } : {}),
          marked: late.marked,
          mergeable: late.pull !== undefined && !late.pull.draft && late.marked.length === 0,
          ...(late.failed ? { failed: late.failed } : {}),
          ...(late.review ? { review: late.review } : {}),
        };
      } catch (error) {
        const why = detailOf(error);
        ctx.say(`  ✗ FAILED — ${branch} as origin has it${why ? `: ${why}` : ''}`);
        return { repo: name, version, kind: 'found', marked: [], mergeable: false, failed: why };
      }
    }
    if (!pull.open) {
      ctx.say(
        `• ${name}: ${branch} is already on origin, its pull request closed (${pull.url}) — nothing to do; delete the branch to pull the version again`,
      );
      return { repo: name, version, kind: 'found', marked: [], mergeable: false };
    }
    try {
      const { url, ...found } = await revisit(ctx, consumer, pull, version);
      if (found.failed) ctx.say(`  ✗ FAILED — ${found.failed}`);
      return { repo: name, version, kind: 'found', pull: url, ...found };
    } catch (error) {
      const why = detailOf(error);
      ctx.say(`  ✗ FAILED — ${branch} as origin has it${why ? `: ${why}` : ''}`);
      return { repo: name, version, kind: 'found', pull: pull.url, marked: [], mergeable: false, failed: why };
    }
  }

  if (!need.take) {
    ctx.say(`• ${name}: rests — ${need.why} (plx update --now takes ${version})`);
    return { repo: name, version, kind: 'resting', reason: need.why };
  }
  ctx.say(`• ${name}: takes ${version} — ${need.why}`);

  const scratch = (await ctx.stage(run('mktemp', ['-d'])))?.trim() ?? '';
  const dir = join(scratch, name);
  try {
    ctx.say(`→ ${name}: worktree of origin/${consumer.branch}`);
    try {
      await ctx.stage(run('git', ['fetch', '--quiet', 'origin', consumer.branch], { cwd: repo }));
      await ctx.stage(
        run('git', ['worktree', 'add', '--quiet', '--detach', dir, `origin/${consumer.branch}`], { cwd: repo }),
      );
    } catch (error) {
      const why = detailOf(error);
      ctx.say(`  ✗ FAILED — worktree of origin/${consumer.branch}${why ? `: ${why}` : ''}`);
      return { repo: name, version, kind: 'failed', detail: `worktree of origin/${consumer.branch}: ${why}` };
    }
    const taken = await takeVersion(ctx, consumer, dir, {
      version,
      ref: version,
      opener: '`plx update`',
      why: need.why,
      reviewers,
    });
    return { repo: name, version, kind: 'taken', taken };
  } finally {
    await ctx.stage(run('git', ['worktree', 'remove', '--force', dir], { cwd: repo })).catch(() => undefined);
    if (scratch) await ctx.stage(run('rm', ['-rf', scratch]));
  }
}

/**
 * The repo at `path`, which must be generated from a repo template, as a
 * consumer whose sites are named from `name` rather than from a workspace.
 */
async function repoAt(ctx: Context, path: string, name: string): Promise<Consumer> {
  const tree = await overview(ctx, path);
  const found = (await findConsumers(ctx, tree, TEMPLATES)).find((c) => c.path === tree.path);
  if (!found)
    throw new Error(
      `${path} is not a repo generated from the templates: no ${ANSWERS_FILE} at its root naming one of ${TEMPLATES.map(templateSource).join(', ')}`,
    );
  if (found.skipped) throw new Error(`${name}: ${found.skipped}`);
  return {
    ...found,
    rel: name,
    sites: found.sites.map((s) => ({ ...s, rel: s.rel === '.' ? name : join(name, s.rel) })),
  };
}

/**
 * Whether origin has the branch: true or false as `git ls-remote` answers,
 * undefined when it could not be asked (no network, no such remote), which
 * the step that needs the branch then reports.
 */
async function onOrigin(ctx: Context, repo: string, branch: string): Promise<boolean | undefined> {
  try {
    await ctx.read('git', ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`], { cwd: repo });
    return true;
  } catch (error) {
    // --exit-code: 2 is "no such ref"; anything else is a failure to ask.
    return error instanceof ExecError && error.code === 2 ? false : undefined;
  }
}

/** Where the versions are read from: the compendium's releases. */
const RELEASES_REPO = `plexus-ms/${COMPENDIUM}`;

/** The versions (§ 1.6 PLX: every version tag has a release), with the dates they were cut; a draft is no version yet. */
export async function releasesOf(ctx: Context): Promise<Release[]> {
  const jq = '.[] | select(.draft | not) | "\\(.tag_name) \\(.published_at)"';
  const lines = await ctx
    .read('gh', ['api', `repos/${RELEASES_REPO}/releases`, '--paginate', '--jq', jq])
    .catch(() => '');
  return lines
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p): p is [string, string] => p.length === 2 && isPlexusVersion(p[0] ?? ''))
    .map(([version, published]) => ({ version, published }));
}

/** The newest version among the releases. */
function newestOf(releases: Release[]): string {
  const newest = releases.map((r) => r.version).reduce((a, b) => (a && compareVersions(a, b) >= 0 ? a : b), '');
  if (!newest) throw new Error(`no release of ${RELEASES_REPO} found — pass the version explicitly (--to <version>)`);
  return newest;
}
