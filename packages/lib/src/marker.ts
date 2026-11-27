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
//
// The one writer of a marker's keys is `setMarkerKeys`. It never re-serialises
// the frontmatter, which a human wrote: it splices the text of each key it
// sets, so that comments, order, quoting and blank lines, and the body, stay
// as they were.
import { isDeepStrictEqual } from 'node:util';
import {
  Document,
  isAlias,
  isCollection,
  isMap,
  isNode,
  isScalar,
  type Node,
  parse,
  parseDocument,
  visit,
  type YAMLMap,
} from 'yaml';
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
  const { yaml, body } = frontmatterOf(text);
  const data: unknown = parse(yaml) ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('frontmatter is not a mapping');
  return { data: data as Record<string, unknown>, body };
}

// A UTF-8 byte order mark, which some editors write, comes before the `---`.
const FRONTMATTER = /^(\uFEFF?---\r?\n)((?:[\s\S]*?\r?\n)?)---(?:\r?\n|$)/;

/**
 * A page's frontmatter: the YAML between the `---` lines, ending in its line
 * break or empty, the offset it starts at, the line break the page uses, and
 * the body after the closing `---` line.
 */
function frontmatterOf(text: string): { yaml: string; start: number; eol: string; body: string } {
  const match = FRONTMATTER.exec(text);
  if (!match) throw new Error('no frontmatter: expected a `---` block at the top');
  const [all, open = '', yaml = ''] = match;
  return { yaml, start: open.length, eol: open.endsWith('\r\n') ? '\r\n' : '\n', body: text.slice(all.length) };
}

/**
 * The marker with the given frontmatter keys set, and every other byte as it
 * was: the body, the other keys, comments, quoting, spacing, blank lines and
 * line breaks. A value already so leaves the text as it is. A replaced value
 * keeps the style it was written in (a block or a flow list, a quoted
 * string), and the comment on its key line; on one line also the spacing
 * around it. Comments inside a replaced block value, between or after its
 * items, go with it. A new reserved key goes ahead of the answers in the
 * order of RESERVED_KEYS, above the comment of the key it precedes, a new
 * answer last; a new value is written on one line, a list as a flow list
 * (`[a, b]`). A key is set, never removed.
 *
 * Where a splice could change what it does not set, it throws rather than
 * guess, naming the key: a page without frontmatter, a frontmatter that is
 * not a block mapping or ends its YAML early (`...`), an explicit key
 * (`? a`), a value with a tag of its own, an alias, or a value carrying an
 * anchor that an alias refers to.
 */
export function setMarkerKeys(text: string, keys: Record<string, unknown>): string {
  const { yaml, start, eol } = frontmatterOf(text);
  let written = yaml;
  for (const [key, value] of Object.entries(keys)) {
    if (value === undefined) throw new Error(`marker: no value for \`${key}\`; a key is set, never removed`);
    written = setKey(written, key, value, eol);
  }
  return text.slice(0, start) + written + text.slice(start + yaml.length);
}

/** How a written value is serialised: on one line however long, flow lists without padding. */
const STYLE = { lineWidth: 0, flowCollectionPadding: false } as const;

/**
 * One key set in a frontmatter's YAML (ending in a line break, or empty) by
 * splicing its text; a line written ends in `eol`, the page's line break.
 */
function setKey(yaml: string, key: string, value: unknown, eol: string): string {
  const doc = parseDocument(yaml);
  if (doc.errors.length > 0) throw new Error(`frontmatter is not YAML: ${doc.errors[0]?.message}`);
  const map = doc.contents;
  if (map !== null && !isMap(map)) throw new Error('frontmatter is not a mapping');
  if (map?.flow) throw new Error('frontmatter is a flow mapping (`{…}`); write it as a block mapping');
  // A line after `...` would be a YAML document of its own.
  if (/^\.\.\.(?:[ \t]|\r?$)/m.test(yaml))
    throw new Error('frontmatter ends its YAML document early with `...`; remove that line');
  const pairs = map?.items ?? [];
  const pair = pairs.find((p) => nameOf(p) === key);
  return pair
    ? replaceValue(yaml, doc, pair, key, value, eol)
    : insertKey(yaml, pairs, key, doc.createNode(value), eol);
}

type Pair = NonNullable<YAMLMap['items'][number]>;

const nameOf = (pair: Pair): string | undefined => (isScalar(pair.key) ? String(pair.key.value) : undefined);

/**
 * A key the frontmatter lacks, on a line of its own: a reserved key before
 * the first key that is an answer or a later reserved key, and above the
 * comment lines directly over that key, which are about it; an answer last.
 */
function insertKey(yaml: string, pairs: readonly Pair[], key: string, node: Node, eol: string): string {
  forOneLine(node);
  const rank = RESERVED_KEYS.indexOf(key as (typeof RESERVED_KEYS)[number]);
  const next =
    rank === -1
      ? undefined
      : pairs.find((p) => {
          const other = RESERVED_KEYS.indexOf(nameOf(p) as (typeof RESERVED_KEYS)[number]);
          return other === -1 || other > rank;
        });
  const at =
    isNode(next?.key) && next.key.range ? aboveComments(yaml, lineStart(yaml, next.key.range[0])) : yaml.length;
  // At the column the mapping's keys are at, which is 0 unless the whole frontmatter is indented.
  const first = pairs[0]?.key;
  const indent = isNode(first) && first.range ? yaml.slice(lineStart(yaml, first.range[0]), first.range[0]) : '';
  const column = /^ */.exec(indent)?.[0].length ?? 0;
  return yaml.slice(0, at) + ' '.repeat(column) + pairText(key, node, eol) + yaml.slice(at);
}

/**
 * The value of a key the frontmatter has, in the style of the old one; the
 * text as it is when already so. A block list or mapping replaced by one
 * that has items keeps its key line; every other value goes on one line.
 */
function replaceValue(yaml: string, doc: Document, pair: Pair, key: string, value: unknown, eol: string): string {
  const old = pair.value;
  if (!isNode(old) || !old.range || !isNode(pair.key) || !pair.key.range)
    throw new Error(`marker: \`${key}\` has no value plx can replace`);
  const [from, to] = old.range;
  // The key starts its line, and its colon follows it there: not an explicit key (`? a` above `: value`).
  const [keyStart, keyEnd] = pair.key.range;
  const colon = /^[ \t]*:/.exec(yaml.slice(keyEnd))?.[0];
  if (colon === undefined || yaml.slice(lineStart(yaml, keyStart), keyStart).trim() !== '')
    throw new Error(`marker: \`${key}\` is not written as \`${key}: value\` on a line of its own; set it by hand`);
  const colonEnd = keyEnd + colon.length;
  refuseShared(doc, old, key);
  // A tag stands before the value's range and would stay, typing the new value as the old one.
  if (old.tag !== undefined) {
    const tag = /!\S*/.exec(yaml.slice(colonEnd, from))?.[0] ?? old.tag;
    throw new Error(`marker: \`${key}\` carries the tag \`${tag}\`; set it by hand`);
  }
  if (isDeepStrictEqual(old.toJSON(), value)) return yaml;
  const node = doc.createNode(value);

  if (isCollection(old) && !old.flow) {
    // The items start on the lines below the key line, which stays as it is, comment and all. New items
    // take the old ones' lines, indented as they were: the column of the first item (`- a`) or key, and
    // a sequence at column 0 not indented at all. A value without items goes on the key line instead.
    const below = lastLineEnd(yaml, colonEnd);
    const rest = yaml.slice(lastLineEnd(yaml, to));
    if (isCollection(node) && node.items.length > 0) {
      const column = from - lineStart(yaml, from);
      const indent = column > 0 ? { indent: column, indentSeq: true } : { indentSeq: false };
      const written = pairText(key, node, eol, indent);
      return yaml.slice(0, below) + written.slice(written.indexOf('\n') + 1) + rest;
    }
    return onKeyLine(yaml.slice(0, below) + rest, key, colonEnd, colonEnd, oneLine(node, old, key));
  }
  if (isScalar(old) && (old.type === 'BLOCK_LITERAL' || old.type === 'BLOCK_FOLDED')) {
    // A block scalar's header (`|`, `>-`) is on the key line, its text on the lines below: both go, and the
    // value takes the header's place, before the comment the header line may have.
    if (yaml.slice(colonEnd, from).trim() !== '')
      throw new Error(`marker: \`${key}\` holds more than a value; set it by hand`);
    const header = /^[|>][-+0-9]*/.exec(yaml.slice(from))?.[0].length ?? 0;
    const rest = yaml.slice(lastLineEnd(yaml, to));
    const written = yaml.slice(0, from) + yaml.slice(from + header, lastLineEnd(yaml, from)) + rest;
    return onKeyLine(written, key, colonEnd, colonEnd, oneLine(node, old, key));
  }
  // A key written without a value (`key:`) has an empty range where the value would start: before a
  // comment, or at the line's end. The value goes right after the colon instead.
  if (from === to) return onKeyLine(yaml, key, colonEnd, from, oneLine(node, old, key));
  return yaml.slice(0, from) + oneLine(node, old, key) + yaml.slice(to);
}

/**
 * Throws when the value is an alias (`*x`), or carries an anchor (`&x`) an
 * alias elsewhere refers to: setting it would change another key, or a key
 * written as the same value as another.
 */
function refuseShared(doc: Document, value: Node, key: string): void {
  if (isAlias(value)) throw new Error(`marker: \`${key}\` is an alias of another value; set it by hand`);
  const referred = new Set<string>();
  visit(doc, { Alias: (_, alias) => void referred.add(alias.source) });
  visit(value, {
    Node: (_, node) => {
      if (node.anchor && referred.has(node.anchor))
        throw new Error(
          `marker: \`${key}\` carries the anchor \`${node.anchor}\`, which an alias refers to; set it by hand`,
        );
    },
  });
}

/** Quotings a new string can take over from the one it replaces; a block scalar spans lines. */
const ONE_LINE_STRINGS = ['PLAIN', 'QUOTE_SINGLE', 'QUOTE_DOUBLE'];

/** A new value made to render on one line: lists and mappings in flow style, a string with a line break double-quoted. */
function forOneLine(node: Node): void {
  if (isCollection(node)) node.flow = true;
  visit(node, {
    Scalar: (_, scalar) => {
      if (typeof scalar.value === 'string' && scalar.value.includes('\n')) scalar.type = 'QUOTE_DOUBLE';
    },
  });
}

/** A value as text on one line (`forOneLine`), a string replacing a string quoted as that one was. */
function oneLine(node: Node, old: Node, key: string): string {
  forOneLine(node);
  if (isScalar(node) && isScalar(old) && typeof node.value === 'string' && typeof old.value === 'string')
    if (!node.value.includes('\n') && ONE_LINE_STRINGS.includes(old.type ?? '')) node.type = old.type;
  // Rendered as the value of a stand-in key, not as a document of its own, where `---` is no plain string.
  const text = pairText('k', node, '\n').replace(/^k: |\n$/g, '');
  if (text.includes('\n')) throw new Error(`marker: the value for \`${key}\` does not fit on one line`);
  return text;
}

/**
 * The key line with `inline` as its value, one space after the colon that
 * ends at `colonEnd`; what the line holds from `rest` on may only be a
 * comment, which stays after the value.
 */
function onKeyLine(yaml: string, key: string, colonEnd: number, rest: number, inline: string): string {
  const end = lineBreakAt(yaml, rest);
  const comment = yaml.slice(rest, end).trim();
  if (comment !== '' && !comment.startsWith('#'))
    throw new Error(`marker: \`${key}\` holds \`${comment}\` on its line besides a value; set it by hand`);
  const value = comment === '' ? inline : `${inline} ${comment}`;
  return `${yaml.slice(0, colonEnd)} ${value}${yaml.slice(end)}`;
}

/** `key: value` and a line break, each line ending in `eol`. */
function pairText(
  key: string,
  node: unknown,
  eol: string,
  options: { indent?: number; indentSeq?: boolean } = {},
): string {
  const doc = new Document({ [key]: null });
  doc.set(key, node);
  return doc.toString({ ...STYLE, ...options }).replace(/\n/g, eol);
}

/** The start of the run of comment lines directly above the line at `at`, or `at` itself; a blank line ends the run. */
function aboveComments(text: string, at: number): number {
  let start = at;
  while (start > 0) {
    const previous = lineStart(text, start - 1);
    if (!text.slice(previous, start).trimStart().startsWith('#')) break;
    start = previous;
  }
  return start;
}

/** Where the line holding `at` starts. */
const lineStart = (text: string, at: number): number => text.lastIndexOf('\n', at - 1) + 1;

/** Where the line holding `at` ends, before its line break (`\n` or `\r\n`), or the end of the text. */
function lineBreakAt(text: string, at: number): number {
  const lineBreak = text.indexOf('\n', at);
  if (lineBreak === -1) return text.length;
  return text[lineBreak - 1] === '\r' ? lineBreak - 1 : lineBreak;
}

/**
 * Where the line that a range ending at `to` ends on is over, past its line
 * break: `to` itself when the range took the line break (a block value
 * does), else past the next one, or the end of a text that has none.
 */
function lastLineEnd(text: string, to: number): number {
  if (text[to - 1] === '\n') return to;
  const lineBreak = text.indexOf('\n', to);
  return lineBreak === -1 ? text.length : lineBreak + 1;
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
