// update: a repo generated from the templates takes the version itself (§ 3
// PLX-Updates), from inside the repo, in the tenant's own CI or by hand; it is
// the only thing that opens a version's pull request.
//
// Which version it takes, if any, is need.ts's decision, by the step of the
// version number: a patch (a hotfix) at once, a minor (routine) at the repo's
// next scheduled pull, once the oldest version it has not taken is as old as
// its interval (`update_max_age` in its root marker, in days; 7 when it does
// not say, zero for every version), a major (a changed contract) only when
// asked. Asked (`--now`, or a version named), it takes the newest version, or
// the one named, whatever its step. Otherwise the repo rests: one line saying
// why, exit 0.
//
// The versions are the compendium's GitHub releases (every version tag is locked
// by one, § 1.6 PLX, and the compendium is released last, so a version shows
// there once it is cut everywhere), asked of the forge as an operator would
// (`gh api repos/plexus-ms/compendium/releases`): their numbers are the steps,
// and their dates are what the interval is measured against.
//
// The repo is judged by what origin has on the branch the version lands on
// (consumers.ts), never by the checkout, which may be behind it or on a branch
// of its own. Its markers there are its configuration (sites.ts): the root
// marker's `version` is the version the repo is on, and refusing a downgrade,
// the interval and readiness all read it. A repo that still tracks a copier
// answers file there has not crossed over to the markers, and is refused with
// the crossover runbook: that refusal is the only crossover code. So is a
// marker that cannot be read, and a root marker that names no version.
//
// Taking the version happens in a worktree of origin's branch, never in the
// checkout: a developer's branch and edits stay as they are, and in CI the
// worktree shares the checkout's credentials, so the push and the pull request
// need no second token. The template step, then `takeVersion` (take.ts):
//   1. Every site the worktree's markers list templates for (sites.ts), the
//      root first, has two sides, its markers' answers and templates as they
//      are: the old side rendered with the templates of the version the repo
//      is on, the new side with those of the version it takes. The templates
//      of the running plx's own version are the ones it bundles, rendered by
//      its own engine; any other version's are fetched from the registry and
//      rendered by that version's plx-template (versionTemplates.ts). A version
//      that cannot be fetched or rendered fails the run, which pushes nothing.
//   2. The two renders are merged into each site by the engine's rules
//      (sync.ts): a local edit merges, a conflict stays in the file between
//      `<<<<<<< current` and `>>>>>>> new render`, a file the version drops and
//      the user edited is kept, and a born-once file the old render holds
//      stays as the user left it. The defaults of questions that became
//      applicable and the new `version` are spliced into the markers in one
//      write each. Birth commands are never run, and neither is `mise
//      install`: tools serve a developer's checkout, not a pull request.
//   3. The lockfile where a manifest moved, the workflow refs, one commit on
//      `plexus/<version>`, and one pull request (take.ts). The `plx` pin is a
//      line of a template's mise.toml, so it moves in the same commit as the
//      version.
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
// rewritten to what still needs a hand, ready once no conflict marker remains
// and the root marker names the version.
// With no pull request in any state (opening it failed after the push), the
// run opens it then; a closed or merged one stays as a human left it.
// A repo whose root marker already names the newest version does nothing at
// all.
//
// The pull request it opens asks for a review from the users the repo's root
// marker names (`pr_reviewers`), or from those `reviewers` names instead
// (pull.ts), once, when it is opened. The answer is read and checked only
// then, from the root marker as the pull request's branch has it: a bad one
// fails no run that opens nothing, and the pull request is opened all the
// same, with the refused answer reported.
//
//   plx update                      # the version the repo's schedule takes, if any
//   plx update --now                # the newest version, whatever its step
//   plx -n update --now             # preview in a worktree, push nothing
//   plx -y update --to 0.102.0      # unattended, an explicit version
//   plx update --recursive ~/dev    # every repo under a directory (recursive.ts)
import { basename, join } from 'node:path';
import { CROSSOVER_RUNBOOK } from './apply.ts';
import { type Consumer, findRepos } from './consumers.ts';
import type { Context } from './context.ts';
import { ANSWERS_FILE } from './copier.ts';
import { crossedOver } from './doctor.ts';
import { run } from './effects.ts';
import { detailOf, ExecError } from './io.ts';
import { MARKER_FILE } from './marker.ts';
import { maxAgeOf, type Need, needOf, type Release } from './need.ts';
import { overview } from './overview.ts';
import { openLate, pullOf, type Review, type Reviewers, revisit, tipOnOrigin, versionBranch } from './pull.ts';
import { findSites, type MarkerSite, siteAnswers } from './sites.ts';
import { planSync, type Source } from './sync.ts';
import { type SiteResult, type Taken, takeVersion } from './take.ts';
import { COMPENDIUM, compareVersions, isPlexusVersion, preflightForge, UsageError } from './version.ts';
import { type FetchVersion, templatesOf } from './versionTemplates.ts';

export interface UpdateOptions {
  /** The repo to update: a checkout whose root marker names the version it is on. */
  repo: string;
  /** What the repo is called in the narration and the summary; default: its directory's name. */
  name?: string;
  /** The Plexus version of the running plx, whose templates are bundled. */
  plxVersion: string;
  /** The templates the running plx bundles; default `templatesRoot()`. */
  templates?: string;
  /** How another version's templates are fetched; default: from the npm registry (versionTemplates.ts). */
  fetch?: FetchVersion;
  /** The version to take, which is asking for it; default: the newest release. */
  to?: string;
  /** Take the newest version whatever its step: somebody asks. */
  now?: boolean;
  /** The interval in days; default: the root marker's answer `update_max_age`, else 7. */
  maxAge?: number;
  /** The clock the interval is measured against, as a date; default: now. */
  today?: string;
  /** The users asked to review the pull request it opens; default: the root marker's answer `pr_reviewers`, else none. */
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
 * would take. `current`: its root marker names it already. `skipped`: left
 * untouched, with why. `resting`: needs no version yet (need.ts), with what
 * would end the rest. `found`: its version branch is on origin already, with
 * the pull request found or, when there was none, opened there, the files of
 * the branch that hold conflict markers, its sites not at the version (its
 * root, when the root marker does not name it), whether it is ready to merge,
 * why looking at it failed, if it did, and the review request of one opened.
 * A closed or merged one is no pull to list.
 * `taken`: it took the version. `failed`: it could not be worked on, with why.
 */
export type Outcome = { repo: string; version: string } & (
  | { kind: 'current' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'resting'; reason: string }
  | {
      kind: 'found';
      pull?: string;
      /** A dry run would open the missing pull request. */
      opening?: true;
      marked: string[];
      behind: string[];
      mergeable: boolean;
      failed?: string;
      review?: Review;
    }
  | { kind: 'taken'; taken: Taken }
  | { kind: 'failed'; detail: string }
);

export async function update(ctx: Context, options: UpdateOptions, known?: Known): Promise<Outcome> {
  if (options.to !== undefined && !isPlexusVersion(options.to))
    throw new UsageError(`'${options.to}' is not plain semver (X.Y.Z, no v)`);
  const consumer = known?.consumer ?? (await repoAt(ctx, options.repo, options.name ?? basename(options.repo)));
  const { path: repo, rel: name } = consumer;

  if (!known) await preflightForge(ctx);
  const releases = known?.releases ?? (options.to === undefined ? await releasesOf(ctx) : []);
  const newest = options.to ?? newestOf(releases);

  // Without the branch the version lands on there is nothing to take it on.
  if ((await onOrigin(ctx, repo, consumer.branch)) === false) {
    const reason = `origin has no branch \`${consumer.branch}\`, the one the version lands on`;
    ctx.say(`⚠ ${name}: ${reason} — skipped`);
    return { repo: name, version: newest, kind: 'skipped', reason };
  }
  await ctx.read('git', ['fetch', '--quiet', 'origin', consumer.branch], { cwd: repo }).catch(() => '');
  const base = `refs/remotes/origin/${consumer.branch}`;
  const on = await versionOn(ctx, consumer, base);
  if (on.version === newest) {
    ctx.say(`• ${name}: already at ${newest}`);
    return { repo: name, version: newest, kind: 'current' };
  }
  if (compareVersions(on.version, newest) > 0)
    throw new Error(`${name} is at ${on.version}, past ${newest}; a repo is never taken back to an older version`);

  const asked = options.to !== undefined || options.now === true;
  const need: Need = asked
    ? { take: true, version: newest, why: `asked for (${options.to !== undefined ? `--to ${newest}` : '--now'})` }
    : needOf({
        recorded: [on.version],
        releases,
        maxAge: options.maxAge ?? maxAgeOf(on.answers),
        now: options.today === undefined ? new Date() : new Date(options.today),
      });
  if (need.held) ctx.say(`• ${name}: ${need.held} (plx update --now takes it)`);
  // Unless named, read where the pull request is opened, from its branch's root marker, and only then.
  const reviewers: Reviewers | undefined = options.reviewers ? { named: options.reviewers } : undefined;
  // A repo that rests is looked at for the newest version: one asked for earlier may be on origin.
  const version = need.take ? need.version : newest;

  const branch = versionBranch(version);
  if (await onOrigin(ctx, repo, branch)) {
    // A closed pull request is the branch's only when it was closed at the tip origin has now.
    const tip = await tipOnOrigin(ctx, repo, branch);
    // A forge that cannot be asked fails the run here: it is never taken for "no pull request".
    const pull = await pullOf(ctx, consumer, repo, version, tip);
    if (!pull) {
      try {
        const late = await openLate(ctx, consumer, version, reviewers, tip);
        if (late.failed) ctx.say(`  ✗ FAILED — ${late.failed}`);
        return {
          repo: name,
          version,
          kind: 'found',
          ...(late.pull ? { pull: late.pull.url } : {}),
          ...(late.previewed ? { opening: true as const } : {}),
          marked: late.marked,
          behind: late.behind,
          mergeable: late.pull !== undefined && !late.pull.draft && late.ready,
          ...(late.failed ? { failed: late.failed } : {}),
          ...(late.review ? { review: late.review } : {}),
        };
      } catch (error) {
        const why = detailOf(error);
        ctx.say(`  ✗ FAILED — ${branch} as origin has it${why ? `: ${why}` : ''}`);
        return { repo: name, version, kind: 'found', marked: [], behind: [], mergeable: false, failed: why };
      }
    }
    if (!pull.open) {
      ctx.say(
        `• ${name}: ${branch} is already on origin, its pull request closed (${pull.url}) — nothing to do; delete the branch to pull the version again`,
      );
      return { repo: name, version, kind: 'found', marked: [], behind: [], mergeable: false };
    }
    try {
      const { url, ...found } = await revisit(ctx, consumer, pull, version, tip);
      if (found.failed) ctx.say(`  ✗ FAILED — ${found.failed}`);
      return { repo: name, version, kind: 'found', pull: url, ...found };
    } catch (error) {
      const why = detailOf(error);
      ctx.say(`  ✗ FAILED — ${branch} as origin has it${why ? `: ${why}` : ''}`);
      return {
        repo: name,
        version,
        kind: 'found',
        pull: pull.url,
        marked: [],
        behind: [],
        mergeable: false,
        failed: why,
      };
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
    try {
      const taken = await takeVersion(ctx, consumer, dir, {
        version,
        opener: '`plx update`',
        why: need.why,
        sites: (ctx, consumer, dir) =>
          renderSites(
            ctx,
            consumer,
            dir,
            { from: on.version, to: version, scratch: join(scratch, 'versions') },
            options,
          ),
        ...(reviewers ? { reviewers } : {}),
      });
      return { repo: name, version, kind: 'taken', taken };
    } catch (error) {
      const why = (error as Error).message;
      ctx.say(`  ✗ FAILED — ${name}: ${why}`);
      return { repo: name, version, kind: 'failed', detail: why };
    }
  } finally {
    await ctx.stage(run('git', ['worktree', 'remove', '--force', dir], { cwd: repo })).catch(() => undefined);
    if (scratch) await ctx.stage(run('rm', ['-rf', scratch]));
  }
}

/**
 * The version the repo is on at `ref`, origin's branch: its root marker's
 * `version`, with the root marker's answers. Refuses a repo that still tracks
 * a copier answers file there, any marker that cannot be read, and a root
 * marker that names no version.
 */
async function versionOn(
  ctx: Context,
  consumer: Consumer,
  ref: string,
): Promise<{ version: string; answers: Record<string, unknown> }> {
  const where = `on origin's \`${consumer.branch}\``;
  const tracked = (await ctx.read('git', ['ls-tree', '-r', '-z', '--name-only', ref], { cwd: consumer.path }))
    .split('\0')
    .filter(Boolean);
  if (!crossedOver(tracked))
    throw new Error(
      `${consumer.rel} still tracks a ${ANSWERS_FILE} ${where}: it has not crossed over from copier to the markers, which plx update reads; follow ${CROSSOVER_RUNBOOK}`,
    );
  const sites = await findSites(ctx, consumer.path, ref);
  const problems = sites.filter((s) => s.problem !== undefined);
  if (problems.length > 0)
    throw new Error(problems.map((s) => `${join(s.dir, MARKER_FILE)} ${where}: ${s.problem}`).join('\n'));
  const root = sites.find((s) => s.dir === '.')?.config;
  if (root?.version === undefined)
    throw new Error(
      `the root ${MARKER_FILE} of ${consumer.rel} ${where} names no version, so plx update cannot tell which version it is on`,
    );
  return { version: root.version, answers: root.answers };
}

/**
 * The template step of a version taken (the header's steps 1 and 2), in the
 * worktree `dir`: every site its markers list templates for, rendered at
 * `from` and at `to` and merged, the defaults and the version written into the
 * markers. What became of each site is what the merge reported.
 */
async function renderSites(
  ctx: Context,
  consumer: Consumer,
  dir: string,
  versions: { from: string; to: string; scratch: string },
  options: UpdateOptions,
): Promise<SiteResult[]> {
  const sites = await findSites(ctx, dir, 'HEAD');
  const sourceOf = (site: MarkerSite): Source => ({
    templates: site.config?.templates ?? [],
    answers: siteAnswers(sites, site.dir),
  });
  const taken = sites.filter((s) => s.dir === '.' || s.config?.templates !== undefined);
  const sides = taken.map((s) => ({
    dir: s.dir,
    old: sourceOf(s),
    new: sourceOf(s),
    ...(s.config?.templates === undefined ? { contextOnly: true } : {}),
  }));
  const siblings = sites
    .filter((s) => s.dir !== '.')
    .map((s) => ({ dir: s.dir, templates: s.config?.templates ?? [], answers: s.config?.answers ?? {} }));
  ctx.say(`→ ${consumer.rel}: the templates of ${versions.from} and ${versions.to}, merged`);
  const of = (version: string) =>
    templatesOf(ctx, version, {
      plxVersion: options.plxVersion,
      scratch: versions.scratch,
      ...(options.templates ? { bundled: options.templates } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  const plan = await planSync(ctx, dir, { old: await of(versions.from), new: await of(versions.to) }, sides, {
    labels: { old: `the templates of ${versions.from}`, new: `the templates of ${versions.to}` },
    siblings,
    version: versions.to,
  });
  await plan.perform();
  return plan.sites.map((s) => {
    const rel = s.dir === '.' ? consumer.rel : join(consumer.rel, s.dir);
    const conflicted = s.report.some((e) => e.outcome === 'conflicted');
    ctx.say(conflicted ? `  ✗ CONFLICTS at ${rel}, committed with their markers` : `  ✓ merged clean: ${rel}`);
    return { rel, dir: s.dir, outcome: conflicted ? 'conflicted' : 'clean' };
  });
}

/** The repo at `path`, which must be generated from the templates, named `name` rather than from a workspace. */
async function repoAt(ctx: Context, path: string, name: string): Promise<Consumer> {
  const tree = await overview(ctx, path);
  const found = (await findRepos(ctx, tree)).find((c) => c.path === tree.path);
  if (!found)
    throw new Error(
      `${path} is not a repo generated from the templates: its root ${MARKER_FILE} names no version and lists no templates`,
    );
  if (found.skipped) throw new Error(`${name}: ${found.skipped}`);
  return { ...found, rel: name };
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
