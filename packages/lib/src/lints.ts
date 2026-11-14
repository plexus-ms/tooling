// The four lints that keep one home per fact, run by `plx requirements` over a
// repo's tracked files (requirements.ts says which run where):
//
//   date-or-version  no date and no version number in the compendium's prose;
//                    frontmatter and code, fenced or inline, are exempt
//   citations        every section citation names a numbered section that
//                    exists, `§ n PLX-Module` or `PLX-Module § n` (`PLX` for
//                    the map), and on a page of the compendium a bare `§ n`
//                    names one of the page's own; every requirement name,
//                    `PLX-<Module>[/<Profile>]/<Name>`, a named requirement line
//   template-header  a template file opens with at most two comment lines
//   issue-id         no issue identifier: three capitals, a dash and digits;
//                    module codes (`PLX-App`, a dash and a word) pass
//
// Each lint is a pure function of a file's text and reports violations with a
// stable key, `<lint> <file>: <excerpt>`, that a baseline records (baseline.ts):
// the excerpt is the offending text, not the line number, so an edit elsewhere
// in the file does not move the key.

export type LintId = 'date-or-version' | 'citations' | 'template-header' | 'issue-id';

export interface Violation {
  lint: LintId;
  /** Relative to the repo root. */
  file: string;
  /** 1-based. */
  line: number;
  /** The offending text; with lint and file, the baseline key. */
  excerpt: string;
  /** What is wrong, for a human. */
  message: string;
}

/** The baseline key of a violation: no line number, so it survives edits elsewhere in the file. */
export const keyOf = (v: Violation): string => `${v.lint} ${v.file}: ${v.excerpt}`;

export const renderViolation = (v: Violation): string => `✗ ${v.file}: line ${v.line}: ${v.message}`;

const lineAt = (text: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
};

/** Every match of a global pattern, with its 1-based line. */
function* matches(text: string, pattern: RegExp): Generator<{ match: RegExpExecArray; line: number }> {
  for (const match of text.matchAll(pattern)) yield { match, line: lineAt(text, match.index) };
}

// --- date-or-version: no date and no version number in compendium prose ------------------

const MONTH =
  'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const YEAR = '(?:19|20)\\d{2}';

/**
 * What reads as a date or a version number. Section numbers (`§ 1.2`), IP
 * addresses (four dotted parts), `0.x`, RFC numbers, port numbers and other
 * bare integers do not: a version is three dotted parts, or a number after
 * `v` or `@`; a year counts only in a date, after a month, or after a word
 * that makes it one ("in 2026", "since 2025"). `1.0.0` is semver's line
 * between unstable and stable, a concept rather than a release, and passes.
 * Two dotted parts are a decimal as often as a version (`1.42 GiB`), and a
 * product's version after its name (`Debian 13`, `Safari 26.1`) is not told
 * apart from any other number: neither is caught.
 */
const DATE_OR_VERSION = new RegExp(
  [
    // 2026-11-04, 2026-07, 2026-11-04T10:00Z
    `(?<![\\w-])${YEAR}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\\d|3[01])(?:T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?)?(?![\\w-])`,
    // November 2026, Nov. 4, 2026
    `\\b(?:${MONTH})\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?${YEAR}\\b`,
    // in 2026, since 2025, Q3 2026
    `\\b(?:[Ii]n|[Ss]ince|[Uu]ntil|[Tt]ill|[Aa]s of|[Bb]efore|[Aa]fter|[Dd]uring|[Ee]arly|[Mm]id|[Ll]ate|Q[1-4])\\s+${YEAR}\\b(?![.,]?\\d)`,
    // 0.111.0, 1.2.3-rc.1; not the dotted parts of an IP address, not a section number
    '(?<![\\w.§]|§\\s*)(?!1\\.0\\.0(?![\\w-]|\\.\\d))\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?(?!\\.?\\d)',
    // v24, v1.48
    '(?<![\\w./-])v\\d+(?:\\.\\d+)*\\b',
    // pnpm@12, hk@1.48 (three parts are caught above)
    '(?<=@)\\d+(?:\\.\\d+)?\\b(?!\\.\\d)',
  ].join('|'),
  'g',
);

/** The prose of a Markdown page: its text with frontmatter, fenced code blocks and code spans blanked, lines kept in place. */
export function proseOf(text: string): string {
  const lines = text.split('\n');
  let i = 0;
  if (lines[0] === '---') {
    const end = lines.findIndex((l, n) => n > 0 && l === '---');
    if (end !== -1) for (; i <= end; i++) lines[i] = '';
  }
  let fence: string | undefined;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const opener = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined && opener) {
      fence = opener;
      lines[i] = '';
    } else if (fence !== undefined) {
      if (opener?.startsWith(fence[0] ?? '') && opener.length >= fence.length && line.trim() === opener)
        fence = undefined;
      lines[i] = '';
    } else lines[i] = line.replace(/(`+)[^\n]*?\1/g, (span) => ' '.repeat(span.length));
  }
  return lines.join('\n');
}

export function lintDateOrVersion(text: string, file: string): Violation[] {
  return [...matches(proseOf(text), DATE_OR_VERSION)].map(({ match, line }) => ({
    lint: 'date-or-version',
    file,
    line,
    excerpt: match[0],
    message: `a date or version number in prose goes stale; say it once where it is maintained: ${match[0]}`,
  }));
}

// --- citations: every cited section and requirement name exists -----------------

/** A module code, or `PLX` for the map. */
const CODE = 'PLX(?:-[A-Z][A-Za-z]+)?(?![A-Za-z])';
const NUMBER = '\\d+(?:\\.\\d+)*';
/** One section number or several: `2`, `2 and 5`, `2, 3 or 6`, `2–4` (a range: its two ends are checked). */
const NUMBERS = `${NUMBER}(?:[ \\t\\u00a0]*(?:,|and|or|&|–|-|to)[ \\t\\u00a0]*${NUMBER})*`;
/** Between the numbers and the code: blanks, or a line break with a comment or blockquote marker. */
const GAP = '(?:[ \\t\\u00a0]+|[ \\t]*\\r?\\n[ \\t]*(?:#+|//+|\\*|>)?[ \\t]*)';
const SIGN = `(?<!§)§§?[ \\t\\u00a0]*`;

/** `PLX-<Module>/<Name>` or `PLX-<Module>/<Profile>/<Name>`, each segment capitalised as a module code's word is. */
export const REQUIREMENT_NAME = 'PLX-[A-Z][A-Za-z]+(?:/[A-Z][A-Za-z0-9]*){1,2}';
/** Anything shaped like a name, well-formed or not: a lowercase segment, four segments. */
const NAME_LIKE = 'PLX-[A-Z][A-Za-z]+(?:/[\\w-]+)+';

/** `§ 2 PLX-App`, `§§ 2 and 5 PLX-Delivery`, `§§ 2–4 PLX-Delivery`, wrapped onto a comment line or not. */
const FORWARD = new RegExp(`${SIGN}(${NUMBERS})${GAP}(${CODE})`, 'g');
/** `PLX-CLI § 1`, `(PLX-Delivery, § 8)`. */
const REVERSE = new RegExp(`(?<![\\w-])(${CODE})[ \\t\\u00a0]*,?[ \\t\\u00a0]*${SIGN}(${NUMBERS})`, 'g');
/** `§ 2`, `§§ 2 and 3`, with no code on either side: the page's own sections. */
const BARE = new RegExp(`${SIGN}(${NUMBERS})`, 'g');
const NAME_CITATION = new RegExp(`(?<![\\w/-])${NAME_LIKE}(?![\\w/])`, 'g');

/** The citable facts of one Plexus version: `§ <n> <code>` for every numbered section, and every requirement name. */
export type Citable = ReadonlySet<string>;

const sectionKey = (n: string, code: string): string => `§ ${n} ${code}`;
const numbersOf = (list: string): string[] => list.match(new RegExp(NUMBER, 'g')) ?? [];

/**
 * The citations in a file that name nothing. `own` is the code a bare `§ n`
 * stands for: the page's own, on a page of the compendium (`PLX` on the map);
 * elsewhere a bare `§ n` has no page and is not checked.
 */
export function lintCitations(text: string, file: string, citable: Citable, own?: string): Violation[] {
  const codes = new Set([...citable].filter((c) => c.startsWith('§ ')).map((c) => c.replace(/^§ \S+ /, '')));
  const out: Violation[] = [];
  const sections = (list: string, code: string, line: number) => {
    for (const n of numbersOf(list)) {
      const excerpt = sectionKey(n, code);
      if (citable.has(excerpt)) continue;
      const message = codes.has(code)
        ? `${excerpt} cites a section that does not exist`
        : `${excerpt} cites ${code}, which is no module`;
      out.push({ lint: 'citations', file, line, excerpt, message });
    }
  };
  // A sign belongs to the first reading that takes it: a code after the
  // numbers, then a code before them, then the page itself. So a code, a
  // comma and a bare sign read as a reverse citation even where the sign
  // means the page's own section: "it consumes <code>, § <n> says how" is read
  // as section <n> of <code>, not of the page.
  const taken = new Set<number>();
  const signAt = (m: RegExpExecArray) => m.index + m[0].indexOf('§');
  for (const { match, line } of matches(text, FORWARD)) {
    taken.add(signAt(match));
    sections(match[1] ?? '', match[2] ?? '', line);
  }
  for (const { match, line } of matches(text, REVERSE)) {
    if (taken.has(signAt(match))) continue;
    taken.add(signAt(match));
    sections(match[2] ?? '', match[1] ?? '', line);
  }
  if (own)
    for (const { match, line } of matches(text, BARE)) {
      const at = signAt(match);
      const lineStart = text.lastIndexOf('\n', at) + 1;
      if (taken.has(at) || /^#+[ \t]*$/.test(text.slice(lineStart, at))) continue; // a heading defines, not cites
      sections(match[1] ?? '', own, line);
    }
  const wellFormed = new RegExp(`^${REQUIREMENT_NAME}$`);
  for (const { match, line } of matches(text, NAME_CITATION)) {
    const name = match[0];
    if (!wellFormed.test(name))
      out.push({
        lint: 'citations',
        file,
        line,
        excerpt: name,
        message: `${name} is no requirement name: PLX-<Module>[/<Profile>]/<Name>, each segment capitalised`,
      });
    else if (!citable.has(name))
      out.push({ lint: 'citations', file, line, excerpt: name, message: `${name} names no requirement line` });
  }
  return out.sort((a, b) => a.line - b.line);
}

// --- template-header: at most two comment lines at the top of a template file -----

export const MAX_HEADER_LINES = 2;

/** The comment syntax of a template file by its extension; a `.jinja` file has Jinja's comments too. Markdown has only HTML comments. */
function commentSyntax(file: string): { line?: RegExp; blocks: [string, string][] } {
  const jinja: [string, string][] = file.endsWith('.jinja') ? [['{#', '#}']] : [];
  const name = file.replace(/\.jinja$/, '');
  if (/\.(md|mdx|html)$/.test(name)) return { blocks: [['<!--', '-->'], ...jinja] };
  if (/\.(ts|tsx|js|jsx|mjs|cjs|css|json|jsonc|pkl)$/.test(name))
    return { line: /^\/\//, blocks: [['/*', '*/'], ...jinja] };
  return { line: /^#(?!!)/, blocks: jinja };
}

const JINJA_TAG = /\{%-?[\s\S]*?-?%\}/g;

/** Lines (Jinja tags removed) that open a file without being content: a shebang, a parser directive, a YAML document start. */
const isPreamble = (line: string): boolean =>
  /^#!/.test(line) || /^#\s*(syntax|escape|check)\s*=/.test(line) || line === '---';

/**
 * The number of comment lines a template file's header holds. The header is
 * the first comment block, line comments and block comments counted line by
 * line, when no more than one line of content precedes it (the one line a
 * workflow names itself with, `name: on_pr`). A later block, after blank
 * lines, counts as well when a blank line (or the end of the file) follows it:
 * a blank line cannot split a long header. A later block directly above a line
 * of content is that content's own comment; it does not count, and the header
 * ends there, as it does at any line of content. After the header has begun, a
 * line that holds only a Jinja tag is content, not a blank line: a comment above
 * `{% if x %}` is the comment of the block it opens. Before it, such a line is
 * skipped like a blank one.
 */
export function headerLines(text: string, file: string): number {
  const syntax = commentSyntax(file);
  const raw = text.split('\n').map((l) => l.trim());
  const lines = raw.map((l) => l.replace(JINJA_TAG, '').trim());
  /** A line that held only a Jinja tag (`{% if x %}`): content to the header's end, though nothing is left of it. */
  const jinjaOnly = (n: number): boolean => (lines[n] ?? '') === '' && (raw[n] ?? '') !== '';
  /** Where the comment block that starts at line `i` ends (exclusive); `i` when that line is no comment. */
  const blockEnd = (i: number): number => {
    let j = i;
    for (;;) {
      const line = lines[j] ?? '';
      const block = line === '' ? undefined : syntax.blocks.find(([open]) => line.startsWith(open));
      if (block) {
        const [open, close] = block;
        let k = j;
        while (k < lines.length - 1 && !(lines[k] ?? '').includes(close, k === j ? open.length : 0)) k++;
        j = k + 1;
      } else if (line !== '' && syntax.line?.test(line)) j++;
      else return j;
    }
  };
  let i = 0;
  let content = 0;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line === '' || isPreamble(line)) continue;
    if (blockEnd(i) > i) break;
    if (++content > 1) return 0;
  }
  if (i >= lines.length) return 0;
  let end = blockEnd(i);
  let count = end - i;
  for (i = end; i < lines.length; ) {
    if ((lines[i] ?? '') === '' && !jinjaOnly(i)) {
      i++;
      continue;
    }
    end = blockEnd(i);
    if (end === i || (lines[end] ?? '') !== '' || jinjaOnly(end)) break;
    count += end - i;
    i = end;
  }
  return count;
}

export function lintTemplateHeader(text: string, file: string): Violation[] {
  const n = headerLines(text, file);
  if (n <= MAX_HEADER_LINES) return [];
  return [
    {
      lint: 'template-header',
      file,
      line: 1,
      excerpt: `${n} header comment lines`,
      message: `${n} header comment lines; a template file opens with at most ${MAX_HEADER_LINES}, and the rest lives in the compendium`,
    },
  ];
}

// --- issue-id: no reference to the issue tracker -------------------------------

/**
 * An issue identifier as any tracker writes it: exactly three capitals, a
 * dash, digits; no tracker's key is named here. A module code passes, its dash
 * being followed by a word. A dash after the digits does not save one (a
 * branch slug that opens with an identifier names the issue all the same);
 * lowercase does, as slugs, CSS classes and the like are lowercase.
 */
const ISSUE_ID = /(?<![\w])([A-Z]{3})-\d+(?![\w])/g;

/**
 * The standard tokens of an identifier's shape, by prefix: these five and no
 * other, fixed here and read from no configuration. Anything else of the shape
 * that is no issue identifier is renamed, or sits in its repo's baseline.
 */
const STANDARD_PREFIXES = new Set([
  'SHA', // hash functions: SHA-256
  'UTF', // character encodings: UTF-8
  'GPL', // licence identifiers: GPL-3.0-or-later
  'PDF', // format versions: PDF-1.4
  'ADR', // architecture decision records: ADR-0009
]);

export function lintIssueIds(text: string, file: string): Violation[] {
  return [...matches(text, ISSUE_ID)]
    .filter(({ match }) => !STANDARD_PREFIXES.has(match[1] ?? ''))
    .map(({ match, line }) => ({
      lint: 'issue-id',
      file,
      line,
      excerpt: match[0],
      message: `${match[0]} reads as an issue identifier; say what it means instead`,
    }));
}

/** The characters git picks from under `core.commentChar=auto`, in its order. */
const AUTO_COMMENT_CHARS = '#;@!$%^&|:';

/**
 * A commit message's issue identifiers. Every line counts, comment lines too:
 * under `git commit -m` git keeps them. What git adds itself is left out: its
 * template, from the "Please enter the commit message" line on (it names the
 * branch), and everything below a scissors line, both recognised by the
 * repo's comment character (`core.commentChar`, read by the caller; under
 * `auto`, any character git may pick). Git writes that template in the user's
 * language; under another locale its lines are linted too.
 */
export function lintCommitMessage(text: string, comment = '#'): Violation[] {
  const chars = comment === 'auto' ? [...AUTO_COMMENT_CHARS] : [comment];
  const ends = chars
    .flatMap((c) => {
      const q = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return [new RegExp(`^${q} -+ >8 -+$`, 'm'), new RegExp(`^${q} Please enter the commit message`, 'm')];
    })
    .map((p) => text.search(p))
    .filter((n) => n !== -1);
  return lintIssueIds(ends.length > 0 ? text.slice(0, Math.min(...ends)) : text, 'commit message');
}
