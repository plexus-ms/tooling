// Display versions: the string each app of an app repo shows as its version,
// and the version tag a production release cuts. Opt-in per repo, through
// the release workflow's `display-versions` input; a repo that does not ask
// for them meets none of this.
//
// A version is `MAJOR.MINOR`, a git tag with no prefix, one per repo. The
// tags are the only state: nothing else is stored, and every number is read
// back from git and the forge's registry.
//
//   production   the next version when an app changed: an app has changed
//                when its published image (`<prefix>/<app>:<sha>`) is not
//                the one published under the last version's commit. The next
//                version is the last one's minor plus one, or `<major>.0`
//                when the marker's `major` is above the last one's. A changed
//                app shows the new version; an unchanged one shows the oldest
//                version in the unbroken run of versions with its image, the
//                version it was first released in. Nothing changed, no version.
//   elsewhere    the last version in the commit's history and the short sha,
//                `1.4+a1b2c3d`, or the short sha alone before the first
//                version; no version is cut.
//
// The marker's `major` (PLEXUS.md frontmatter) is the human's decision; the
// minor counts up by itself. The tag itself, with its GitHub Release, is
// made by `tagDisplayVersion` once every deploy of the release is green.
import { type Context, MARKER_FILE, splitFrontmatter, UsageError } from '@plexus-ms/lib';
import { craneDigest, imageName } from './registry.ts';

/** The environment whose releases cut versions. */
export const PRODUCTION = 'production';

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
  if (typeof major !== 'number' || !Number.isInteger(major) || major < 0)
    throw new UsageError(`${MARKER_FILE}: major must be a whole number, not ${JSON.stringify(major)}`);
  return major;
}

/** The version tags in the history of `sha`, newest first. */
export async function versionsIn(ctx: Context, dir: string, sha: string): Promise<Version[]> {
  const out = await ctx.read('git', ['tag', '--merged', sha], { cwd: dir });
  return versionsOf(out.split('\n'));
}

const commitOf = async (ctx: Context, dir: string, tag: string): Promise<string> =>
  (await ctx.read('git', ['rev-parse', `${tag}^{commit}`], { cwd: dir })).trim();

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
  const base = { environment, ...(last ? { previous: last.tag } : {}) };

  if (environment !== PRODUCTION) {
    const short = (await ctx.read('git', ['rev-parse', '--short=7', sha], { cwd: dir })).trim();
    const shown = last ? `${last.tag}+${short}` : short;
    return { ...base, version: '', apps: Object.fromEntries(apps.map((app) => [app, shown])) };
  }

  // Each version's commit and each app's image under it, looked up once and
  // only as far back as an app's image stays the same.
  const commits = new Map<string, string>();
  const commit = async (v: Version): Promise<string> => {
    let c = commits.get(v.tag);
    if (c === undefined) {
      c = await commitOf(ctx, dir, v.tag);
      commits.set(v.tag, c);
    }
    return c;
  };
  const since: Record<string, string | undefined> = {};
  for (const app of apps) {
    const image = imageName(prefix, app);
    const current = await craneDigest(ctx, `${image}:${sha}`);
    if (current === undefined && !ctx.dryRun) throw new Error(`${image}:${sha} is not published; publish runs first`);
    let first: string | undefined;
    for (const v of versions) {
      if ((await craneDigest(ctx, `${image}:${await commit(v)}`)) !== current) break;
      first = v.tag;
    }
    // Unchanged when the last version had this image (the walk starts at
    // it), and then shown as the version it was first released in.
    since[app] = first;
    ctx.say(`${app}: ${since[app] === undefined ? 'changed since the last version' : `unchanged since ${since[app]}`}`);
  }
  const changed = apps.filter((app) => since[app] === undefined);
  const version = changed.length > 0 ? nextVersion(last, await majorOf(ctx, dir)) : '';
  if (version) ctx.say(`production changed: ${changed.join(', ')}; the release cuts ${version}`);
  else ctx.say(`production is unchanged since ${last?.tag ?? 'ever'}; the release cuts no version`);
  return {
    ...base,
    version,
    apps: Object.fromEntries(apps.map((app) => [app, since[app] ?? version])),
  };
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
