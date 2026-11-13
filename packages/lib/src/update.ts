// update: a repo generated from the templates takes the version itself (§ 3
// PLX-Updates), from inside the repo, in the tenant's own CI or by hand; it is
// the only thing that opens a version's pull request.
//
// It takes a version when the repo needs one, not whenever one was cut
// (need.ts): when it is asked (`--now`, or a version named), when a module one
// of its markers declares has changed since that marker (read from the
// manifest on the version's release, manifest.ts), or when the oldest version the
// repo has not taken is older than the backstop age, which the repo's answers
// set (`update_max_age`, in days; 30 when they do not say, zero for every
// version). Otherwise the repo rests: one line saying why, exit 0.
//
// The markers that count are those of the repo's sites, root and apps: the
// ones a pull brings up to the version. A marker anywhere else is kept by hand,
// a pull would not cure it, and `doctor` is what reports it.
//
// The versions are the compendium's GitHub releases (every version tag is locked
// by one, § 1.6 PLX, and the compendium is released last, so a version shows
// there once it is cut everywhere), asked of the forge as an operator would
// (`gh api repos/plexus-ms/compendium/releases`): the newest is the version to
// take, and their dates are what the backstop is measured against. The work happens in a
// worktree of origin's branch, never in the checkout: a developer's branch and
// edits stay as they are, and in CI the worktree shares the checkout's
// credentials, so the push and the pull request need no second token. Then
// `takeVersion` (propagate.ts): copier update at every site, marker, lockfile,
// workflow refs, one commit on `plexus/<version>`, one pull request.
//
// The version is pulled once per repo: a `plexus/<version>` branch already on
// origin, from an earlier run or from a human resolving its conflicts, is
// left alone, so a daily run never moves a branch somebody is
// working on; deleting the branch is how a pull is redone. A repo whose every
// site already records the version does nothing at all.
//
//   plx update                      # the newest version, if the repo needs it
//   plx update --now                # the newest version, whatever its triggers say
//   plx -n update --now             # preview in a worktree, push nothing
//   plx -y update --to 0.102.0   # unattended, an explicit version
import { basename, join, relative } from 'node:path';
import { type Consumer, findConsumers, TEMPLATES, templateSource } from './consumers.ts';
import type { Context } from './context.ts';
import { ANSWERS_FILE, parseAnswers } from './copier.ts';
import { compareVersions } from './doctor.ts';
import { run } from './effects.ts';
import { catalogOf, MANIFEST_FILE, parseManifest } from './manifest.ts';
import { MARKER_FILE, parseMarker } from './marker.ts';
import { type Marked, maxAgeOf, needOf, type Release, type Stale, staleModules } from './need.ts';
import { overview } from './overview.ts';
import { CLEAN_BODY, detail, emptySummary, openPullUrl, type Summary, takeVersion, versionBranch } from './take.ts';
import { COMPENDIUM, isPlexusVersion, preflightForge, UsageError } from './version.ts';

export interface UpdateOptions {
  /** The repo to update: a checkout whose root is a site of a repo template. */
  repo: string;
  /** What the repo is called in the narration and the summary; default: its directory's name. */
  name?: string;
  /** The version to take, which is asking for it; default: the template's newest release. */
  to?: string;
  /** Take the newest version whatever the triggers say: somebody asks. */
  now?: boolean;
  /** The backstop age in days; default: the repo's answer `update_max_age`, else 30. */
  maxAge?: number;
  /** The clock the backstop is measured against, as a date; default: now. */
  today?: string;
}

export async function update(ctx: Context, options: UpdateOptions): Promise<Summary> {
  const { repo } = options;
  const name = options.name ?? basename(repo);
  if (options.to !== undefined && !isPlexusVersion(options.to))
    throw new UsageError(`'${options.to}' is not plain semver (X.Y.Z, no v)`);

  const tree = await overview(ctx, repo);
  const consumer = (await findConsumers(ctx, tree, TEMPLATES)).find((c) => c.path === tree.path);
  if (!consumer)
    throw new Error(
      `${repo} is not a repo generated from the templates: no ${ANSWERS_FILE} at its root naming one of ${TEMPLATES.map(templateSource).join(', ')}`,
    );
  if (consumer.skipped) throw new Error(`${name}: ${consumer.skipped}`);
  // Sites are named from the repo, not from a workspace.
  consumer.rel = name;
  for (const s of consumer.sites) s.rel = s.rel === '.' ? name : join(name, s.rel);
  const root = consumer.sites.find((s) => s.path === consumer.path);
  if (!root) throw new Error(`${name}: its root is not a site of a repo template`);

  await preflightForge(ctx);
  const releases = options.to === undefined ? await releasesOf(ctx) : [];
  const version = options.to ?? newestOf(releases);
  const summary = emptySummary(version, ctx.dryRun);

  // The repo is judged by what its origin has on the branch the version lands
  // on, not by the checkout, which may be behind it or on a branch of its own.
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
  if (recorded.every((c) => c === version)) {
    ctx.say(`• ${name}: already at ${version}`);
    return summary;
  }
  // copier refuses a downgrade; say so before a worktree is made for nothing.
  const past = recorded.find((c) => c && isPlexusVersion(c) && compareVersions(c, version) > 0);
  if (past) throw new Error(`${name} is at ${past}, past ${version}; a repo is never taken back to an older version`);

  const branch = versionBranch(version);
  const onOrigin = await ctx
    .read('git', ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`], { cwd: repo })
    .then(() => true)
    .catch(() => false);
  if (onOrigin) {
    const url = await openPullUrl(ctx, consumer, repo, version);
    ctx.say(
      `• ${name}: ${branch} is already on origin${url ? ` (${url})` : ''} — nothing to do; delete the branch to pull the version again`,
    );
    if (url) {
      summary.pulls.push(url);
      // Whether it merged clean is what its body says (take.ts wrote it).
      const body = await ctx
        .read('gh', ['pr', 'view', url, '--json', 'body', '--jq', '.body'], { cwd: repo })
        .catch(() => '');
      if (body.includes(CLEAN_BODY)) summary.mergeable.push(url);
    }
    return summary;
  }

  const asked = options.to !== undefined ? `--to ${version}` : options.now ? '--now' : undefined;
  const need = needOf({
    recorded,
    releases,
    asked,
    stale: asked ? [] : await staleIn(ctx, consumer, repo, version),
    maxAge: options.maxAge ?? maxAgeOf(answers[consumer.sites.indexOf(root)]?.answers ?? {}),
    now: options.today === undefined ? new Date() : new Date(options.today),
  });
  if (!need.take) {
    ctx.say(`• ${name}: rests — ${need.why} (plx update --now takes ${version})`);
    summary.resting.push({ path: name, reason: need.why });
    return summary;
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
      ctx.say(`  ✗ FAILED — worktree of origin/${consumer.branch}${detail(error)}`);
      summary.failed.push(name);
      return summary;
    }
    await takeVersion(ctx, consumer, dir, { version, ref: version, opener: '`plx update`', why: need.why }, summary);
  } finally {
    await ctx.stage(run('git', ['worktree', 'remove', '--force', dir], { cwd: repo })).catch(() => undefined);
    if (scratch) await ctx.stage(run('rm', ['-rf', scratch]));
  }
  return summary;
}

/**
 * The declared modules of the repo's sites that changed since their markers,
 * by the manifest of the version. A version without a manifest (one cut before
 * there were any, or a forge that cannot be asked) is said and checked for
 * nothing: the backstop still holds.
 */
async function staleIn(ctx: Context, consumer: Consumer, repo: string, version: string): Promise<Stale[]> {
  const text = await ctx
    .read('gh', ['release', 'download', version, '-R', RELEASES_REPO, '-p', MANIFEST_FILE, '-O', '-'])
    .catch(() => undefined);
  if (text === undefined) {
    ctx.say(
      `  ${consumer.rel}: Plexus ${version} carries no ${MANIFEST_FILE} that can be read; its modules are not checked`,
    );
    return [];
  }
  const catalog = catalogOf(parseManifest(text));
  const markers: Marked[] = [];
  for (const site of consumer.sites) {
    const file = join(relative(consumer.path, site.path), MARKER_FILE);
    const marker =
      (await ctx.read('git', ['show', `origin/${consumer.branch}:${file}`], { cwd: repo }).catch(() => undefined)) ??
      (await ctx.readFile(join(site.path, MARKER_FILE)).catch(() => undefined));
    if (marker === undefined) continue;
    try {
      const { plexus, modules } = parseMarker(marker);
      markers.push({ where: join(site.rel, MARKER_FILE), plexus, modules });
    } catch {
      // An unreadable marker is doctor's finding, not a reason to take a version.
    }
  }
  return staleModules(markers, catalog);
}

/** Where the versions are read from: the compendium's releases. */
const RELEASES_REPO = `plexus-ms/${COMPENDIUM}`;

/** The versions (§ 1.6 PLX: every version tag has a release), with the dates they were cut; a draft is no version yet. */
async function releasesOf(ctx: Context): Promise<Release[]> {
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
