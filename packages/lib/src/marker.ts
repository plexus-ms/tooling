// The marker, PLEXUS.md (§ 1.4 PLX): YAML frontmatter with an app's
// `profile` and the unit's `deviations`, then free-form prose that gives a
// reason for each deviation. This is the one reader of that shape; every verb
// that needs a marker parses it here. Neither what a unit follows nor the
// Plexus version is in a marker: a unit is bound by the contracts by being a
// repo or an app, and a repo is on the version its `plx` pin names (§ 1.5 PLX).
// Keys a marker of an earlier version still carries are not read.
import { parse } from 'yaml';

export interface Declaration {
  /** An app's profile as the marker states it (`stateless` or `stateful` when valid); absent when unset. */
  profile?: string;
  /** The names of the requirements the unit does not meet, e.g. `PLX-App/Stateful/MigrateService`. */
  deviations: string[];
  /** The prose after the frontmatter: what the unit is, and a reason for each deviation. */
  body: string;
}

export const MARKER_FILE = 'PLEXUS.md';

/** A marker from its text; throws when its frontmatter does not parse or `deviations` is not a list of names. */
export function parseMarker(text: string): Declaration {
  const { data, body } = splitFrontmatter(text);
  const { profile, deviations = [] } = data;
  if (!Array.isArray(deviations) || !deviations.every((d) => typeof d === 'string'))
    throw new Error('marker: `deviations` must be a list of requirement names');
  return { ...(profile == null ? {} : { profile: String(profile) }), deviations, body };
}

/** The YAML between the leading `---` lines, as a plain object, and the rest. */
export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new Error('no frontmatter: expected a `---` block at the top');
  const data: unknown = parse(match[1] ?? '') ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('frontmatter is not a mapping');
  return { data: data as Record<string, unknown>, body: match[2] ?? '' };
}

/**
 * Whether the body gives a reason for a deviation: a bullet that names it
 * and says something besides (§ 1.4 PLX), as in
 * `` - `PLX-App/Stateful/MigrateService`: the image migrates on startup. ``
 */
export function reasonGiven(body: string, name: string): boolean {
  const named = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/])`);
  return body.split('\n').some((line) => {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)?.[1];
    return bullet !== undefined && named.test(bullet) && /\w/.test(bullet.replace(named, '').replace(/`/g, ''));
  });
}
