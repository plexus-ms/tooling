// The templates (§ 1.6 PLX) by name, and what a copier answers file's recorded
// source says about which one a site is generated from. Both the model (which
// repo is the operations repo) and the consumers (which sites an update
// takes) read a source through `templateOf`.
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
