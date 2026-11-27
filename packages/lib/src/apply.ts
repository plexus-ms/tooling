// apply: bring a repo's files in line with its markers, at the version the
// repo is on. It is the second step of edit, apply, commit: a human edits a
// marker's answers or its `templates` list, and `plx apply` renders what that
// changes into the working tree. It is how a site adopts or drops a template.
// It commits nothing and stages nothing; the marker's `version` is never
// written here (only `plx update` moves it).
//
// The procedure.
//   1. Refuse, before reading anything else, when git tracks a
//      `.copier-answers.yml` at any depth (the repo has not crossed over from
//      copier, and its markers are not yet its configuration), pointing to the
//      crossover runbook; and when the root marker names no version or one
//      that is not the running plx's, since the templates this plx bundles
//      are the ones that version was rendered with.
//   2. Read the markers twice (sites.ts): old as `HEAD` has them, new as the
//      working tree has them. A site is a directory with a tracked marker, so
//      a new marker needs `git add` before it is a site.
//   3. Take each site whose templates or answers differ between the two, a
//      nested site's answers being the root's plus its own, so that a root
//      answer changed reaches every nested site. A site that listed no
//      templates on either side renders nothing, and one that did not change
//      is not rendered at all, so it cannot fail.
//   4. Plan (sync.ts): render the old side and the new side of each site with
//      the templates below the root of templates, merge them into the site's
//      directory by the engine's rules, and work out the defaults of
//      questions that became applicable. Nothing is written yet, and every
//      render error of every site is reported together.
//   5. Confirm, then perform: write the merges and splice the defaults into
//      the markers. A conflict stays in the file; a file the template dropped
//      and the user had edited is kept; both are reported `conflicted`, and
//      the caller exits non-zero.
// Birth commands of a template are never run: they belong to creating a repo.
//
// The one gap: an answer edited and committed without `apply` is not noticed
// afterwards. HEAD then already holds the new marker, so apply sees no
// difference, and no lock file records what the files were rendered from.

import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Answers } from '@plexus-ms/cli-template';
import { bundledTemplatesRoot, loadTemplate } from './bundled.ts';
import type { Context } from './context.ts';
import { ANSWERS_FILE } from './copier.ts';
import { crossedOver } from './doctor.ts';
import { MARKER_FILE } from './marker.ts';
import { findSites, type MarkerSite, siteAnswers } from './sites.ts';
import { planSync, type SiteMerge, type SiteSides, type Source } from './sync.ts';

export interface ApplyOptions {
  /** The repo, a directory inside git's working tree at its top. */
  repo: string;
  /** The Plexus version of the running plx. */
  plxVersion: string;
  /** The root of the templates; default the ones this plx bundles. */
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
function sourceAt(sites: readonly MarkerSite[], dir: string): Source {
  const config = sites.find((s) => s.dir === dir)?.config;
  return config
    ? { templates: config.templates ?? [], answers: siteAnswers(sites, dir) }
    : { templates: [], answers: {} };
}

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
  const lines = [
    ...now.map((s) => ({ s, where: 'in the working tree' })),
    ...before.map((s) => ({ s, where: 'at HEAD' })),
  ]
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
 * changed. A site with no templates on either side renders nothing. When a
 * nested site is taken, the root is rendered with it for the answers it gives,
 * and merged only if it changed itself.
 */
async function sitesToTake(
  now: readonly MarkerSite[],
  before: readonly MarkerSite[],
  templates: string | undefined,
): Promise<SiteSides[]> {
  const configOf = (sites: readonly MarkerSite[], dir: string) => sites.find((s) => s.dir === dir)?.config;
  const rootChanged = changedKeys(configOf(before, '.')?.answers ?? {}, configOf(now, '.')?.answers ?? {});
  const sides: SiteSides[] = [];
  for (const dir of new Set([...now, ...before].map((s) => s.dir))) {
    const [old, next] = [sourceAt(before, dir), sourceAt(now, dir)];
    if (next.templates.length + old.templates.length === 0) continue;
    const [was, is] = [configOf(before, dir), configOf(now, dir)];
    const own =
      !isDeepStrictEqual(was?.templates ?? [], is?.templates ?? []) ||
      !isDeepStrictEqual(was?.answers ?? {}, is?.answers ?? {});
    const read =
      dir !== '.' &&
      rootChanged.length > 0 &&
      (await relatesTo(templates ?? bundledTemplatesRoot(), [...old.templates, ...next.templates], rootChanged));
    if (own || read) sides.push({ dir, old, new: next });
  }
  const rootSource = sourceAt(now, '.');
  if (sides.length > 0 && !sides.some((s) => s.dir === '.') && rootSource.templates.length > 0)
    sides.unshift({ dir: '.', old: sourceAt(before, '.'), new: rootSource, contextOnly: true });
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
  const sides = await sitesToTake(now, before, options.templates);
  if (sides.length === 0) return { sites: [], conflicted: 0, applied: false, declined: false };
  const siblings = now.filter((s) => s.dir !== '.').map((s) => ({ dir: s.dir, answers: s.config?.answers ?? {} }));
  const plan = await planSync(ctx, repo, options.templates ?? bundledTemplatesRoot(), sides, {
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
