// pull: the version's pull request (§ 3 PLX-Updates), on `plexus/<version>`
// against the branch the version lands on. take.ts opens it; a later run
// that finds the branch on origin with the pull request open comes back to it
// here (`revisit`).
//
// A pull request that needs a hand is a draft, and its body opens with what
// needs it: the sites that conflicted, the tracked files that hold conflict
// markers (conflicts.ts), the sites whose copier run failed, and, when the
// lockfile did not refresh, that `pnpm install` is to be run after resolving.
// One that needs none is ready for review.
//
// The branch is never moved by any run, and plx never pushes to it again: it
// is the human's from the moment it is on origin. A later run, scheduled or
// manual, reads it as origin has it (a fetch into the remote-tracking ref; no
// checkout is touched), runs the detector over its tracked files, writes the
// body afresh for that present state (it never reads the body), and marks the pull request ready when no marker
// remains, or a draft again while one does. It does not check the lockfile:
// that is the human's, and the repo's CI catches a stale one. Whether the pull
// request is ready to merge is read from its draft state and the detector,
// never from its body.
//
// The review is requested once, when plx opens the pull request, draft or
// not, from the users the repo's root answers name (`pr_reviewers`, a
// comma-separated string of GitHub user logins, empty or absent for none), or
// those `--reviewer` names instead; nothing more when it is marked ready.
// Users only: a team is refused.
import { relative } from 'node:path';
import { filesWithConflictMarkers } from './conflicts.ts';
import type { Consumer } from './consumers.ts';
import type { Context } from './context.ts';
import { run } from './effects.ts';
import { detailOf } from './io.ts';

export const versionBranch = (version: string): string => `plexus/${version}`;

/** The answer of the repo templates that names who reviews the version's pull requests. */
export const REVIEWERS_ANSWER = 'pr_reviewers';

/**
 * The user logins a comma-separated value names, in order, once each; blank
 * for none. plx takes letters, digits and hyphens; a team (`org/team`) and
 * anything else is refused, naming where it came from.
 */
export function parseReviewers(value: string, what: string): string[] {
  const logins = value
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const login of logins) {
    if (login.includes('/')) throw new Error(`${what} names \`${login}\`, a team; only users are requested`);
    if (!/^[A-Za-z0-9-]+$/.test(login)) throw new Error(`${what} names \`${login}\`, not a GitHub user login`);
  }
  return [...new Set(logins)];
}

/** The reviewers a repo's root answers name; none when they name none. */
export function reviewersOf(answers: Record<string, unknown>): string[] {
  const value = answers[REVIEWERS_ANSWER];
  if (value === undefined || value === null) return [];
  return parseReviewers(String(value), `the answer ${REVIEWERS_ANSWER}`);
}

/** The request for reviews from users on a pull request, by its number, in the repo `cwd` belongs to. */
export const requestReviews = (number: number, logins: string[], cwd: string) =>
  run(
    'gh',
    [
      'api',
      `repos/{owner}/{repo}/pulls/${number}/requested_reviewers`,
      '--method',
      'POST',
      ...logins.flatMap((l) => ['-f', `reviewers[]=${l}`]),
    ],
    { cwd },
  );

/** An open pull request as the forge lists it. */
export interface OpenPull {
  url: string;
  number: number;
  draft: boolean;
}

/** The open pull request from the version branch against the consumer's branch, if any. */
export async function openPullOf(
  ctx: Context,
  consumer: Consumer,
  dir: string,
  version: string,
): Promise<OpenPull | undefined> {
  const args = ['pr', 'list', '--head', versionBranch(version), '--base', consumer.branch, '--state', 'open'];
  const out = await ctx.read('gh', [...args, '--json', 'url,number,isDraft'], { cwd: dir }).catch(() => '');
  let listed: unknown;
  try {
    listed = JSON.parse(out || '[]');
  } catch {
    return undefined;
  }
  const first: unknown = Array.isArray(listed) ? listed[0] : undefined;
  if (typeof first !== 'object' || first === null) return undefined;
  const { url, number, isDraft } = first as Record<string, unknown>;
  if (typeof url !== 'string' || typeof number !== 'number') return undefined;
  return { url, number, draft: isDraft === true };
}

/** What a pull request's body says, as data. */
export interface PullState {
  version: string;
  /** The sites, relative to the repo (`.` for its root). */
  sites: string[];
  /** Sites where copier left a conflict. */
  conflicted?: string[];
  /** Tracked files that hold a conflict marker, relative to the repo. */
  marked: string[];
  /** Sites whose copier run failed, left as they were. */
  failed?: string[];
  /** The lockfile refresh failed. */
  lockfile?: boolean;
  /** The last line: who opened it and why, or that a later run rewrote it. */
  note: string;
}

/** Whether anything in the state needs a hand. */
export const needsAHand = (p: PullState): boolean =>
  (p.conflicted?.length ?? 0) > 0 || p.marked.length > 0 || (p.failed?.length ?? 0) > 0 || p.lockfile === true;

const code = (s: string) => `\`${s}\``;
const site = (s: string) => (s === '.' ? 'the root' : code(s));

/** The body: what needs a hand first, then what the pull request is. */
export function pullBody(p: PullState): string {
  const hand = [
    ...(p.conflicted?.length
      ? [`- Conflicts at ${p.conflicted.map(site).join(', ')}, committed with their markers.`]
      : []),
    ...(p.marked.length ? [`- Files that hold conflict markers: ${p.marked.map(code).join(', ')}.`] : []),
    ...(p.failed?.length
      ? [`- \`copier update\` failed at ${p.failed.map(site).join(', ')}, left as it was; run it there by hand.`]
      : []),
    ...(p.lockfile
      ? ['- The lockfile did not refresh: run `pnpm install` after resolving, and commit the lockfile.']
      : []),
  ];
  const head =
    hand.length > 0
      ? [
          `**Needs a hand.** This pull request is a draft; \`plx update\` marks it ready once no tracked file holds a conflict marker.\n\n${hand.join('\n')}`,
        ]
      : ['Nothing needs a hand: every site merged clean.'];
  return [
    ...head,
    `Plexus ${p.version} (§ 1.5 PLX): \`copier update\` at ${p.sites.map(site).join(', ')}, the lockfile where manifests moved, and the workflow refs.`,
    p.note,
  ].join('\n\n');
}

/** The last line of a body a later run rewrote. */
const REVISITED = 'Opened by `plx update`; rewritten by a later run to what still needs a hand.';

/** What a later run found of a pull request on origin, and did to it. */
export interface Revisited {
  url: string;
  /** Tracked files of the branch that hold a conflict marker. */
  marked: string[];
  /** Ready to merge once its checks pass: no longer a draft, and no marker left. */
  mergeable: boolean;
  /** Why the rewrite or the change of state failed, when one did. */
  failed?: string;
}

/**
 * A later run over the version's pull request, open on origin: the branch
 * read as origin has it, the detector over it, the body rewritten to the
 * present state, ready or draft by the markers. Under a dry run it changes
 * nothing and says what it would do.
 */
export async function revisit(ctx: Context, consumer: Consumer, pull: OpenPull, version: string): Promise<Revisited> {
  const { path: repo, rel: name } = consumer;
  const branch = versionBranch(version);
  const tracking = `origin/${branch}`;
  await ctx.read('git', ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/${tracking}`], {
    cwd: repo,
  });
  const marked = await filesWithConflictMarkers(ctx, repo, tracking);
  const ready = marked.length === 0;
  const sites = consumer.sites.map((s) => relative(consumer.path, s.path) || '.');
  const body = pullBody({ version, sites, marked, note: REVISITED });
  ctx.say(
    ready
      ? `• ${name}: ${branch} is on origin (${pull.url}); no conflict marker remains${pull.draft ? ' — ready for review' : ''}`
      : `• ${name}: ${branch} is on origin (${pull.url}); ${marked.length} file${marked.length === 1 ? '' : 's'} still hold${marked.length === 1 ? 's' : ''} conflict markers${pull.draft ? '' : ' — a draft again'}`,
  );
  // The body is written, never read: what it says decides nothing.
  const steps = [
    run('gh', ['api', `repos/{owner}/{repo}/pulls/${pull.number}`, '--method', 'PATCH', '-f', `body=${body}`], {
      cwd: repo,
    }),
    ...(ready && pull.draft ? [run('gh', ['pr', 'ready', pull.url], { cwd: repo })] : []),
    ...(!ready && !pull.draft ? [run('gh', ['pr', 'ready', pull.url, '--undo'], { cwd: repo })] : []),
  ];
  try {
    await ctx.apply(steps);
  } catch (error) {
    return { url: pull.url, marked, mergeable: false, failed: `pull request ${pull.url}: ${detailOf(error)}` };
  }
  // A dry run left the state as it was.
  const draft = ctx.dryRun ? pull.draft : !ready;
  return { url: pull.url, marked, mergeable: ready && !draft };
}
