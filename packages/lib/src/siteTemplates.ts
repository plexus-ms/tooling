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
// answers are the root marker's plus its own, and a given answer no template
// owns may satisfy a read):
//
//   a nested marker  the templates it lists itself; a key that only a template
//                    of the root marker owns belongs in the root marker, and
//                    is a finding here
//   the root marker  the templates of every marker of the repo, since the root
//                    holds the answers that nested sites' templates own or
//                    read, and shares them with every site
//   no templates     a marker that lists none is not checked: it is rendered
//                    from nothing, so no template can own its keys, yet a
//                    third-party app's marker states its `profile`
//
// A repo none of whose markers lists a template checks no key.
import { join } from 'node:path';
import { render, type Tree } from '@plexus-ms/cli-template';
import { MARKER_FILE } from './marker.ts';
import { type MarkerSite, siteAnswers } from './sites.ts';

/** The templates a plx bundles, each as the engine reads it, by the name a marker lists. */
export type Bundled = ReadonlyMap<string, Tree>;

/** The findings of the markers among `sites` against `bundled`. */
export function templateFindings(sites: readonly MarkerSite[], bundled: Bundled): string[] {
  return [...unknownNames(sites, bundled), ...unknownKeys(sites, bundled)];
}

function unknownNames(sites: readonly MarkerSite[], bundled: Bundled): string[] {
  const held = [...bundled.keys()].sort().map((name) => `\`${name}\``);
  return sites.flatMap(({ dir, config }) =>
    (config?.templates ?? [])
      .filter((name) => !bundled.has(name))
      .map(
        (name) =>
          `${join(dir, MARKER_FILE)}: \`templates\` names \`${name}\`, which this plx does not bundle (it bundles ${held.join(', ')})`,
      ),
  );
}

/** The keys of each marker that the templates its render holds neither own nor read. */
function unknownKeys(sites: readonly MarkerSite[], bundled: Bundled): string[] {
  const listed = (site: MarkerSite) => site.config?.templates ?? [];
  const trees = (names: Iterable<string>) => [...new Set(names)].flatMap((name) => bundled.get(name) ?? []);
  return sites.flatMap((site) => {
    const { dir, config } = site;
    const root = dir === '.';
    if (!config || !(root ? sites.some((s) => listed(s).length > 0) : listed(site).length > 0)) return [];
    let answers: Record<string, unknown>;
    try {
      answers = siteAnswers(sites, dir);
    } catch {
      return [];
    }
    const { unused } = render(trees(root ? sites.flatMap(listed) : listed(site)), answers);
    const scope = root ? 'a template that a marker of the repo lists' : 'a template it lists';
    return unused
      .filter((key) => Object.hasOwn(config.answers, key))
      .map((key) => `${join(dir, MARKER_FILE)}: \`${key}\` is neither reserved nor a question or read of ${scope}`);
  });
}
