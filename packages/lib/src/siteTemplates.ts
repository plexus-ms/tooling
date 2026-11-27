// The markers against the templates this plx bundles: what `plx doctor` checks
// of a repo that has crossed over (doctor.ts) once it has the templates. Each
// finding is a line naming the marker it concerns.
//
// `templates` names only templates the bundle holds. A name it lacks is a
// finding and the name is left out of the rest.
import { join } from 'node:path';
import type { Tree } from '@plexus-ms/cli-template';
import { MARKER_FILE } from './marker.ts';
import type { MarkerSite } from './sites.ts';

/** The templates a plx bundles, each as the engine reads it, by the name a marker lists. */
export type Bundled = ReadonlyMap<string, Tree>;

/** The findings of the markers among `sites` against `bundled`. */
export function templateFindings(sites: readonly MarkerSite[], bundled: Bundled): string[] {
  return unknownNames(sites, bundled);
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
