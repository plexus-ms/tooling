// The Plexus version (§ 1.5 PLX): one number, tagged identically on every versioned repo
// whether or not it changed. This file reads the version's state from the
// upstream umbrella (the `plexus-ms` directory of a workspace) and decides the
// next version; `ship` acts on it. The versioned repos, the version shape and the
// forge's preflight are @plexus-ms/lib's, shared with the repos that take it.
import { join } from 'node:path';
import { type Context, compareVersions, isPlexusVersion, UsageError, VERSIONED_REPOS } from '@plexus-ms/lib';

/** The repo whose tag publishes the Plexus-versioned packages; it is released first. */
export const TOOLING = 'tooling';

/**
 * The version is cut in two phases: `tooling` alone, whose release publishes
 * the Plexus-versioned packages, then every other repo once those packages are
 * on npm, because the templates and the compendium pin them at the Plexus version
 * and their commit hooks install the pin.
 */
export const PHASES: readonly (readonly string[])[] = [[TOOLING], VERSIONED_REPOS.filter((r) => r !== TOOLING)];

/** The packages published at the Plexus version from `tooling` (§ 1.6 PLX), by their directory there. */
export const VERSIONED_PACKAGES = [
  { name: '@plexus-ms/cli', dir: 'packages/cli' },
  { name: '@plexus-ms/cli-ci', dir: 'packages/cli-ci' },
  { name: '@plexus-ms/lib', dir: 'packages/lib' },
] as const;

/** The umbrella directory holding the versioned repos, relative to the workspace. */
export const UPSTREAM = 'plexus-ms';

export function nextMinor(version: string): string {
  const [major = '0', minor = '0'] = version.split('.');
  return `${major}.${Number(minor) + 1}.0`;
}

/**
 * The newest version tag of a repo across both eras (`v0.21` and `0.22.0`),
 * compared numerically on the v-stripped form: a plain version sort would rank
 * every v-tag above every plain tag. A prerelease tag (`0.100.0-rc.1`, a
 * publishing rehearsal) is not a version and never the latest.
 */
export function latestTag(tags: string[]): string | undefined {
  return tags
    .filter((t) => /^v?\d+(\.\d+){1,2}$/.test(t))
    .sort((a, b) => compareVersions(a.replace(/^v/, ''), b.replace(/^v/, '')))
    .at(-1);
}

export interface VersionedRepo {
  name: string;
  path: string;
  /** The latest tag as git has it; undefined for a repo never tagged. */
  tag?: string;
  /** The same, v-stripped: the Plexus version it names. */
  latest?: string;
  /** `git log --oneline` since the latest tag. */
  pending: string[];
}

export interface Versioned {
  repos: VersionedRepo[];
  /** The highest tag across all repos, v-stripped. */
  last?: string;
  /** True when the repos' latest tags disagree: a run that stopped mid-tag. */
  skew: boolean;
}

/** Fetch every versioned repo and read its tags and pending commits. */
export async function readVersioned(ctx: Context, upstream: string): Promise<Versioned> {
  const repos: VersionedRepo[] = [];
  const all = new Set<string>();
  for (const name of VERSIONED_REPOS) {
    const path = join(upstream, name);
    try {
      await ctx.read('git', ['rev-parse', '--git-dir'], { cwd: path });
    } catch {
      throw new Error(`${path} is not a git repo`);
    }
    try {
      await ctx.read('git', ['fetch', 'origin', '--tags', '--quiet'], { cwd: path });
    } catch {
      throw new Error(`${name}: fetch from origin failed`);
    }
    const tags = (await ctx.read('git', ['tag', '--list', 'v*', '[0-9]*'], { cwd: path })).split('\n').filter(Boolean);
    for (const t of tags) all.add(t.replace(/^v/, ''));
    const tag = latestTag(tags);
    const range = tag ? `${tag}..HEAD` : 'HEAD';
    const pending = (await ctx.read('git', ['log', '--oneline', range], { cwd: path })).split('\n').filter(Boolean);
    repos.push({ name, path, tag, latest: tag?.replace(/^v/, ''), pending });
  }
  const latest = repos.map((r) => r.latest);
  return { repos, last: latestTag([...all]), skew: latest.some((l) => l !== latest[0]) };
}

/** The version's repos in release order, grouped by phase. */
export const phasesOf = (versioned: Versioned): VersionedRepo[][] =>
  PHASES.map((names) => versioned.repos.filter((r) => names.includes(r.name)));

/** Every versioned repo on main, clean, and not behind origin; throws naming the first offender. */
export async function preflightRelease(ctx: Context, versioned: Versioned): Promise<void> {
  for (const { name, path } of versioned.repos) {
    const branch = (await ctx.read('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path })).trim();
    if (branch !== 'main') throw new Error(`${name} is on '${branch}', a version is cut from main`);
    if ((await ctx.read('git', ['status', '--porcelain'], { cwd: path })).trim() !== '')
      throw new Error(`${name} has uncommitted changes — commit first`);
    const behind = (await ctx.read('git', ['rev-list', '--count', 'main..origin/main'], { cwd: path })).trim();
    if (behind !== '0')
      throw new Error(
        `${name} is ${behind} commit(s) behind origin/main — pull first, or the tag lands on a stale commit`,
      );
  }
}

/**
 * The version a run releases: the explicit one, or the next minor, refusing to
 * derive one while the repos' tags disagree.
 */
export function resolveVersion(versioned: Versioned, explicit: string | undefined): string {
  if (explicit !== undefined && !isPlexusVersion(explicit))
    throw new UsageError(`'${explicit}' is not plain semver (X.Y.Z, no v)`);
  if (explicit) return explicit;
  if (versioned.skew) {
    const report = versioned.repos.map((r) => `  ${r.name}: ${r.latest ?? 'none'}`).join('\n');
    throw new Error(
      `the versioned repos' latest tags disagree:\n${report}\npass the version explicitly (--to ${versioned.last}) to finish the half-tagged version, or a higher one to start a new one`,
    );
  }
  return versioned.last ? nextMinor(versioned.last) : '0.1.0';
}
