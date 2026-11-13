// The consumers of the templates: every copier-managed site under a directory
// (tenant repo roots and their apps/*) and the repo each belongs to. A
// consumer is updated in a scratch checkout of its origin's branch, never in
// its own checkout, on the branch the version lands on: a platform repo (declares
// PLX-Platform) rides main, an app repo (declares PLX-Repo) rides develop
// (§ 3 PLX-Delivery), and a package repo (its root answers say
// `publishes_packages`) is trunk-based on main (§ 5 PLX-Delivery). A repo
// whose marker says neither is taken on the branch its checkout is on.
import { relative } from 'node:path';
import type { Context } from './context.ts';
import type { Declaration } from './marker.ts';
import type { Directory } from './model.ts';
import { VERSIONED_REPOS } from './version.ts';

/** The versioned repos that are templates: what a repo can be generated from. */
export const TEMPLATES: readonly string[] = VERSIONED_REPOS.filter((r) => r.startsWith('template-'));

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
  /** Its sites in tree order: the repo root before its apps. */
  sites: Site[];
}

/** The branch a consumer is updated on; undefined when the marker says neither. */
export function expectedBranch(declaration?: Declaration, answers: Record<string, unknown> = {}): Consumer['expected'] {
  if (!declaration) return undefined;
  if (declaration.modules.includes('PLX-Platform')) return 'main';
  if (declaration.modules.includes('PLX-Repo')) return answers.publishes_packages === true ? 'main' : 'develop';
  return undefined;
}

/** The template source copier records for a template of the upstream organisation. */
export const templateSource = (template: string): string => `gh:plexus-ms/${template}`;

/**
 * Templates renamed on a version, old name → current (0.114.0: the web template
 * became the Turborepo template, the platform repo the operations repo; 0.120.0:
 * the repos' `preset-` prefix became `template-`, copier's own word). A
 * consumer whose answers still name the old one is a consumer of the current
 * one, and its next update points the answers at the new name.
 */
export const RENAMED_TEMPLATES: Readonly<Record<string, string>> = {
  'preset-repo-web': 'template-repo-turbo',
  'preset-repo-platform': 'template-repo-operations',
  'preset-repo-turbo': 'template-repo-turbo',
  'preset-app-nextjs': 'template-app-nextjs',
  'preset-repo-operations': 'template-repo-operations',
};

/** The current template a recorded template source stands for, or undefined when it is none of the given templates. */
export function templateOf(src: string, templates: readonly string[]): string | undefined {
  for (const p of templates) if (templateSource(p) === src) return p;
  for (const [old, current] of Object.entries(RENAMED_TEMPLATES))
    if (templateSource(old) === src && templates.includes(current)) return current;
  return undefined;
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
          const expected = expectedBranch(here.declaration, here.copier?.answers);
          consumer = {
            path: here.path,
            rel: relative(root.path, here.path) || '.',
            branch: expected ?? here.git?.branch ?? 'main',
            expected,
            sites: [],
          };
          consumers.set(here.path, consumer);
        }
        consumer.sites.push(site);
      }
    }
    for (const child of dir.children) visit(child, here, within);
  };
  visit(root, undefined, false);

  for (const site of orphans) ctx.say(`⚠ ${site.rel}: not inside a git repo — skipped`);
  for (const c of consumers.values()) {
    const origin = (await ctx.read('git', ['remote', 'get-url', 'origin'], { cwd: c.path }).catch(() => '')).trim();
    if (origin === '') c.skipped = 'no origin remote';
    else c.origin = origin;
  }
  return [...consumers.values()];
}
