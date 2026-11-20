// pull: the version's pull request (§ 3 PLX-Updates), on `plexus/<version>`
// against the branch the version lands on. take.ts opens it; a later run
// that finds the branch on origin with the pull request open comes back to it
// here (`revisit`).
//
// A pull request that needs a hand is asked for as a draft, and its body
// opens with what needs it: the sites that conflicted, the tracked files that
// hold conflict markers (conflicts.ts), the sites whose copier run failed,
// and, when the lockfile did not refresh, that `pnpm install` is to be run
// after resolving. Where the forge refuses a draft, the same pull request is
// opened as an ordinary one, and the run says so; it needs a hand all the
// same. One that needs none is ready for review.
//
// The branch is never moved by any run, and plx never pushes to it again: it
// is the human's from the moment it is on origin. A later run, scheduled or
// manual, reads it as origin has it: its tip's hash from `git ls-remote`, and
// that commit fetched by hash with no ref, no FETCH_HEAD and no
// remote-tracking ref written, so no checkout and no ref of the repo is
// touched, under a dry run as in a real one. At the tip it checks two things:
// that no tracked file holds a conflict marker, and that every site the tip
// holds records the version in its answers (`_commit`); a site that does not
// is one copier did not run at. Both hold: the pull request is ready. It
// writes the body afresh for what it checked (it never reads the body), and
// marks the pull request ready, or a draft again while either fails; a forge
// that refuses the draft leaves it ordinary, which the run says and does not
// count as a failure of its own. Whether the refresh of the lockfile failed is
// not known then, so the body asks for `pnpm install` and the lockfile
// wherever the tip holds one and the pull request is not ready, or the branch
// holds commits beyond the one plx made (somebody resolved by hand); plx's
// commit is told from the others by the count of commits the forge says the
// branch is ahead of the one the version lands on. Whether the pull request is
// ready to merge is read from its draft state and the tip, never from its
// body.
//
// A later run that finds the branch with no pull request in any state
// (opening failed after the push) opens the pull request then (`openLate`),
// ready or a draft by the same check, with the review request; a closed or
// merged one is left as it is, a human's decision. A closed one counts only
// when it was closed at the tip origin has now: one of an earlier branch of
// the name, deleted and pushed again, is not this branch's, and neither is
// one from a fork's branch of the name.
//
// The review is requested once, when plx opens the pull request, draft or
// not, from the users the root answers name as the pull request's branch has
// them, after copier ran at every site (`pr_reviewers`, a
// comma-separated string of GitHub user logins, empty or absent for none), or
// those `--reviewer` names instead; nothing more when it is marked ready.
// Users only: a team is refused. The request is one call for all of them, so
// the pull request's author is left out of it, and the run says so.
import { filesWithConflictMarkers } from './conflicts.ts';
import { type Consumer, sitesOfTree } from './consumers.ts';
import type { Context } from './context.ts';
import { ANSWERS_FILE, copierVia, parseAnswers } from './copier.ts';
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

/** The pull request to open: the version branch against `base`, with its body. */
export interface PullRequest {
  base: string;
  version: string;
  body: string;
  /** Asked for as a draft. */
  draft: boolean;
}

/**
 * Open the version's pull request, as a draft when one is asked for. A forge
 * that refuses the draft, for whatever reason, is asked once more for the
 * same pull request as an ordinary one, and the run says so; when that fails
 * too, the error names both attempts. Resolves with whether it is a draft.
 */
export async function createPull(ctx: Context, name: string, req: PullRequest, cwd: string): Promise<boolean> {
  const create = (draft: boolean) =>
    run(
      'gh',
      [
        'pr',
        'create',
        ...(draft ? ['--draft'] : []),
        '--base',
        req.base,
        '--head',
        versionBranch(req.version),
        '--title',
        `chore: Plexus ${req.version}`,
        '--body',
        req.body,
      ],
      { cwd },
    );
  if (!req.draft) {
    await ctx.apply([create(false)]);
    return false;
  }
  try {
    await ctx.apply([create(true)]);
    return true;
  } catch (refused) {
    try {
      await ctx.apply([create(false)]);
    } catch (error) {
      throw new Error(
        `as a draft: ${detailOf(refused) || 'refused'}; as an ordinary one: ${detailOf(error) || 'refused'}`,
      );
    }
    ctx.say(
      `• ${name}: the pull request is no draft: the forge refused one${detailOf(refused) ? ` (${detailOf(refused)})` : ''}`,
    );
    return false;
  }
}

/** The version's pull request as the forge lists it, in any state. */
export interface Pull {
  url: string;
  number: number;
  draft: boolean;
  /** Open, or closed or merged by a human: a closed one stays closed. */
  open: boolean;
  /** Who opened it: the App in CI, a maintainer's own login by hand. */
  author?: string;
  /** Its head commit: the branch's tip while it is open, the tip it had when it was closed. */
  head?: string;
}

/** How many pull requests of the version branch plx asks the forge for; none relies on gh's default. */
const LISTED = 1000;

/**
 * The pull request from the version branch against the consumer's branch:
 * the open one if there is one, else a closed or merged one whose head commit
 * is `tip`, the branch's tip on origin, the highest numbered if several are.
 * A closed one of an earlier branch of the same name, deleted since and
 * pushed again, is not this branch's; nor is one from another repository (a
 * fork's branch of that name). Undefined when there is none; a forge that
 * cannot be asked is an error, never "none".
 */
export async function pullOf(
  ctx: Context,
  consumer: Consumer,
  dir: string,
  version: string,
  tip?: string,
): Promise<Pull | undefined> {
  const args = ['pr', 'list', '--head', versionBranch(version), '--base', consumer.branch, '--state', 'all'];
  const fields = 'url,number,isDraft,state,author,headRefOid,isCrossRepository';
  const out = await ctx.read('gh', [...args, '--limit', String(LISTED), '--json', fields], { cwd: dir });
  let listed: unknown;
  try {
    listed = JSON.parse(out);
  } catch {
    throw new Error(`gh pr list gave no JSON for ${versionBranch(version)}`);
  }
  if (!Array.isArray(listed)) throw new Error(`gh pr list gave no list for ${versionBranch(version)}`);
  const pulls = listed.flatMap((p: unknown) => {
    if (typeof p !== 'object' || p === null) return [];
    const { url, number, isDraft, state, author, headRefOid, isCrossRepository } = p as Record<string, unknown>;
    if (typeof url !== 'string' || typeof number !== 'number' || isCrossRepository !== false) return [];
    const login = (author as { login?: unknown } | null)?.login;
    return [
      {
        url,
        number,
        draft: isDraft === true,
        open: state === 'OPEN',
        ...(typeof login === 'string' ? { author: login } : {}),
        ...(typeof headRefOid === 'string' ? { head: headRefOid } : {}),
      },
    ];
  });
  const open = pulls.find((p) => p.open);
  if (open) return open;
  return pulls.filter((p) => tip !== undefined && p.head === tip).sort((a, b) => b.number - a.number)[0];
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

/** The hash of the branch's tip as origin has it, from `git ls-remote`. */
export async function tipOnOrigin(ctx: Context, repo: string, branch: string): Promise<string> {
  const tip = (await ctx.read('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { cwd: repo }))
    .split('\t')[0]
    ?.trim();
  if (!tip) throw new Error(`origin no longer has ${branch}`);
  return tip;
}

/**
 * The commit's objects, fetched by hash with no ref, no FETCH_HEAD and no
 * remote-tracking ref written. A later run needs the tip's tree only: in a
 * shallow clone (CI's checkout) the tip comes alone, never the branch's
 * history; a full clone is never made shallow by it.
 */
async function fetchTip(ctx: Context, repo: string, tip: string): Promise<void> {
  const shallow = (await ctx.read('git', ['rev-parse', '--is-shallow-repository'], { cwd: repo })).trim() === 'true';
  // By hash, with no refmap: only the objects arrive; a fetch by name would move origin's remote-tracking ref.
  await ctx.read(
    'git',
    ['fetch', '--quiet', '--no-write-fetch-head', '--refmap=', ...(shallow ? ['--depth', '1'] : []), 'origin', tip],
    { cwd: repo },
  );
}

/**
 * How many commits the tip is ahead of the branch it is to land on, as the
 * forge counts them (`ahead_by` of its compare, from their merge base, the
 * count a pull request lists), never from local history, which a shallow or
 * single-branch clone does not hold.
 */
async function aheadOf(ctx: Context, consumer: Consumer, tip: string): Promise<number> {
  const out = await ctx.read(
    'gh',
    ['api', `repos/{owner}/{repo}/compare/${consumer.branch}...${tip}`, '--jq', '.ahead_by'],
    { cwd: consumer.path },
  );
  const ahead = Number(out.trim());
  if (out.trim() === '' || !Number.isInteger(ahead)) throw new Error(`the forge gave no count of commits for ${tip}`);
  return ahead;
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
  /** Sites whose answers do not record the version: copier did not run there. */
  behind?: string[];
  /** The opening run: the lockfile refresh failed. A later run: run `pnpm install` and commit the lockfile. */
  lockfile?: boolean;
  /** Written by a later run from what it checked at the branch's tip, not by the run that opened it. */
  checked?: boolean;
  /** The last line: who opened it and why, or that a later run rewrote it. */
  note: string;
}

/** Whether anything in the state needs a hand. */
export const needsAHand = (p: PullState): boolean =>
  (p.conflicted?.length ?? 0) > 0 ||
  p.marked.length > 0 ||
  (p.failed?.length ?? 0) > 0 ||
  (p.behind?.length ?? 0) > 0 ||
  (p.lockfile === true && !p.checked);

const code = (s: string) => `\`${s}\``;

/**
 * The copier update a human runs at a site to bring it to the version: the
 * copier plx pins, at that version, never the newest tag (which, once a newer
 * version is cut, would leave the site behind for good); trusted, as plx runs
 * it; the questions answered already not asked again. Unlike plx's own run,
 * new questions are asked and the template's tasks run: it is a developer's
 * checkout.
 */
export const byHand = (version: string): string =>
  ['mise', ...copierVia(['update', '--trust', '--skip-answered', '--vcs-ref', version])].join(' ');
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
    ...(p.behind ?? []).map(
      (s) =>
        `- The answers at ${site(s)} do not record ${p.version}: copier did not run here. On this branch, in ${site(s)}, run \`${byHand(p.version)}\` and commit what it changes.`,
    ),
    ...(p.lockfile && !p.checked
      ? ['- The lockfile did not refresh: run `pnpm install` after resolving, and commit the lockfile.']
      : []),
  ];
  // A later run cannot know whether the refresh failed; it asks for one where the branch may need it.
  const lockfile = p.lockfile && p.checked ? ['- Run `pnpm install` once resolved, and commit the lockfile.'] : [];
  const head =
    hand.length > 0
      ? `**Needs a hand.** \`plx update\` marks this pull request ready once no tracked file holds a conflict marker and every site's answers record the version.\n\n${[...hand, ...lockfile].join('\n')}`
      : p.checked
        ? `Ready for review: no tracked file holds a conflict marker, and every site's answers record ${p.version}.${lockfile.length ? `\n\n${lockfile.join('\n')}` : ''}`
        : 'Nothing needs a hand: every site merged clean.';
  return [
    head,
    `Plexus ${p.version} (§ 1.5 PLX): \`copier update\` at ${p.sites.map(site).join(', ')}, the lockfile where manifests moved, and the workflow refs.`,
    p.note,
  ].join('\n\n');
}

/** The last line of a body a later run rewrote. */
const REVISITED = "Opened by `plx update`; rewritten by a later run from what it found at the branch's tip.";

/** What a later run reads at the version branch's tip, as origin has it. */
interface AtTip {
  /** The tip's hash, its objects fetched. */
  tip: string;
  /** The sites the tip holds, relative to the repo (`.` for its root). */
  sites: string[];
  /** Tracked files that hold a conflict marker. */
  marked: string[];
  /** Sites whose answers do not record the version. */
  behind: string[];
  /** No marker, and every site at the version. */
  ready: boolean;
  /** Whether the body asks for `pnpm install` and the lockfile. */
  lockfile: boolean;
}

/**
 * The version branch's tip, read by hash: the detector over its tracked
 * files, and its sites, every answers file it holds that names a template,
 * each at the version or not. The lockfile is asked for where the tip holds
 * one and the pull request is not ready, or holds commits beyond the one plx
 * made (somebody resolved by hand), as the forge counts them (`aheadOf`).
 */
async function readTip(ctx: Context, consumer: Consumer, version: string, tip: string): Promise<AtTip> {
  const repo = consumer.path;
  await fetchTip(ctx, repo, tip);
  const marked = await filesWithConflictMarkers(ctx, repo, tip);
  const { files, sites: held } = await sitesOfTree(ctx, repo, tip);
  const sites = held.map((s) => s.dir);
  const behind = held.filter((s) => s.answers?.commit !== version).map((s) => s.dir);
  const ready = marked.length === 0 && behind.length === 0;
  // Somebody pushed to the branch: more commits than the one plx made. Asked only when it decides something.
  const lockfile = files.includes('pnpm-lock.yaml') && (!ready || (await aheadOf(ctx, consumer, tip)) > 1);
  return { tip, sites, marked, behind, ready, lockfile };
}

/** What a later run found at the tip, as the run names it. */
function foundAt(at: AtTip, version: string): string {
  const n = at.marked.length;
  const parts = [
    ...(n > 0 ? [`${n} file${n === 1 ? '' : 's'} still hold${n === 1 ? 's' : ''} conflict markers`] : []),
    ...(at.behind.length > 0 ? [`${at.behind.map(site).join(', ')} not at ${version}: copier did not run there`] : []),
  ];
  return parts.length > 0 ? parts.join('; ') : `no conflict marker remains, and every site is at ${version}`;
}

/** What a later run found of a pull request on origin, and did to it. */
export interface Revisited {
  url: string;
  /** Tracked files of the branch that hold a conflict marker. */
  marked: string[];
  /** Sites of the branch whose answers do not record the version. */
  behind: string[];
  /** Ready to merge once its checks pass: no longer a draft, no marker left, every site at the version. */
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
export async function revisit(
  ctx: Context,
  consumer: Consumer,
  pull: Pull,
  version: string,
  tip: string,
): Promise<Revisited> {
  const { path: repo, rel: name } = consumer;
  const branch = versionBranch(version);
  const at = await readTip(ctx, consumer, version, tip);
  const { marked, behind, ready } = at;
  const body = pullBody({
    version,
    sites: at.sites,
    marked,
    behind,
    lockfile: at.lockfile,
    checked: true,
    note: REVISITED,
  });
  const found = foundAt(at, version);
  ctx.say(
    ready
      ? `• ${name}: ${branch} is on origin (${pull.url}); ${found}${pull.draft ? ' — ready for review' : ''}`
      : `• ${name}: ${branch} is on origin (${pull.url}); ${found}${pull.draft ? '' : ' — a draft again'}`,
  );
  // The body is written, never read: what it says decides nothing.
  try {
    await ctx.apply([
      run('gh', ['api', `repos/{owner}/{repo}/pulls/${pull.number}`, '--method', 'PATCH', '-f', `body=${body}`], {
        cwd: repo,
      }),
      ...(ready && pull.draft ? [run('gh', ['pr', 'ready', pull.url], { cwd: repo })] : []),
    ]);
  } catch (error) {
    return { url: pull.url, marked, behind, mergeable: false, failed: `pull request ${pull.url}: ${detailOf(error)}` };
  }
  // A forge that refuses the draft leaves the pull request ordinary: what needs a hand keeps the run nonzero.
  if (!ready && !pull.draft)
    await ctx.apply([run('gh', ['pr', 'ready', pull.url, '--undo'], { cwd: repo })]).catch((error) => {
      const why = detailOf(error);
      ctx.say(`  ${name}: still no draft: the forge refused one${why ? ` (${why})` : ''}`);
    });
  // A dry run left the state as it was.
  const draft = ctx.dryRun ? pull.draft : !ready;
  return { url: pull.url, marked, behind, mergeable: ready && !draft };
}

/** The last line of a body a later run opened. */
const OPENED_LATE = 'Opened by `plx update`: a later run found the branch on origin with no pull request.';

/** What a later run that opened the missing pull request came to. */
export interface OpenedLate {
  /** Undefined under a dry run, or when the forge did not list what it opened. */
  pull?: Pull;
  marked: string[];
  behind: string[];
  /** No marker, and every site at the version. */
  ready: boolean;
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
  tip: string,
): Promise<OpenedLate> {
  const { path: repo, rel: name } = consumer;
  const branch = versionBranch(version);
  const at = await readTip(ctx, consumer, version, tip);
  const { marked, behind, ready } = at;
  const state: PullState = {
    version,
    sites: at.sites,
    marked,
    behind,
    lockfile: at.lockfile,
    checked: true,
    note: OPENED_LATE,
  };
  const asDraft = !ready;
  ctx.say(`• ${name}: ${branch} is on origin with no pull request — opening it${asDraft ? ' as a draft' : ''}`);
  let draft: boolean;
  try {
    draft = await createPull(
      ctx,
      name,
      { base: consumer.branch, version, body: pullBody(state), draft: asDraft },
      repo,
    );
  } catch (error) {
    const why = detailOf(error);
    ctx.say(`  ✗ FAILED — pull request${why ? `: ${why}` : ''}`);
    return { marked, behind, ready, failed: `pull request: ${why}` };
  }
  if (ctx.dryRun) return { marked, behind, ready };
  const pull = await pullOf(ctx, consumer, repo, version);
  if (!pull) return { marked, behind, ready, failed: 'pull request: the forge did not list it after opening it' };
  ctx.say(`• ${name}: ${draft ? 'draft ' : ''}pull request opened: ${pull.url}`);
  // Unless named, from the root answers as the branch has them.
  const from = reviewers ?? {
    answersFile: await ctx
      .read('git', ['cat-file', 'blob', `${at.tip}:${ANSWERS_FILE}`], { cwd: repo })
      .catch(() => ''),
  };
  const review = await askForReviews(ctx, name, pull, from, repo);
  return { pull, marked, behind, ready, ...(review ? { review } : {}) };
}
