// The citable index this package carries: everything a citation can name in
// the compendium of one Plexus version, `§ <n> <code>` for every numbered
// section of the map (`PLX`) and the modules, and every requirement name
// (requirements.ts, readCitable). It is what lets `plx requirements` check a
// tenant repo's citations with no compendium in reach, against the version of
// plx the repo pins.
//
// The compendium is a repo of its own, so tooling's build never reads it:
// `plx-dev ship` writes standard-index.json from the compendium checkout in the
// workspace it cuts (where it always is; ship refuses a workspace without it)
// as part of tooling's bookkeeping, before the tag, so the published package
// carries the index of its own version and the build stays a plain build. The
// file holds methodology only, section numbers and names, never a tenant's
// substance. Between two versions it lags the compendium's main; a check
// that needs the newest sections passes --compendium <checkout>.
import data from './standard-index.json' with { type: 'json' };

/** Where ship writes the index, relative to tooling's root. */
export const STANDARD_INDEX_FILE = 'packages/lib/src/standard-index.json';

export interface StandardIndex {
  /** The Plexus version whose compendium the index was read from. */
  version: string;
  /** `§ <n> <code>` and requirement names, in page order. */
  citable: string[];
}

export const renderStandardIndex = (index: StandardIndex): string => `${JSON.stringify(index, null, 2)}\n`;

/** The index this package was published with. */
export function bundledIndex(): StandardIndex {
  const { version, citable } = data as Partial<StandardIndex>;
  if (typeof version !== 'string' || !Array.isArray(citable) || !citable.every((c) => typeof c === 'string'))
    throw new Error(`${STANDARD_INDEX_FILE} is not a citable index`);
  return { version, citable };
}
