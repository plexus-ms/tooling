// The templates (§ 1.6 PLX) by name, and what a copier answers file's recorded
// source says about which one a site is generated from. The model (which repo
// is the operations repo) and the consumers (which repos `update` refuses as
// not crossed over, which sites the preview of an unreleased version takes)
// read a source through `templateOf`.
import { VERSIONED_REPOS } from './version.ts';

/** The versioned repos that are templates: what a repo can be generated from. */
export const TEMPLATES: readonly string[] = VERSIONED_REPOS.filter((r) => r.startsWith('template-'));

/** The template source copier records for a template of the upstream organisation. */
export const templateSource = (template: string): string => `gh:plexus-ms/${template}`;

/**
 * Templates renamed on a version, old name → current (0.114.0: the web template
 * became the Turborepo template, the platform repo the operations repo; 0.120.0:
 * the repos' `preset-` prefix became `template-`, copier's own word). A
 * consumer whose answers still name the old one is a consumer of the current
 * one.
 */
export const RENAMED_TEMPLATES: Readonly<Record<string, string>> = {
  'preset-repo-web': 'template-repo-turbo',
  'preset-repo-platform': 'template-repo-operations',
  'preset-repo-turbo': 'template-repo-turbo',
  'preset-app-nextjs': 'template-app-nextjs',
  'preset-repo-operations': 'template-repo-operations',
};

/** The organisation the templates are published under. */
const UPSTREAM = 'plexus-ms';

/**
 * A recorded source as owner and repo name, whichever way it spells a GitHub
 * repo: copier's `gh:owner/repo`, `https://github.com/owner/repo`,
 * `git@github.com:owner/repo` or `ssh://git@github.com/owner/repo`, each with
 * or without `.git`. Undefined for anything else, a local path among them.
 */
function githubRepoOf(src: string): { owner: string; name: string } | undefined {
  const m =
    /^(?:gh:|https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      src.trim(),
    );
  return m?.[1] && m[2] ? { owner: m[1].toLowerCase(), name: m[2].toLowerCase() } : undefined;
}

/**
 * The current template a recorded template source stands for, under its
 * current or an earlier name, or undefined when it is none of the given
 * templates. Owner and repo name are compared, not the spelling.
 */
export function templateOf(src: string, templates: readonly string[]): string | undefined {
  const repo = githubRepoOf(src);
  if (repo?.owner !== UPSTREAM) return undefined;
  if (templates.includes(repo.name)) return repo.name;
  const current = Object.hasOwn(RENAMED_TEMPLATES, repo.name) ? RENAMED_TEMPLATES[repo.name] : undefined;
  return current && templates.includes(current) ? current : undefined;
}
