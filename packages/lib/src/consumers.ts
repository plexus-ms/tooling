// The consumers of the templates: the repos under a directory that take a
// version. A consumer is updated in a scratch checkout of its origin's branch,
// never in its own checkout, on the branch the version lands on: the
// operations repo rides main, an app repo rides develop (§ 3 PLX-Delivery),
// and a package repo (its root answers say `publishes_packages`) is
// trunk-based on main (§ 5 PLX-Delivery). A repo without a marker is taken on
// the branch its checkout is on.
//
// `findRepos` finds them for `plx update`: every git repo whose root marker
// names a version or lists templates, and every one whose root answers file
// still names a template, which `update` refuses, pointing to the crossover
// runbook. `findConsumers` finds the copier-managed sites (tenant repo roots
// and their apps/*) and the repo each belongs to, for the maintainers'
// preview of an unreleased version (preview.ts of @plexus-ms/dev), which still
// runs copier until the cutover.
import { relative } from 'node:path';
import type { Context } from './context.ts';
import { type Directory, isOperations } from './model.ts';
import { TEMPLATES, templateOf } from './templates.ts';

export interface Site {
  path: string;
  /** Relative to the workspace. */
  rel: string;
  /** The template the site is generated from, e.g. `template-repo-turbo`. */
  template: string;
}

export interface Consumer {
  path: string;
  rel: string;
  /** The branch the version lands on: the expected one, or the checkout's own when the marker names none. */
  branch: string;
  expected?: 'main' | 'develop';
  /** The URL of `origin`, which the scratch clone is made from. */
  origin?: string;
  /** Why the consumer is left untouched this run, if it is. */
  skipped?: string;
  /** Its copier-managed sites in tree order, the repo root before its apps; none for a repo found by its markers. */
  sites: Site[];
}

/** The branch a consumer is updated on; undefined for a repo without a marker. */
export function expectedBranch(repo: Directory): Consumer['expected'] {
  if (!repo.declaration) return undefined;
  if (isOperations(repo)) return 'main';
  const packages = [repo.config?.answers, repo.copier?.answers].some((a) => a?.publishes_packages === true);
  return packages ? 'main' : 'develop';
}

/** A consumer of the repo `dir`, named relative to `root`, before its origin is read. */
const consumerOf = (root: Directory, dir: Directory): Consumer => {
  const expected = expectedBranch(dir);
  return {
    path: dir.path,
    rel: relative(root.path, dir.path) || '.',
    branch: expected ?? dir.git?.branch ?? 'main',
    expected,
    sites: [],
  };
};

/** Each consumer's origin, which the scratch clone is made from; one without is skipped. */
async function withOrigins(ctx: Context, consumers: Consumer[]): Promise<Consumer[]> {
  for (const c of consumers) {
    const origin = (await ctx.read('git', ['remote', 'get-url', 'origin'], { cwd: c.path }).catch(() => '')).trim();
    if (origin === '') c.skipped = 'no origin remote';
    else c.origin = origin;
  }
  return consumers;
}

/**
 * The repos under a scanned workspace (`overview` with git facets) that take a
 * version, in tree order: each git repo outside a template directory whose
 * root marker names a version or lists templates, or whose root answers file
 * names one of the templates. A repo without an origin is skipped.
 */
export async function findRepos(ctx: Context, root: Directory): Promise<Consumer[]> {
  const found: Consumer[] = [];
  const visit = (dir: Directory, inTemplate: boolean) => {
    const within = inTemplate || Boolean(dir.template);
    const marked = dir.config?.version !== undefined || dir.config?.templates !== undefined;
    const copier = dir.copier?.src !== undefined && templateOf(dir.copier.src, TEMPLATES) !== undefined;
    if (dir.git && !within && (marked || copier)) found.push(consumerOf(root, dir));
    for (const child of dir.children) visit(child, within);
  };
  visit(root, false);
  return withOrigins(ctx, found);
}

/**
 * The consumers under a scanned workspace (`overview` with git facets), for
 * the given templates. A site inside a template directory is the template's own
 * and never a consumer; a site outside any git repo is reported, not updated;
 * a repo without an origin has nowhere to clone from and is skipped.
 */
export async function findConsumers(ctx: Context, root: Directory, templates: readonly string[]): Promise<Consumer[]> {
  const consumers = new Map<string, Consumer>();
  const orphans: Site[] = [];

  const visit = (dir: Directory, repo: Directory | undefined, inTemplate: boolean) => {
    const here = dir.git ? dir : repo;
    const within = inTemplate || Boolean(dir.template);
    const template = dir.copier?.src ? templateOf(dir.copier.src, templates) : undefined;
    if (template && !within) {
      const site: Site = { path: dir.path, rel: relative(root.path, dir.path) || '.', template };
      if (!here) orphans.push(site);
      else {
        let consumer = consumers.get(here.path);
        if (!consumer) {
          consumer = consumerOf(root, here);
          consumers.set(here.path, consumer);
        }
        consumer.sites.push(site);
      }
    }
    for (const child of dir.children) visit(child, here, within);
  };
  visit(root, undefined, false);

  for (const site of orphans) ctx.say(`⚠ ${site.rel}: not inside a git repo — skipped`);
  return withOrigins(ctx, [...consumers.values()]);
}
