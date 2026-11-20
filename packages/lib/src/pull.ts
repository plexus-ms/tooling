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
// is the human's from the moment it is on origin. A later run that finds it
// with no pull request in any state (opening failed after the push) opens
// the pull request then (`openLate`), a draft by the detector, with the
// review request; a closed or merged one is left as it is, a human's
// decision. A later run, scheduled or
// manual, reads it as origin has it: its tip's hash from `git ls-remote`, and
// that commit fetched by hash with no ref, no FETCH_HEAD and no
// remote-tracking ref written, so no checkout and no ref of the repo is
// touched, under a dry run as in a real one. It runs the detector over its tracked files, writes the
// body afresh for that present state (it never reads the body), and marks the pull request ready when no marker
// remains, or a draft again while one does. It does not check the lockfile:
// that is the human's, and the repo's CI catches a stale one. Whether the pull
// request is ready to merge is read from its draft state and the detector,
// never from its body.
//
// The review is requested once, when plx opens the pull request, draft or
// not, from the users the root answers name as the pull request's branch has
// them, after copier ran at every site (`pr_reviewers`, a
// comma-separated string of GitHub user logins, empty or absent for none), or
// those `--reviewer` names instead; nothing more when it is marked ready.
// Users only: a team is refused. The request is one call for all of them, so
// the pull request's author is left out of it, and the run says so.
import { relative } from 'node:path';
import { filesWithConflictMarkers } from './conflicts.ts';
import type { Consumer } from './consumers.ts';
import type { Context } from './context.ts';
import { ANSWERS_FILE, parseAnswers } from './copier.ts';
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

/** A root answers file's answers; a file that is not YAML, or empty, is refused with what it is. */
function answersOf(text: string): Record<string, unknown> {
  if (text.trim() === '') throw new Error(`the root ${ANSWERS_FILE} is empty or missing`);
  try {
    return parseAnswers(text).answers;
  } catch (error) {
    throw new Error(`the root ${ANSWERS_FILE} cannot be read: ${(error as Error).message.split('\n')[0]}`);
  }
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

/** The version's pull request as the forge lists it, in any state. */
export interface Pull {
  url: string;
  number: number;
  draft: boolean;
  /** Open, or closed or merged by a human: a closed one stays closed. */
  open: boolean;
  /** Who opened it: the App in CI, a maintainer's own login by hand. */
  author?: string;
}

/**
 * The pull request from the version branch against the consumer's branch, in
 * any state: the open one if there is one, else the newest. Undefined when
 * there is none; a forge that cannot be asked is an error, never "none".
 */
export async function pullOf(
  ctx: Context,
  consumer: Consumer,
  dir: string,
  version: string,
): Promise<Pull | undefined> {
  const args = ['pr', 'list', '--head', versionBranch(version), '--base', consumer.branch, '--state', 'all'];
  const out = await ctx.read('gh', [...args, '--json', 'url,number,isDraft,state,author'], { cwd: dir });
  let listed: unknown;
  try {
    listed = JSON.parse(out);
  } catch {
    throw new Error(`gh pr list gave no JSON for ${versionBranch(version)}`);
  }
  if (!Array.isArray(listed)) throw new Error(`gh pr list gave no list for ${versionBranch(version)}`);
  const pulls = listed.flatMap((p: unknown) => {
    if (typeof p !== 'object' || p === null) return [];
    const { url, number, isDraft, state, author } = p as Record<string, unknown>;
    if (typeof url !== 'string' || typeof number !== 'number') return [];
    const login = (author as { login?: unknown } | null)?.login;
    return [
      {
        url,
        number,
        draft: isDraft === true,
        open: state === 'OPEN',
        ...(typeof login === 'string' ? { author: login } : {}),
      },
    ];
  });
  return pulls.find((p) => p.open) ?? pulls[0];
}

/** What asking for reviews came to. */
export type Review = { requested: string[] } | { failed: string };

/**
 * Who is asked to review: the logins named (`--reviewer`), or the root
 * answers file as the pull request's branch has it, after copier ran at every
 * site, whose `pr_reviewers` is read, and checked, only when a pull request is
 * opened.
 */
export type Reviewers = { named: string[] } | { answersFile: string };

/**
 * Ask the users for a review of the pull request, once; none asked, nothing
 * done. The request is one call for every login, so its author, who opened
 * it (a maintainer running the verb by hand who is among the reviewers), is
 * left out first, and the narration says so.
 */
export async function askForReviews(
  ctx: Context,
  name: string,
  pull: Pull,
  from: Reviewers,
  cwd: string,
): Promise<Review | undefined> {
  let named: string[];
  try {
    named = 'named' in from ? from.named : reviewersOf(answersOf(from.answersFile));
  } catch (error) {
    const why = (error as Error).message;
    ctx.say(`  ✗ FAILED — ${name}: no review requested: ${why}`);
    return { failed: why };
  }
  const author = pull.author?.toLowerCase();
  const reviewers = named.filter((l) => l.toLowerCase() !== author);
  if (reviewers.length < named.length)
    ctx.say(`• ${name}: ${pull.author} opened the pull request and is not asked to review it`);
  if (reviewers.length === 0) return undefined;
  try {
    await ctx.apply([requestReviews(pull.number, reviewers, cwd)]);
    return { requested: reviewers };
  } catch (error) {
    const why = detailOf(error);
    ctx.say(`  ✗ FAILED — ${name}: review request from ${reviewers.join(', ')}${why ? `: ${why}` : ''}`);
    return { failed: why || 'the forge refused it' };
  }
}

/**
 * The tip of the version branch as origin has it, its objects fetched by hash
 * with no ref, no FETCH_HEAD and no remote-tracking ref written.
 */
async function tipOf(ctx: Context, repo: string, branch: string): Promise<string> {
  const tip = (await ctx.read('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { cwd: repo }))
    .split('\t')[0]
    ?.trim();
  if (!tip) throw new Error(`origin no longer has ${branch}`);
  // By hash, with no refmap: only the objects arrive; a fetch by name would move origin's remote-tracking ref.
  await ctx.read('git', ['fetch', '--quiet', '--no-write-fetch-head', '--refmap=', 'origin', tip], { cwd: repo });
  return tip;
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
export async function revisit(ctx: Context, consumer: Consumer, pull: Pull, version: string): Promise<Revisited> {
  const { path: repo, rel: name } = consumer;
  const branch = versionBranch(version);
  const marked = await filesWithConflictMarkers(ctx, repo, await tipOf(ctx, repo, branch));
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

/** The last line of a body a later run opened. */
const OPENED_LATE = 'Opened by `plx update`: a later run found the branch on origin with no pull request.';

/** What a later run that opened the missing pull request came to. */
export interface OpenedLate {
  /** Undefined under a dry run, or when the forge did not list what it opened. */
  pull?: Pull;
  marked: string[];
  review?: Review;
  failed?: string;
}

/**
 * A later run that finds the version branch on origin and no pull request for
 * it in any state opens it: the branch read as origin has it, a draft when a
 * tracked file holds a conflict marker, with the review request.
 */
export async function openLate(
  ctx: Context,
  consumer: Consumer,
  version: string,
  reviewers: Reviewers | undefined,
): Promise<OpenedLate> {
  const { path: repo, rel: name } = consumer;
  const branch = versionBranch(version);
  const tip = await tipOf(ctx, repo, branch);
  const marked = await filesWithConflictMarkers(ctx, repo, tip);
  const sites = consumer.sites.map((s) => relative(consumer.path, s.path) || '.');
  const state: PullState = { version, sites, marked, note: OPENED_LATE };
  const draft = needsAHand(state);
  ctx.say(`• ${name}: ${branch} is on origin with no pull request — opening it${draft ? ' as a draft' : ''}`);
  try {
    await ctx.apply([
      run(
        'gh',
        [
          'pr',
          'create',
          ...(draft ? ['--draft'] : []),
          '--base',
          consumer.branch,
          '--head',
          branch,
          '--title',
          `chore: Plexus ${version}`,
          '--body',
          pullBody(state),
        ],
        { cwd: repo },
      ),
    ]);
  } catch (error) {
    const why = detailOf(error);
    ctx.say(`  ✗ FAILED — pull request${why ? `: ${why}` : ''}`);
    return { marked, failed: `pull request: ${why}` };
  }
  if (ctx.dryRun) return { marked };
  const pull = await pullOf(ctx, consumer, repo, version);
  if (!pull) return { marked, failed: 'pull request: the forge did not list it after opening it' };
  ctx.say(`• ${name}: ${draft ? 'draft ' : ''}pull request opened: ${pull.url}`);
  // Unless named, from the root answers as the branch has them.
  const from = reviewers ?? {
    answersFile: await ctx.read('git', ['cat-file', 'blob', `${tip}:${ANSWERS_FILE}`], { cwd: repo }).catch(() => ''),
  };
  const review = await askForReviews(ctx, name, pull, from, repo);
  return { pull, marked, ...(review ? { review } : {}) };
}
