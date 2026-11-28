// The markers against the templates this plx bundles: what `plx doctor` checks
// of a repo that has crossed over (doctor.ts) once it has the templates. Each
// finding is a line naming the marker it concerns.
//
// `templates` names only templates the bundle holds. A name it lacks is a
// finding and the name is left out of the rest.
//
// Every key of a marker is reserved (`version`, `templates`, `deviations`) or
// a question or read of a template, found by handing the marker's answers to
// the engine's `render` and taking the answers it lists as unused: no template
// of the render owns or reads them. Which templates form the render decides
// which keys a marker may hold, by the composition rules (a nested site's
// answers are the root marker's, defaults of its templates included, plus its
// own, and a given answer no template owns may satisfy a read):
//
//   a nested marker  the templates it lists itself; a key that only a template
//                    of the root marker owns belongs in the root marker, and
//                    is a finding here
//   the root marker  the templates of every marker of the repo, since the root
//                    holds the answers that nested sites' templates own or
//                    read, and shares them with every site; so a root key that
//                    no template of the repo owns or reads is a finding even
//                    where the root lists no template itself
//   no templates     a marker that lists none is not checked, unless it is the
//                    root and another marker lists some: a third-party app's
//                    marker states its `profile`, and nothing renders from it
//
// A repo none of whose markers lists a template checks no key.
//
// Every answer is valid for its question: type, choices and validator are the
// engine's own question resolution, which `render` runs for the templates a
// marker lists on that site's answers (the root's, resolved, plus its own). Its
// errors that concern a question or a read, among them an answer missing, are
// findings, named at the marker that holds the key, once however many sites
// render with it: a root answer to a nested template's question is judged at
// the root marker. An error that concerns no question (a template's files or
// manifest, two templates of one marker that write one path) is not reported
// here; `plx apply` refuses it. A question nothing answers, or a read nothing
// supplies, is named at the marker that lists the template.
//
// Each site is rendered once for both, and the root a second time over the
// union of templates only where that differs from its own.
import { join } from 'node:path';
import type { render, Tree } from '@plexus-ms/cli-template';
import { MARKER_FILE } from './marker.ts';
import { type MarkerSite, siteAnswers } from './sites.ts';

/**
 * The templates a plx bundles, each as the engine reads it, by the name a
 * marker lists, and the engine's `render`, which the caller loads (engine.ts)
 * so that no program that never renders imports the engine.
 */
export interface Bundled {
  readonly trees: ReadonlyMap<string, Tree>;
  readonly render: typeof render;
}

/** The findings of the markers among `sites` against `bundled`. */
export function templateFindings(
  sites: readonly MarkerSite[],
  bundled: Bundled,
  rootAnswers?: Record<string, unknown>,
): string[] {
  const { keys, answers } = judge(sites, bundled, rootAnswers);
  return [...unknownNames(sites, bundled), ...keys, ...answers];
}

function unknownNames(sites: readonly MarkerSite[], bundled: Bundled): string[] {
  const held = [...bundled.trees.keys()].sort().map((name) => `\`${name}\``);
  return sites.flatMap(({ dir, config }) =>
    (config?.templates ?? [])
      .filter((name) => !bundled.trees.has(name))
      .map(
        (name) =>
          `${join(dir, MARKER_FILE)}: \`templates\` names \`${name}\`, which this plx does not bundle (it bundles ${held.join(', ')})`,
      ),
  );
}

/** The keys that no template of a marker's scope owns or reads, and the invalid answers, of every site. */
function judge(
  sites: readonly MarkerSite[],
  bundled: Bundled,
  rootAnswers: Record<string, unknown> | undefined,
): { keys: string[]; answers: string[] } {
  const listed = (site: MarkerSite) => site.config?.templates ?? [];
  const trees = (names: Iterable<string>) => [...names].flatMap((name) => bundled.trees.get(name) ?? []);
  const rootConfig = sites.find((s) => s.dir === '.')?.config;
  const everywhere = [...new Set(sites.flatMap(listed))];
  const keys: string[] = [];
  const answers = new Set<string>();
  for (const site of sites) {
    const { dir, config } = site;
    const root = dir === '.';
    const mine = [...new Set(listed(site))];
    if (!config || (root ? everywhere.length === 0 : mine.length === 0)) continue;
    const given = answersOf(sites, dir, rootAnswers);
    if (!given) continue;
    const own = mine.length > 0 ? bundled.render(trees(mine), given) : undefined;
    for (const { question, template, message } of own?.errors ?? []) {
      if (question === undefined) continue;
      // The marker that holds the key is at fault, not each site that renders with it.
      const holder =
        !Object.hasOwn(config.answers, question) && Object.hasOwn(rootConfig?.answers ?? {}, question) ? '.' : dir;
      answers.add(`${join(holder, MARKER_FILE)}: \`${question}\` of ${template}: ${message}`);
    }
    const scope = root ? everywhere : mine;
    const { unused } = own && scope.length === mine.length ? own : bundled.render(trees(scope), given);
    const where = root ? 'a template that a marker of the repo lists' : 'a template it lists';
    for (const key of unused)
      if (Object.hasOwn(config.answers, key))
        keys.push(`${join(dir, MARKER_FILE)}: \`${key}\` is neither reserved nor a question or read of ${where}`);
  }
  return { keys, answers: [...answers] };
}

/**
 * The site's answers, or undefined where they cannot be told: a doubled key is
 * named by doctor already. A nested site's are the root's resolved answers
 * (given where doctor could resolve them) under its own, as `plx apply` renders it.
 */
function answersOf(
  sites: readonly MarkerSite[],
  dir: string,
  rootAnswers: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  try {
    const joined = siteAnswers(sites, dir);
    if (dir === '.' || !rootAnswers) return joined;
    return { ...rootAnswers, ...sites.find((s) => s.dir === dir)?.config?.answers };
  } catch {
    return undefined;
  }
}
