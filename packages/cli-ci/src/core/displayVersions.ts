// Display versions (PLX-Releases): the string each app of an app repo shows as
// its version, and the version tag a production release cuts. Opt-in per
// repo, through the release workflow's `display-versions` input; a repo that
// does not ask for them meets none of this. The commit an app is started
// from is handed over beside it, by the workflow itself, to every app repo.
//
// A version is `MAJOR.MINOR`, a git tag with no prefix, one per repo. The
// tags are the only state: nothing else is stored, and every number is read
// back from git and the forge's registry.
//
// A display version is a version, bare or with a `+`, and nothing else: no
// `v`, which is the app's to add, and no commit, which is its own value.
//
//   1.4     the commit released carries the tag 1.4, or is about to: a
//           production release cuts 1.4 with it.
//   1.4+    the commit deviates from 1.4, the last version in its history.
//   0.0+    before the first version.
//
// A production release cuts the next version when an app changed: an app
// has changed when its published image (`<prefix>/<app>:<sha>`) is not the
// one published under the last version's commit. The next version is the
// last one's minor plus one, or `<major>.0` when the marker's `major` is
// above the last one's. No other environment ever cuts a version.
//
// Three cases follow from that and are meant:
//
//   - Staging shows `1.4+` for a commit that production then releases as
//     1.5, and goes on showing it: its string was pinned before the tag was
//     there, and no release touches another environment. The commit sha the
//     two show is the same.
//   - Production shows `1.4+` after a release that changes an app's run
//     shape and no image: no version is cut, and the app restarts at a commit
//     that carries no tag.
//   - An app whose image is already live keeps the display version and the
//     commit sha it shows: the deploy verb restarts nothing for either alone
//     (§ 6 PLX-Delivery), so in a repo of several apps an unchanged one goes
//     on showing the version it was released in.
//
// The marker's `major` (PLEXUS.md frontmatter) is the human's decision, 1 or
// higher, so that `0.0+` only ever means "before the first version"; the
// minor counts up by itself. It is read on every run, in every environment,
// so that a repo that turns display versions on without one fails at its
// first push and not at its first production release. The tag itself, with
// its GitHub Release, is made by `tagDisplayVersion` once every deploy of the
// release is green.
import { type Context, MARKER_FILE, splitFrontmatter, UsageError } from '@plexus-ms/lib';
import { craneDigest, imageName } from './registry.ts';

/** The environment whose releases cut versions. */
export const PRODUCTION = 'production';

/** The display version before the first version. */
export const UNRELEASED = '0.0+';

export interface Version {
  tag: string;
  major: number;
  minor: number;
}

const VERSION_TAG = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** A version tag, `MAJOR.MINOR`, or undefined for any other tag. */
export function parseVersion(tag: string): Version | undefined {
  const m = VERSION_TAG.exec(tag.trim());
  return m ? { tag: tag.trim(), major: Number(m[1]), minor: Number(m[2]) } : undefined;
}

/** The version tags among `tags`, newest first. */
export function versionsOf(tags: string[]): Version[] {
  return tags
    .map(parseVersion)
    .filter((v): v is Version => v !== undefined)
    .sort((a, b) => b.major - a.major || b.minor - a.minor);
}

/** The version after `last`, on the marker's `major`; a major never goes back. */
export function nextVersion(last: Version | undefined, major: number): string {
  if (!last) return `${major}.0`;
  if (major < last.major)
    throw new UsageError(
      `${MARKER_FILE} says major: ${major}, below the last version ${last.tag}; a major never goes back`,
    );
  return major > last.major ? `${major}.0` : `${last.major}.${last.minor + 1}`;
}

/** The `major` the repo's marker states; a repo that asks for display versions states one. */
export async function majorOf(ctx: Context, dir: string): Promise<number> {
  const { data } = splitFrontmatter(await ctx.readFile(`${dir}/${MARKER_FILE}`));
  const major = data.major;
  if (major === undefined)
    throw new UsageError(
      `${MARKER_FILE} states no major; a repo with display versions sets \`major:\` in its frontmatter`,
    );
  if (typeof major !== 'number' || !Number.isInteger(major) || major < 1)
    throw new UsageError(`${MARKER_FILE}: major must be a whole number, 1 or higher, not ${JSON.stringify(major)}`);
  return major;
}

/** The version tags in the history of `sha`, newest first. */
export async function versionsIn(ctx: Context, dir: string, sha: string): Promise<Version[]> {
  const out = await ctx.read('git', ['tag', '--merged', sha], { cwd: dir });
  return versionsOf(out.split('\n'));
}

/** The commit a tag or a hash names, as a full hash. */
const commitOf = async (ctx: Context, dir: string, rev: string): Promise<string> =>
  (await ctx.read('git', ['rev-parse', `${rev}^{commit}`], { cwd: dir })).trim();

export interface DisplayVersions {
  environment: string;
  /** The version a production release cuts, empty when it cuts none. */
  version: string;
  /** The last version in the history of the commit, if any. */
  previous?: string;
  /** Per app, the string it shows. */
  apps: Record<string, string>;
}

export interface DisplayVersionsOptions {
  /** The checkout, with its tags and enough history to see them. */
  dir: string;
  environment: string;
  sha: string;
  /** The apps the release deploys. */
  apps: string[];
  /** Where the published images live, `ghcr.io/<owner>`. */
  prefix: string;
}

export async function displayVersions(ctx: Context, options: DisplayVersionsOptions): Promise<DisplayVersions> {
  const { dir, environment, sha, apps, prefix } = options;
  const versions = await versionsIn(ctx, dir, sha);
  const last = versions[0];
  // On every run: a marker without a usable major fails here, whatever the environment.
  const next = nextVersion(last, await majorOf(ctx, dir));
  const lastCommit = last ? await commitOf(ctx, dir, last.tag) : undefined;
  // What the commit shows where no version is cut with it: its own tag, or a deviation from the last one.
  const uncut = !last ? UNRELEASED : lastCommit === (await commitOf(ctx, dir, sha)) ? last.tag : `${last.tag}+`;
  const result = (version: string): DisplayVersions => ({
    environment,
    ...(last ? { previous: last.tag } : {}),
    version,
    apps: Object.fromEntries(apps.map((app) => [app, version || uncut])),
  });
  if (environment !== PRODUCTION) return result('');

  const changed: string[] = [];
  for (const app of apps) {
    const image = imageName(prefix, app);
    const current = await craneDigest(ctx, `${image}:${sha}`);
    if (current === undefined && !ctx.dryRun) throw new Error(`${image}:${sha} is not published; publish runs first`);
    const before = lastCommit ? await craneDigest(ctx, `${image}:${lastCommit}`) : undefined;
    const same = before !== undefined && before === current;
    ctx.say(`${app}: ${same ? `unchanged since ${last?.tag}` : 'changed since the last version'}`);
    if (!same) changed.push(app);
  }
  if (changed.length > 0) ctx.say(`production changed: ${changed.join(', ')}; the release cuts ${next}`);
  else ctx.say(`production is unchanged since ${last?.tag}; the release cuts no version`);
  return result(changed.length > 0 ? next : '');
}

/** The release notes of `version`: the subjects of the commits since the previous version, merges left out. */
export async function notesOf(ctx: Context, dir: string, sha: string, previous: string | undefined): Promise<string> {
  if (!previous) return 'The first version.';
  const out = await ctx.read('git', ['log', '--no-merges', '--format=%s', `${previous}..${sha}`], { cwd: dir });
  const subjects = out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return subjects.length > 0 ? subjects.map((s) => `- ${s}`).join('\n') : `No commits since ${previous}.`;
}

export interface TagOptions {
  dir: string;
  /** `owner/name`. */
  repo: string;
  token: string;
  version: string;
  sha: string;
}

export interface Tagged {
  version: string;
  sha: string;
  /** The version was tagged at this commit already, by an earlier attempt. */
  existed: boolean;
}

/**
 * Tag `version` at `sha` with a GitHub Release whose notes list the commits
 * since the previous version. A re-run finds its tag and is done; a tag of
 * that name at another commit is an error, never moved.
 */
export async function tagDisplayVersion(ctx: Context, options: TagOptions): Promise<Tagged> {
  const { dir, repo, token, version, sha } = options;
  if (!parseVersion(version)) throw new UsageError(`${version} is not a version, MAJOR.MINOR`);
  const there = await ctx
    .read('git', ['rev-parse', '-q', '--verify', `refs/tags/${version}^{commit}`], { cwd: dir })
    .then((s) => s.trim())
    .catch(() => undefined);
  if (there !== undefined) {
    if (there !== sha)
      throw new Error(`${version} is tagged at ${there} already, not at ${sha}; a version never moves`);
    ctx.done(`${version} is tagged at ${sha} already`);
    return { version, sha, existed: true };
  }
  const previous = (await versionsIn(ctx, dir, sha)).find((v) => v.tag !== version)?.tag;
  const body = await notesOf(ctx, dir, sha, previous);
  const config = [
    `url = "https://api.github.com/repos/${repo}/releases"`,
    'request = "POST"',
    'fail-with-body',
    'silent',
    'show-error',
    `header = "Authorization: Bearer ${token}"`,
    'header = "Accept: application/vnd.github+json"',
    'header = "X-GitHub-Api-Version: 2022-11-28"',
    `data = ${JSON.stringify(JSON.stringify({ tag_name: version, target_commitish: sha, name: version, body }))}`,
  ];
  ctx.say(`${ctx.dryRun ? '[dry-run] ' : ''}release ${version} at ${sha}${previous ? `, since ${previous}` : ''}:`);
  ctx.say(body.replace(/^/gm, '  '));
  // A read, not an effect: an effect echoes its input under -v, and the
  // input carries the token. Under --dry-run nothing is sent.
  if (!ctx.dryRun) await ctx.read('curl', ['-K', '-'], { input: `${config.join('\n')}\n` });
  ctx.done(`${version} is tagged at ${sha}`);
  return { version, sha, existed: false };
}
