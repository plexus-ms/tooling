// ship: the Plexus version (§ 1.5 PLX). Every versioned repo ships under ONE
// version, tagged identically whether or not it changed, in two phases:
//
//   preflight (every versioned repo on main, clean, not behind origin, the latest
//   tags in agreement; gh logged in; no mutable release on any versioned repo)
//   → phase one: tooling's bookkeeping (galaxy versions, the Plexus-versioned
//     packages' manifests, its own workflow refs), commit, tag, push, GitHub
//     release — which locks the tag and runs tooling's release workflow
//   → wait until the three packages are on npm at the Plexus version
//   → phase two: the templates' and the compendium's bookkeeping (collection
//     pin, workflow refs, plx pins, the map's version and
//     timestamp, `changed` on every standard module whose requirements moved),
//     commit, tag, push, release, repo by repo; the compendium last, its
//     release created as a draft, given the module manifest (manifest.ts) and
//     only then published, because an immutable release locks its assets
//
// and there it ends. Cutting a version and a repo taking it are separate events
// (§ 3 PLX-Updates): ship looks for no consumer and opens no pull request; a
// repo takes the version itself, when it needs it (update.ts). The dry run is
// the one place consumers still appear: it previews the unreleased templates
// against the workspace's consumers (preview.ts), a maintainer's test.
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
  buildManifest,
  bumpWorkflowRefs,
  COMPENDIUM,
  type Context,
  emptySummary,
  extractRequirements,
  frontmatterField,
  MANIFEST_FILE,
  MAP_PAGE,
  modulePages,
  type Plan,
  preflightForge,
  readCatalog,
  renderManifest,
  run,
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
  PLX_PIN,
  RUNNER_IMAGE_PIN_FILE,
  stampChanged,
  stampStandard,
  today as todayOf,
} from './bookkeeping.ts';
import { previewConsumers } from './preview.ts';
import {
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
  await release(ctx, versioned, next, options.today ?? todayOf(), { ...DEFAULT_WAIT, ...options.wait });
  if (ctx.dryRun) return { ...(await previewConsumers(ctx, options.workspace, next)), released: true };
  ctx.say(`• Plexus ${next} is cut; every repo takes it itself, when it needs it (plx update)`);
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
  await ctx.apply(await planBookkeeping(ctx, versioned, repos, next, today));
  for (const repo of repos) await tagAndRelease(ctx, repo, next, today);
}

async function tagAndRelease(ctx: Context, repo: VersionedRepo, next: string, today: string): Promise<void> {
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
  const create = ['release', 'create', next, '--verify-tag', '--generate-notes', '--title', next];
  if (repo.name === COMPENDIUM) {
    if (!(await releaseWithManifest(ctx, repo, next, today, create))) return;
  } else {
    const released = await ctx
      .read('gh', ['release', 'view', next], { cwd: repo.path })
      .then(() => true)
      .catch(() => false);
    if (released) {
      ctx.say(`• ${repo.name}: release ${next} exists`);
      return;
    }
    await ctx.apply([run('gh', create, { cwd: repo.path })]);
  }
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
 * The compendium's release carries the module manifest, and an immutable
 * release locks its assets: so the release is created as a draft, the manifest
 * uploaded to it, and only then published. Until then the version does not show
 * to a repo asking for the versions (update.ts). A draft left by a run that
 * stopped is taken up where it stands: the manifest uploaded again, then
 * published. Resolves false when the release was published already.
 */
async function releaseWithManifest(
  ctx: Context,
  repo: VersionedRepo,
  next: string,
  today: string,
  create: string[],
): Promise<boolean> {
  const state = (
    await ctx
      .read('gh', ['release', 'view', next, '--json', 'isDraft', '--jq', '.isDraft'], { cwd: repo.path })
      .catch(() => '')
  ).trim();
  if (state === 'false') {
    ctx.say(`• ${repo.name}: release ${next} exists`);
    return false;
  }
  if (state === 'true') ctx.say(`• ${repo.name}: release ${next} is still a draft — finishing it`);
  else await ctx.apply([run('gh', [...create, '--draft'], { cwd: repo.path })]);

  // Written from the checkout the tag was cut from, stamps included; under a
  // dry run the stamps are only announced, so the upload is too.
  const scratch = (await ctx.stage(run('mktemp', ['-d'])))?.trim() ?? '';
  const file = join(scratch, MANIFEST_FILE);
  try {
    const manifest = buildManifest(await readCatalog(ctx, repo.path), next, today);
    ctx.say(`  ${repo.name}: ${MANIFEST_FILE}: Plexus ${next}, ${manifest.modules.length} modules`);
    await ctx.stage(write(file, renderManifest(manifest)));
    await ctx.apply([
      run('gh', ['release', 'upload', next, file, '--clobber'], { cwd: repo.path }),
      run('gh', ['release', 'edit', next, '--draft=false'], { cwd: repo.path }),
    ]);
  } finally {
    if (scratch) await ctx.stage(run('rm', ['-rf', scratch]));
  }
  return true;
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
    ctx.say(`⏳ [dry-run] would wait for ${list} on npm (${TOOLING}' release workflow publishes them)`);
    return;
  }
  ctx.say(`⏳ waiting for ${list} on npm (${TOOLING}' release workflow publishes them)`);
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

/** The bookkeeping writes of the given repos, then one commit per repo that has any. */
async function planBookkeeping(
  ctx: Context,
  versioned: Versioned,
  repos: VersionedRepo[],
  next: string,
  today: string,
): Promise<Plan> {
  const plan: Plan = [];
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
    ctx.say(`  ${r.name}: ${rel}: ${what}`);
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

  // The map carries the Plexus version and the date it was cut (§ 1.5 PLX); a
  // standard module is stamped `changed` when its extracted requirement lines
  // differ from the previous version's, read with the same extractor the
  // compendium's check runs, so the two never disagree.
  const comp = repo('compendium');
  if (comp) {
    await edit(comp, MAP_PAGE, `version → ${next}, timestamp → ${today}`, (t) => stampStandard(t, next, today));
    for (const page of await modulePages(ctx, comp.path)) {
      const text = await ctx.readFile(join(comp.path, page));
      if (frontmatterField(text, 'maturity') !== 'standard') continue;
      const previous = comp.tag
        ? await ctx.read('git', ['show', `${comp.tag}:${page}`], { cwd: comp.path }).catch(() => '')
        : '';
      if (extractRequirements(text).join('\n') === extractRequirements(previous).join('\n')) continue;
      await edit(comp, page, `requirements changed since ${comp.latest ?? 'the beginning'} → changed: ${next}`, (t) =>
        stampChanged(t, next),
      );
    }
  }

  for (const r of versioned.repos) {
    if (!touched.has(r)) continue;
    plan.push(run('git', ['add', '-A'], { cwd: r.path }));
    plan.push(run('git', ['commit', '--quiet', '-m', `chore: Plexus ${next} bookkeeping`], { cwd: r.path }));
  }
  return plan;
}
