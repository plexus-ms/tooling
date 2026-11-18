// ship: the Plexus version (§ 1.5 PLX). Every versioned repo ships under ONE
// version, tagged identically whether or not it changed, in two phases:
//
//   preflight (every versioned repo on main, clean, not behind origin, the latest
//   tags in agreement; gh logged in; no mutable release on any versioned repo;
//   `plx requirements` passing in every versioned repo, as this source checks
//   it; on a re-run, the compendium still yielding the citable index tooling
//   was tagged with, and no bookkeeping left to write in a repo already tagged;
//   every template being cut passing its newborn test, and every newborn it
//   renders passing the doctor as this source checks it, newborn.ts)
//   → phase one: tooling's bookkeeping (galaxy versions, the Plexus-versioned
//     packages' manifests, its own workflow refs, the citable index read from
//     the compendium), commit, tag, push, GitHub
//     release — which locks the tag and runs tooling's release workflow
//   → wait until the three packages are on npm at the Plexus version
//   → phase two: the templates' and the compendium's bookkeeping (collection
//     pin, workflow refs, plx pins, the map's version and timestamp), commit,
//     tag, push, release, repo by repo; the compendium last
//
// and there it ends. Cutting a version and a repo taking it are separate events
// (§ 3 PLX-Updates): ship looks for no consumer and opens no pull request; a
// repo takes the version itself, by its step and a schedule (update.ts). The
// dry run is the one place consumers still appear: it previews the unreleased
// templates against the workspace's consumers (preview.ts), a maintainer's test.
//
// Every release lists the subjects of the commits since the previous version,
// each a code span, so a tenant can read what a version concerns. The step of the number is the
// maintainers' to choose and says how urgently a repo takes the version (§ 3
// PLX-Updates): a hotfix is cut as a patch (`--to`), routine work as the next
// minor (the default), a changed contract as a major. ship checks nothing
// about the step, but refuses a version below the latest (version.ts).
//
// The wait is what lets phase two pin the Plexus version: the compendium's
// commit hook installs plx at that pin, and the templates hand it to every
// consumer. Substance commits stay human; ship writes only the mechanical
// bookkeeping. A failure between the first tag and the last release leaves a
// half-tagged version; the recovery is a re-run naming the same version, which
// skips the repos already tagged and the releases that exist. A release is
// never deleted: a deleted immutable release burns its number for good.
//
// ship runs from the source of the tooling checkout it cuts (`mise ship`
// there), never as a published package: the tool that releases the version is
// never itself a release that could lag behind it.
//
//   plx-dev ship ~/dev                    # next version = minor+1 over the latest
//   plx-dev ship ~/dev --to 1.0.0      # explicit Plexus version
//   plx-dev -n ship ~/dev                 # preview: list the bookkeeping and tags, and
//                                         # try the templates on the consumers in scratch clones
//   plx-dev -y ship ~/dev                 # unattended: no prompt
import { join } from 'node:path';
import {
  bumpWorkflowRefs,
  COMPENDIUM,
  type Context,
  checkRepo,
  compareVersions,
  emptySummary,
  frontmatterField,
  MAP_PAGE,
  PLX_PIN,
  type Plan,
  parseStandardIndex,
  preflightForge,
  readCitable,
  renderStandardIndex,
  run,
  STANDARD_INDEX_FILE,
  type Summary,
  WORKFLOW_REF,
  write,
} from '@plexus-ms/lib';
import {
  bumpCollectionPin,
  bumpGalaxyVersion,
  bumpManifestVersion,
  bumpPlxPin,
  bumpRunnerImagePin,
  COLLECTIONS,
  galaxyFile,
  RUNNER_IMAGE_PIN_FILE,
  stampStandard,
  today as todayOf,
} from './bookkeeping.ts';
import { preflightNewborns } from './newborn.ts';
import { previewConsumers } from './preview.ts';
import {
  latestTag,
  nextMinor,
  phasesOf,
  preflightRelease,
  readVersioned,
  resolveVersion,
  TOOLING,
  UPSTREAM,
  VERSIONED_PACKAGES,
  type Versioned,
  type VersionedRepo,
} from './version.ts';

/** How the wait for npm between the phases behaves, in milliseconds. */
export interface PublishWait {
  /** Between two polls of the registry. */
  interval: number;
  /** After which the run stops, resumable. */
  timeout: number;
}

const DEFAULT_WAIT: PublishWait = { interval: 15_000, timeout: 20 * 60_000 };

export interface ShipOptions {
  /** The workspace: the upstream umbrella sits under it, and for the dry run's preview the consumers. */
  workspace: string;
  /** The Plexus version; default: minor+1 over the latest. */
  to?: string;
  /** The date stamped on the map, `YYYY-MM-DD`; default: today. */
  today?: string;
  /** The publish wait's pacing; the defaults suit a real registry, tests shorten them. */
  wait?: Partial<PublishWait>;
  /** How long each template's newborn test may run, in milliseconds; default VERIFY_LIMIT, tests shorten it. */
  newbornLimit?: number;
}

/** The version cut, and under a dry run what the preview found in the consumers; a real run's lists are empty. */
export interface ShipResult extends Summary {
  released: boolean;
}

export async function ship(ctx: Context, options: ShipOptions): Promise<ShipResult> {
  const upstream = join(options.workspace, UPSTREAM);
  const versioned = await readVersioned(ctx, upstream);
  await preflightForge(ctx);
  await preflightRelease(ctx, versioned);
  await preflightImmutable(ctx, versioned);
  const next = resolveVersion(versioned, options.to);
  await preflightRequirements(ctx, versioned);
  await preflightIndex(ctx, versioned, next);
  const today = options.today ?? todayOf();
  await preflightAfterTag(ctx, versioned, next, today);
  await preflightNewborns(ctx, versioned, next, options.newbornLimit);
  await release(ctx, versioned, next, today, { ...DEFAULT_WAIT, ...options.wait });
  if (ctx.dryRun) return { ...(await previewConsumers(ctx, options.workspace, next)), released: true };
  ctx.say(`• Plexus ${next} is cut; every repo takes it itself, by its step and a schedule (plx update)`);
  return { ...emptySummary(next, false), released: true };
}

/**
 * The immutable-releases setting is not readable through the API, but every
 * release says whether it is immutable: a versioned repo whose newest release is
 * mutable had the setting off when it was cut, and the version stops before
 * another number is spent. A repo with no release yet is checked on its first
 * one, right after creation (tagAndRelease).
 */
async function preflightImmutable(ctx: Context, versioned: Versioned): Promise<void> {
  for (const repo of versioned.repos) {
    const newest = (
      await ctx
        .read('gh', ['api', 'repos/{owner}/{repo}/releases?per_page=1', '--jq', '.[0].immutable'], { cwd: repo.path })
        .catch(() => '')
    ).trim();
    if (newest === 'false') throw new Error(mutableRelease(`${repo.name}: its newest GitHub release is not immutable`));
  }
}

/**
 * Every versioned repo passes `plx requirements` as the plx being cut checks it,
 * citations resolved against the compendium being cut. Phase two commits in
 * the compendium under its hook, which runs plx at the new pin; a repo that
 * fails there stops the version halfway, after tooling and the templates are
 * released. Tooling's pre-push after its tag runs the same check. The
 * bookkeeping itself writes only frontmatter, pins and refs, which no lint reads
 * as a violation, so a repo that passes here passes there.
 */
async function preflightRequirements(ctx: Context, versioned: Versioned): Promise<void> {
  const compendium = versioned.repos.find((r) => r.name === COMPENDIUM)?.path;
  const failing: string[] = [];
  let repos = 0;
  for (const repo of versioned.repos) {
    const { defects } = await checkRepo(ctx, repo.path, { compendium });
    if (defects.length === 0) continue;
    repos++;
    // The command checks as this preflight does: against the compendium being
    // cut, not the index of whichever plx runs it.
    const against = compendium && repo.path !== compendium ? ` --compendium ${compendium}` : '';
    failing.push(`  ${repo.name}: ${count(defects.length, 'defect')}`, ...defects.slice(0, 5).map((d) => `    ${d}`));
    if (defects.length > 5) failing.push(`    … and ${defects.length - 5} more`);
    failing.push(`    to record them as known: plx requirements ${repo.path} --write-baseline${against}`);
  }
  if (repos === 0) return;
  throw new Error(
    `plx requirements fails in ${count(repos, 'versioned repo')}:\n${failing.join('\n')}\nfix them, or record them as known with the command given and commit the baseline, before cutting a version`,
  );
}

/**
 * A repo whose latest tag already is the version takes no bookkeeping write:
 * a commit after the tag is never part of the version. On the re-run of a
 * version ship stopped, a tagged repo has nothing left to write, since its tag
 * is on its bookkeeping commit; anything still to write means the tag was made
 * elsewhere, or main moved since. Refused before anything is written, the dry
 * run included, naming every write it would have made.
 */
async function preflightAfterTag(ctx: Context, versioned: Versioned, next: string, today: string): Promise<void> {
  const { afterTag } = await planBookkeeping(ctx, versioned, versioned.repos, next, today, { quiet: true });
  if (afterTag.length === 0) return;
  const names = [...new Set(afterTag.map((w) => w.repo))];
  throw new Error(
    [
      `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} tagged ${next} already, and the bookkeeping would still write:`,
      ...afterTag.map((w) => `  ${w.repo}: ${w.rel}: ${w.what}`),
      `a commit after the tag is never part of ${next}: make ${names.join(' and ')} match (commit those changes on main yourself) and re-run with --to ${next}, or cut a new version (--to ${nextMinor(next)})`,
    ].join('\n'),
  );
}

const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? '' : 's'}`;

/**
 * On a re-run with tooling already tagged, its packages are published (or about
 * to be) with the citable index at that tag, and phase two tags the compendium
 * as it is now: the two must still agree. The bookkeeping does not write the
 * index again, since a commit after the tag would never be released; a
 * compendium that moved since is refused, naming what moved.
 */
async function preflightIndex(ctx: Context, versioned: Versioned, next: string): Promise<void> {
  const tooling = versioned.repos.find((r) => r.name === TOOLING);
  const compendium = versioned.repos.find((r) => r.name === COMPENDIUM);
  if (!tooling?.tag || tooling.latest !== next || !compendium) return;
  const atTag = await ctx
    .read('git', ['show', `refs/tags/${tooling.tag}:${STANDARD_INDEX_FILE}`], { cwd: tooling.path })
    .catch(() => undefined);
  if (atTag === undefined) return; // a tag from before tooling carried an index
  const tagged = parseStandardIndex(atTag).citable;
  const now = await readCitable(ctx, compendium.path);
  if (tagged.join('\n') === now.join('\n')) return;
  const diff = [
    ...now.filter((c) => !tagged.includes(c)).map((c) => `  + ${c}`),
    ...tagged.filter((c) => !now.includes(c)).map((c) => `  - ${c}`),
  ];
  throw new Error(
    `the citable index tooling carries at ${next} differs from the compendium:\n${(diff.length > 0 ? diff : ['  (the same entries, in another order)']).join('\n')}\nthe packages of ${next} carry the index at the tag; revert the compendium change and re-run with --to ${next}, or cut a new version`,
  );
}

const mutableRelease = (what: string): string =>
  `${what} — enable immutable releases on the plexus-ms organisation (Settings → General → Releases); existing releases stay as they are (never delete one: a deleted immutable release burns its number)`;

async function release(
  ctx: Context,
  versioned: Versioned,
  next: string,
  today: string,
  wait: PublishWait,
): Promise<void> {
  ctx.say(`→ Plexus ${versioned.last ?? 'none'} → ${next}`);
  for (const repo of versioned.repos) {
    if (repo.pending.length === 0) ctx.say(`  ${repo.name}: no changes since ${repo.latest} — tag only`);
    else {
      ctx.say(`  ${repo.name} (since ${repo.latest ?? 'the beginning'}):`);
      for (const line of repo.pending.slice(0, PENDING_SHOWN)) ctx.say(`    ${line}`);
      if (repo.pending.length > PENDING_SHOWN) ctx.say(`    … and ${repo.pending.length - PENDING_SHOWN} more`);
    }
  }
  if (!(await ctx.confirm(`tag all ${versioned.repos.length} repos as ${next}, release them and push?`)))
    throw new Error('aborted');

  const [one = [], two = []] = phasesOf(versioned);
  try {
    await releasePhase(ctx, versioned, one, next, today);
    await awaitPublished(ctx, next, wait);
    await releasePhase(ctx, versioned, two, next, today);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\n✗ ship stopped during the release; re-run with --to ${next} to finish it (tagged repos and existing releases are skipped)`,
    );
  }
}

/** A repo never tagged lists its whole history as pending; this many lines of it are shown. */
const PENDING_SHOWN = 20;

/** One phase: the bookkeeping of its repos, then each tagged, pushed and released. */
async function releasePhase(ctx: Context, versioned: Versioned, repos: VersionedRepo[], next: string, today: string) {
  ctx.say(`→ phase: ${repos.map((r) => r.name).join(', ')}`);
  await ctx.apply((await planBookkeeping(ctx, versioned, repos, next, today)).plan);
  for (const repo of repos) await tagAndRelease(ctx, repo, next);
}

async function tagAndRelease(ctx: Context, repo: VersionedRepo, next: string): Promise<void> {
  const tagged = await ctx
    .read('git', ['rev-parse', '-q', '--verify', `refs/tags/${next}`], { cwd: repo.path })
    .then(() => true)
    .catch(() => false);
  if (tagged) ctx.say(`• ${repo.name}: already tagged ${next}`);
  else await ctx.apply([run('git', ['tag', '-a', next, '-m', `Plexus ${next}`], { cwd: repo.path })]);
  await ctx.apply([run('git', ['push', 'origin', 'main', next], { cwd: repo.path })]);

  // The GitHub release is what makes the tag immutable, and on tooling it
  // is what triggers the publish: nothing is ever published from a tag that
  // can still move. --verify-tag refuses to create a tag of its own.
  const released = await ctx
    .read('gh', ['release', 'view', next], { cwd: repo.path })
    .then(() => true)
    .catch(() => false);
  if (released) {
    ctx.say(`• ${repo.name}: release ${next} exists`);
    return;
  }
  const notes = await releaseNotes(ctx, repo, next, tagged || !ctx.dryRun ? next : 'HEAD');
  await ctx.apply([
    run('gh', ['release', 'create', next, '--verify-tag', '--title', next, '--notes', notes], { cwd: repo.path }),
  ]);
  if (ctx.dryRun) return;
  const immutable = (
    await ctx.read('gh', ['api', `repos/{owner}/{repo}/releases/tags/${next}`, '--jq', '.immutable'], {
      cwd: repo.path,
    })
  ).trim();
  if (immutable !== 'true')
    throw new Error(mutableRelease(`${repo.name}: release ${next} was created mutable, and its tag can still move`));
}

/**
 * What the version concerns in a repo: the subjects of its commits since the
 * previous version tag, oldest first, up to `ref` (the tag, or HEAD in a
 * preview, where the tag is not made). GitHub's generated notes list merged
 * pull requests only, and the versioned repos are committed to on main.
 */
async function releaseNotes(ctx: Context, repo: VersionedRepo, next: string, ref: string): Promise<string> {
  const tags = (await ctx.read('git', ['tag', '--list', 'v*', '[0-9]*'], { cwd: repo.path })).split('\n');
  const previous = latestTag(tags.filter((t) => t && compareVersions(t.replace(/^v/, ''), next) < 0));
  const range = previous ? `${previous}..${ref}` : ref;
  const subjects = (await ctx.read('git', ['log', '--reverse', '--format=%s', range], { cwd: repo.path }))
    .split('\n')
    .filter(Boolean);
  const since = previous ? `since ${previous.replace(/^v/, '')}` : 'in the first version';
  return [`Plexus ${next}: the commits ${since}.`, '', ...subjects.map((s) => `- ${codeSpan(s)}`)].join('\n');
}

/**
 * A commit subject as a Markdown code span, so that nothing in it is live on
 * the forge: no `@scope/package` mention, no `#` heading or reference, no
 * emphasis or link. The fence is one backtick longer than the longest run in
 * the subject, padded with a space where the subject begins or ends with one.
 */
export function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Between the phases: tooling's release workflow publishes the three
 * Plexus-versioned packages, and phase two pins them. Polled with the same
 * question an operator would ask (`npm view <name>@<version> version`); the dry
 * run names the wait and moves on.
 */
async function awaitPublished(ctx: Context, next: string, wait: PublishWait): Promise<void> {
  const names: string[] = VERSIONED_PACKAGES.map((p) => p.name);
  const list = names.map((n) => `${n}@${next}`).join(', ');
  if (ctx.dryRun) {
    ctx.say(`⏳ [dry-run] would wait for ${list} on npm (the release workflow of ${TOOLING} publishes them)`);
    return;
  }
  ctx.say(`⏳ waiting for ${list} on npm (the release workflow of ${TOOLING} publishes them)`);
  const started = Date.now();
  let missing = [...names];
  for (;;) {
    const still: string[] = [];
    for (const name of missing) {
      // --prefer-online: npm otherwise answers from a packument it cached up to five minutes ago.
      const seen = (
        await ctx.read('npm', ['view', `${name}@${next}`, 'version', '--prefer-online']).catch(() => '')
      ).trim();
      if (seen !== next) still.push(name);
    }
    missing = still;
    if (missing.length === 0) break;
    if (Date.now() - started >= wait.timeout)
      throw new Error(
        `${missing.join(', ')} not on npm at ${next} after ${Math.round(wait.timeout / 60_000)} min — check the release workflow (gh run list -R plexus-ms/${TOOLING})`,
      );
    await new Promise((resolve) => setTimeout(resolve, wait.interval));
  }
  ctx.say(`  ✓ ${list} on npm`);
}

/** A bookkeeping write a repo already tagged with the version would have taken. */
interface AfterTag {
  repo: string;
  rel: string;
  what: string;
}

/**
 * The bookkeeping writes of the given repos, then one commit per repo that has
 * any. A repo already tagged with the version takes none: what it would have
 * written is returned instead (preflightAfterTag refuses it). `quiet` plans
 * without narrating, for the preflight.
 */
async function planBookkeeping(
  ctx: Context,
  versioned: Versioned,
  repos: VersionedRepo[],
  next: string,
  today: string,
  { quiet = false } = {},
): Promise<{ plan: Plan; afterTag: AfterTag[] }> {
  const plan: Plan = [];
  const afterTag: AfterTag[] = [];
  const touched = new Set<VersionedRepo>();
  const repo = (name: string): VersionedRepo | undefined => repos.find((r) => r.name === name);
  /** Plan a write when the transform changes the file, saying what it does; a missing file is left alone. */
  const edit = async (
    r: VersionedRepo,
    rel: string,
    what: string,
    transform: (text: string) => string,
  ): Promise<void> => {
    const path = join(r.path, rel);
    const text = await ctx.readFile(path).catch(() => undefined);
    if (text === undefined) return;
    const edited = transform(text);
    if (edited === text) return;
    if (r.latest === next) {
      afterTag.push({ repo: r.name, rel, what });
      return;
    }
    if (!quiet) ctx.say(`  ${r.name}: ${rel}: ${what}`);
    plan.push(write(path, edited));
    touched.add(r);
  };
  /** The tracked files of a repo containing a string, by pathspec. */
  const grep = async (r: VersionedRepo, needle: string, pathspecs: string[]): Promise<string[]> =>
    (await ctx.read('git', ['grep', '-l', needle, '--', ...pathspecs], { cwd: r.path }).catch(() => ''))
      .split('\n')
      .filter(Boolean);

  const tooling = repo(TOOLING);
  if (tooling) {
    for (const c of COLLECTIONS)
      await edit(tooling, galaxyFile(c), `plexus.${c} version → ${next}`, (t) => bumpGalaxyVersion(t, next));
    await edit(tooling, RUNNER_IMAGE_PIN_FILE, `runner image → ${next}`, (t) => bumpRunnerImagePin(t, next));
    for (const p of VERSIONED_PACKAGES)
      await edit(tooling, `${p.dir}/package.json`, `${p.name} → ${next}`, (t) => bumpManifestVersion(t, next));
    // The citable index the packages carry (standardIndex.ts), read from the
    // compendium's main, which phase two tags with only stamps added: what a
    // tenant's citations resolve against under the plx it pins. Once tooling is
    // tagged it is not written again (preflightIndex holds the two together).
    const compendium = versioned.repos.find((r) => r.name === COMPENDIUM);
    if (compendium && tooling.latest !== next) {
      const index = renderStandardIndex({ version: next, citable: await readCitable(ctx, compendium.path) });
      await edit(tooling, STANDARD_INDEX_FILE, `citable index → the compendium at ${next}`, () => index);
    }
  }
  // Only the pins of the plexus.* collections: a collection from elsewhere in the same file stays untouched.
  const operationsTemplate = repo('template-repo-operations');
  if (operationsTemplate)
    await edit(operationsTemplate, 'template/requirements.yml', `plexus.* pins → ${next}`, (t) =>
      bumpCollectionPin(t, next),
    );
  for (const r of repos) {
    for (const f of await grep(r, WORKFLOW_REF, ['*.yml', '*.yaml', '*.jinja']))
      await edit(r, f, `workflow refs → @${next}`, (t) => bumpWorkflowRefs(t, next));
    for (const f of await grep(r, PLX_PIN, ['*.toml', '*.toml.jinja']))
      await edit(r, f, `plx pin → ${next}`, (t) => bumpPlxPin(t, next));
  }

  // The map carries the Plexus version and the date it was cut (§ 1.5 PLX).
  // The date is the day the version was first stamped: a re-run on a later
  // day leaves a map that already carries the version alone.
  const comp = repo(COMPENDIUM);
  if (comp)
    await edit(comp, MAP_PAGE, `version → ${next}, timestamp → ${today}`, (t) =>
      frontmatterField(t, 'version') === next ? t : stampStandard(t, next, today),
    );

  for (const r of versioned.repos) {
    if (!touched.has(r)) continue;
    plan.push(run('git', ['add', '-A'], { cwd: r.path }));
    plan.push(run('git', ['commit', '--quiet', '-m', `chore: Plexus ${next} bookkeeping`], { cwd: r.path }));
  }
  return { plan, afterTag };
}
