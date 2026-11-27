// The marker, PLEXUS.md (§ 1.4 PLX): YAML frontmatter with an app's
// `profile` and the unit's `deviations`, then free-form prose that gives a
// reason for each deviation. A repo with display versions also states their
// `major` there (PLX-Releases), which plx-ci reads from the frontmatter by
// itself. This is the one reader of the marker; every verb that needs one
// parses it here, in one of two readings.
//
// The declaration (`parseMarker`) is what the checks read today: the
// profile and the deviations. Keys a marker of an earlier version still
// carries (`plexus`, `modules`) are not read; the declaration names them, so
// that a verb can say they can go.
//
// The configuration (`parseMarkerConfig`) is the frontmatter as the
// templates' answers, which replaces copier's answers files: the frontmatter
// is flat, `version`, `templates` and `deviations` are reserved, and every
// other key is an answer, `profile` and `major` among them. `version` is the
// Plexus version the repo's sites were last rendered at and belongs in the
// repo's root marker only, which a reader of one marker cannot tell; that is
// sites.ts's to enforce. A marker without `templates` is valid and renders
// nothing.
import { parse } from 'yaml';
import { isPlexusVersion } from './version.ts';

export interface Declaration {
  /** An app's profile as the marker states it (`stateless` or `stateful` when valid); absent when unset. */
  profile?: string;
  /** The names of the requirements the unit does not meet, e.g. `PLX-App/Stateful/MigrateService`. */
  deviations: string[];
  /** The prose after the frontmatter: what the unit is, and a reason for each deviation. */
  body: string;
  /** Keys of an earlier version's marker it still carries, which nothing reads any more. */
  obsolete?: string[];
}

/** What markers carried before the unit's kind followed from where it sits and the version from the plx pin. */
const OBSOLETE_KEYS = ['plexus', 'modules'];

export const MARKER_FILE = 'PLEXUS.md';

/**
 * A marker from its text; throws when its frontmatter does not parse,
 * `profile` is not a string, or `deviations` is not a list of names. An empty
 * `deviations:` is an empty list.
 */
export function parseMarker(text: string): Declaration {
  const { data, body } = splitFrontmatter(text);
  const { profile } = data;
  if (profile != null && typeof profile !== 'string') throw new Error('marker: `profile` must be a string');
  const listed = deviationsOf(data);
  const obsolete = OBSOLETE_KEYS.filter((k) => k in data);
  return {
    ...(profile == null ? {} : { profile }),
    deviations: listed,
    body,
    ...(obsolete.length > 0 ? { obsolete } : {}),
  };
}

/** The keys of a marker's frontmatter that are not answers. */
export const RESERVED_KEYS = ['version', 'templates', 'deviations'] as const;

/** A marker's frontmatter as configuration; a key the marker does not carry is absent. */
export interface MarkerConfig {
  /** The Plexus version the repo's sites were last rendered at; only in a repo's root marker. */
  version?: string;
  /** The templates the site is rendered from; absent in a marker that renders nothing. */
  templates?: string[];
  /** The names of the requirements the unit does not meet. */
  deviations: string[];
  /** Every key that is not reserved, by name, as the YAML gives it. */
  answers: Record<string, unknown>;
}

/**
 * A marker's frontmatter as configuration; throws when it does not parse,
 * `version` is not a Plexus version, or `templates` or `deviations` is not a
 * list of names. A key written without a value (`templates:`) is an empty list.
 */
export function parseMarkerConfig(text: string): MarkerConfig {
  const { data } = splitFrontmatter(text);
  const { version, templates } = data;
  const answers = Object.fromEntries(Object.entries(data).filter(([key]) => !isReserved(key)));
  if (version !== undefined && (typeof version !== 'string' || !isPlexusVersion(version)))
    throw new Error('marker: `version` must be a Plexus version, as in `0.131.0`');
  const listed = templates === undefined ? undefined : (templates ?? []);
  if (listed !== undefined && !isNames(listed)) throw new Error('marker: `templates` must be a list of template names');
  return {
    ...(version === undefined ? {} : { version }),
    ...(listed === undefined ? {} : { templates: listed }),
    deviations: deviationsOf(data),
    answers,
  };
}

const isReserved = (key: string): boolean => (RESERVED_KEYS as readonly string[]).includes(key);

const isNames = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

/** The frontmatter's `deviations`, none when absent or empty; throws when it is not a list of names. */
function deviationsOf(data: Record<string, unknown>): string[] {
  const listed = data.deviations ?? [];
  if (!isNames(listed)) throw new Error('marker: `deviations` must be a list of requirement names');
  return listed;
}

/** The YAML between the leading `---` lines, as a plain object, and the rest. */
export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  // A UTF-8 byte order mark, which some editors write, comes before the `---`.
  const match = /^\uFEFF?---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new Error('no frontmatter: expected a `---` block at the top');
  const data: unknown = parse(match[1] ?? '') ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('frontmatter is not a mapping');
  return { data: data as Record<string, unknown>, body: match[2] ?? '' };
}

/**
 * Whether the body gives a reason for a deviation (§ 1.4 PLX): a list item
 * that opens with the requirement's name, in backticks or bare, optionally
 * followed by a colon, and says something besides, on its first line or the
 * lines that continue it, as in
 * `` - `PLX-App/Stateful/MigrateService`: the image migrates on startup. ``
 * A longer name (`<name>-x`, `<name>/Sub`) is not the name; a name mentioned
 * further into an item, or inside fenced code, gives no reason for it.
 */
export function reasonGiven(body: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const opens = new RegExp(`^(\`?)${escaped}\\1(?![\\w/-])\\s*:?(.*)$`, 's');
  return listItems(body).some((item) => {
    const rest = opens.exec(item)?.[2];
    return rest !== undefined && /\w/.test(rest.replace(/`/g, ''));
  });
}

/** A list item's first line: its marker (`-`, `*`, `+`, `1.` or `1)`) and the text after it. */
const ITEM = /^(\s*)(?:[-*+]|\d{1,9}[.)])(\s+)(.*)$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * The text of each Markdown list item of a body, its continuation lines
 * joined to its first, in order: a line indented to the item's text, or a
 * line straight after it without a blank line between, continues it; a new
 * item, a blank line followed by a line indented less, or a fence ends it.
 * Fenced code is no item and continues none.
 */
function listItems(body: string): string[] {
  const items: string[] = [];
  let current: { text: string[]; indent: number } | undefined;
  let blank = false;
  let fence: string | undefined;
  const close = () => {
    if (current) items.push(current.text.join(' '));
    current = undefined;
  };
  for (const line of body.split(/\r?\n/)) {
    const fenced = FENCE.exec(line)?.[1];
    if (fence) {
      if (fenced === fence) fence = undefined;
      continue;
    }
    if (fenced) {
      close();
      fence = fenced;
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      close();
      const [, lead = '', gap = '', text = ''] = item;
      current = { text: [text.trim()], indent: lead.length + line.slice(lead.length).indexOf(gap) + gap.length };
      blank = false;
    } else if (line.trim() === '') blank = true;
    else if (current && (!blank || line.length - line.trimStart().length >= current.indent)) {
      current.text.push(line.trim());
      blank = false;
    } else close();
  }
  close();
  return items;
}
