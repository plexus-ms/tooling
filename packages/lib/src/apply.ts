// apply: bring a repo's files in line with its markers, at the version the
// repo is on. It is the second step of edit, apply, commit: a human edits a
// marker's answers or its `templates` list, and `plx apply` renders what that
// changes into the working tree. It is how a site adopts or drops a template.
// It commits nothing and stages nothing; the marker's `version` is never
// written here (only `plx update` moves it).
//
// The procedure.
//   1. Find the repo's top from the directory given. Refuse, before anything
//      else, a directory in no repo, a repo without a commit (there is no HEAD
//      to compare with), and a repo in which git tracks a `.copier-answers.yml`
//      at any depth (it has not crossed over from copier, and its markers are
//      not yet its configuration), pointing to the crossover runbook.
//   2. Read the markers twice (sites.ts): old as `HEAD` has them, new as the
//      working tree has them. A site is a directory with a tracked marker, so
//      a new marker needs `git add` before it is a site. Refuse when any
//      marker on either side has a problem (it cannot be read, a nested one
//      carries `version`), naming the marker and the side: one tracked marker
//      with a problem anywhere in the repo, whatever site it belongs to,
//      blocks the run for every site, since a marker that is not read cannot
//      stand for a site with no templates.
//   3. When any marker lists templates, refuse unless the root marker's
//      `version` is the running plx's both at HEAD and in the working tree:
//      the templates this plx bundles are the ones that version was rendered
//      with, and only `plx update` writes the version.
//   4. Take each site whose own marker changed (its `templates` or its own
//      answers, or it is new or gone), and each nested site that lists a
//      template which owns or reads a root answer that changed, the root's
//      resolved answers compared, defaults included, so that swapping a
//      template for one with another default counts. A site that
//      listed no templates on either side renders nothing, and one not taken
//      is not rendered at all, so it cannot fail or write back a file its
//      user deleted.
//   5. Plan (sync.ts): render the old side and the new side of each taken
//      site with the templates below the root of templates, the root first,
//      its resolved answers given to the nested sites; merge them into the
//      site's directory by the engine's rules; and work out the defaults of
//      questions that became applicable. Nothing is written yet, every render
//      error of every site is reported together, and a default that would
//      stand in two markers is refused.
//   6. Confirm, then perform: write the merges and splice the defaults into
//      the markers. A conflict stays in the file; a file the template dropped
//      and the user had edited is kept; both are reported `conflicted`, and
//      the caller exits non-zero. A dry run, or a no, writes nothing.
// Birth commands of a template are never run: they belong to creating a repo.
//
// A second apply without a commit in between compares with the same HEAD and
// finds the files as the first left them: the bytes stay as they are, a
// conflicted file is reported `conflicted` again and the exit is non-zero
// again, and the other outcomes differ, since the files now hold what the
// first run wrote (a file it `added` is `clean`, one it `deleted` or a
// born-once file is `kept`). The defaults are in the marker by then, so none
// is written twice.
//
// The one gap: an answer edited and committed without `apply` is not noticed
// afterwards. HEAD then already holds the new marker, so apply sees no
// difference, and no lock file records what the files were rendered from.

import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Answers } from '@plexus-ms/cli-template';
import { loadTemplate } from './bundled.ts';
import type { Context } from './context.ts';
import { ANSWERS_FILE } from './copier.ts';
import { crossedOver } from './doctor.ts';
import { MARKER_FILE } from './marker.ts';
import { findSites, type MarkerSite, siteAnswers } from './sites.ts';
import { planSync, resolvedAnswers, type SiteMerge, type SiteSides, type Source } from './sync.ts';
import { templatesRoot } from './templatesRoot.ts';

export interface ApplyOptions {
  /** The repo, a directory inside git's working tree at its top. */
  repo: string;
  /** The Plexus version of the running plx. */
  plxVersion: string;
  /** The root of the templates; default `templatesRoot()`, the ones this plx bundles. */
  templates?: string;
}

export interface Applied {
  sites: SiteMerge[];
  conflicted: number;
  /** The changes were written: false for a dry run, a no, and a run with nothing to write. */
  applied: boolean;
  /** The answer to the prompt was no. */
  declined: boolean;
}

/** Where a repo that still has copier answers is pointed; the cutover writes the runbook's address here, once. */
export const CROSSOVER_RUNBOOK = 'the crossover runbook';

/** The templates and answers the site at `dir` among `sites` is rendered from; none where it has no marker. */
function sourceAt(sites: readonly MarkerSite[], dir: string, where: string): Source {
  const config = sites.find((s) => s.dir === dir)?.config;
  if (!config) return { templates: [], answers: {} };
  try {
    return { templates: config.templates ?? [], answers: siteAnswers(sites, dir) };
  } catch (error) {
    throw new Error(`${(error as Error).message} (the markers ${where})`);
  }
}

const AT_HEAD = 'at HEAD';
const IN_TREE = 'in the working tree';

/** The top of the repo that `dir` is inside; rejects, saying so, when it is inside none. */
async function topOf(ctx: Context, dir: string): Promise<string> {
  try {
    return (await ctx.read('git', ['rev-parse', '--show-toplevel'], { cwd: dir })).trim();
  } catch {
    throw new Error(`${dir} is not inside a git repository`);
  }
}

/** Every marker with a problem, as the lines of one refusal; none when all are readable. */
function problemsOf(now: readonly MarkerSite[], before: readonly MarkerSite[]): string[] {
  const lines = [...now.map((s) => ({ s, where: IN_TREE })), ...before.map((s) => ({ s, where: AT_HEAD }))]
    .filter(({ s }) => s.problem !== undefined)
    .map(({ s, where }) => `${join(s.dir, MARKER_FILE)} ${where}: ${s.problem}`);
  return lines.length === 0
    ? []
    : [
        ...lines,
        'apply compares the markers in the working tree with those at HEAD, so every one must be readable: fix it, and commit the fix where HEAD has the problem; nothing was written',
      ];
}

/** The refusal that the root marker's `version` is not the running plx's, at HEAD and in the working tree; none when it is. */
function versionRefusal(
  now: readonly MarkerSite[],
  before: readonly MarkerSite[],
  plxVersion: string,
): string | undefined {
  const [current, committed] = [now, before].map((sites) => sites.find((s) => s.dir === '.')?.config?.version);
  const root = MARKER_FILE;
  if (current === undefined)
    return `the root ${root} names no version, so plx cannot tell which templates the files were rendered with: set \`version: ${plxVersion}\` there (the plx pin in mise.toml names it) and commit it, then run apply again`;
  if (committed !== current)
    return `the root ${root} names version ${current} in the working tree and ${committed ?? 'none'} at HEAD: the version is not edited by hand, only \`plx update\` writes it; restore it with git checkout HEAD -- ${root} (or undo that line)`;
  if (current !== plxVersion)
    return `the root ${root} names version ${current}, and this plx is ${plxVersion}: apply with the plx that version pins (mise.toml)`;
  return undefined;
}

/** The keys whose answer differs between two maps: present in one only, or different. */
const changedKeys = (a: Answers, b: Answers): string[] =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => !isDeepStrictEqual(a[key], b[key]));

/** Whether a template of `names` owns or reads one of `keys`; a template that cannot be loaded counts, so that the error shows. */
async function relatesTo(root: string, names: readonly string[], keys: readonly string[]): Promise<boolean> {
  for (const name of names) {
    try {
      const manifest = await loadTemplate(root, name);
      const mine = [...manifest.questions.map((q) => q.name), ...manifest.reads.map((r) => r.name)];
      if (keys.some((key) => mine.includes(key))) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * The sites to render, each with its two sides: those whose own marker changed
 * (its templates or its own answers, or the marker is new or gone), and the
 * nested sites that list a template which owns or reads a root answer that
 * changed, its resolved answers compared, defaults included. A site with no
 * templates on either side renders nothing. When a site is taken the root is
 * rendered with it for the answers it gives, and merged only if it changed
 * itself.
 */
async function sitesToTake(
  now: readonly MarkerSite[],
  before: readonly MarkerSite[],
  root: string,
): Promise<SiteSides[]> {
  const configOf = (sites: readonly MarkerSite[], dir: string) => sites.find((s) => s.dir === dir)?.config;
  const [oldRoot, newRoot] = [sourceAt(before, '.', AT_HEAD), sourceAt(now, '.', IN_TREE)];
  const rootChanged = changedKeys(await resolvedAnswers(root, oldRoot), await resolvedAnswers(root, newRoot));
  const sides: SiteSides[] = [];
  for (const dir of new Set([...now, ...before].map((s) => s.dir))) {
    const [old, next] = [sourceAt(before, dir, AT_HEAD), sourceAt(now, dir, IN_TREE)];
    if (next.templates.length + old.templates.length === 0) continue;
    const [was, is] = [configOf(before, dir), configOf(now, dir)];
    const own =
      !isDeepStrictEqual(was?.templates ?? [], is?.templates ?? []) ||
      !isDeepStrictEqual(was?.answers ?? {}, is?.answers ?? {});
    if (own || (rootChanged.length > 0 && (await relatesTo(root, next.templates, rootChanged))))
      sides.push({ dir, old, new: next });
  }
  if (sides.length > 0 && !sides.some((s) => s.dir === '.'))
    sides.unshift({ dir: '.', old: oldRoot, new: newRoot, contextOnly: true });
  return sides;
}

export async function apply(ctx: Context, options: ApplyOptions): Promise<Applied> {
  const { plxVersion } = options;
  const repo = await topOf(ctx, options.repo);
  if (repo !== options.repo) ctx.say(`using the top of the repo, ${repo}`);
  const tracked = (await ctx.read('git', ['ls-files', '-z'], { cwd: repo })).split('\0');
  if (!crossedOver(tracked))
    throw new Error(
      `${repo} still tracks a ${ANSWERS_FILE}, so it has not crossed over from copier to the markers: follow ${CROSSOVER_RUNBOOK}`,
    );
  if (
    !(await ctx.read('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: repo }).then(
      () => true,
      () => false,
    ))
  )
    throw new Error(
      `${repo} has no commit yet: apply compares the markers in the working tree with HEAD, so commit them first`,
    );
  const now = await findSites(ctx, repo);
  const before = await findSites(ctx, repo, 'HEAD');
  const problems = problemsOf(now, before);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  if ([...now, ...before].some((s) => s.config?.templates !== undefined)) {
    const refusal = versionRefusal(now, before, plxVersion);
    if (refusal !== undefined) throw new Error(refusal);
  }
  const root = options.templates ?? templatesRoot();
  const sides = await sitesToTake(now, before, root);
  const siblings = now
    .filter((s) => s.dir !== '.')
    .map((s) => ({ dir: s.dir, templates: s.config?.templates ?? [], answers: s.config?.answers ?? {} }));
  const plan = await planSync(ctx, repo, root, sides, {
    labels: { old: 'the markers at HEAD', new: 'the markers in the working tree' },
    siblings,
  });
  const changes = plan.sites.reduce((n, s) => n + s.report.length + Object.keys(s.defaults).length, 0);
  const result = { sites: plan.sites, conflicted: plan.conflicted };
  if (changes === 0) return { ...result, applied: false, declined: false };
  const where = plan.sites.length === 1 ? 'one site' : `${plan.sites.length} sites`;
  if (!(await ctx.confirm(`apply ${changes} changes in ${where} to ${repo}?`)))
    return { ...result, applied: false, declined: true };
  await plan.perform();
  return { ...result, applied: !ctx.dryRun, declined: false };
}
