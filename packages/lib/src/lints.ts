// The four lints that keep one home per fact, run by `plx requirements` over a
// repo's tracked files (requirements.ts says which run where):
//
//   date-or-version  no date and no version number in the compendium's prose;
//                    frontmatter and code, fenced or inline, are exempt
//   citations        every `§ n PLX-Module` (or `§ n PLX`, the map) names a
//                    numbered section that exists, and every requirement name
//                    `PLX-Module[/Profile]/Name` a named requirement line
//   template-header  a template file opens with at most two comment lines
//   issue-id         no issue identifier, a tracker key, a dash and digits;
//                    module codes (`PLX-App`, a key, a dash and a word) pass
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
    // 2026-11-04, 2026-07
    `(?<![\\w-])${YEAR}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\\d|3[01]))?(?![\\w-])`,
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
/** Between a section number and the code: blanks, or a line break with a comment or blockquote marker. */
const GAP = '(?:[ \\t\\u00a0]+|[ \\t]*\\r?\\n[ \\t]*(?:#+|//+|\\*|>)?[ \\t]*)';

/** `PLX-<Module>/<Name>` or `PLX-<Module>/<Profile>/<Name>`: the name segments capitalised, as module codes are. */
export const REQUIREMENT_NAME = 'PLX-[A-Z][A-Za-z]+(?:/[A-Z][A-Za-z0-9]*){1,2}';

const SECTION_CITATION = new RegExp(`(?<!§)§[ \\t\\u00a0]*(${NUMBER})${GAP}(${CODE})`, 'g');
/** `§§ 2 and 5 PLX-Delivery`, `§§ 2, 3 and 6 PLX-Delivery`. */
const SECTIONS_CITATION = new RegExp(
  `§§[ \\t\\u00a0]*(${NUMBER}(?:\\s*(?:,|and|or|&)\\s*${NUMBER})+)${GAP}(${CODE})`,
  'g',
);
const NAME_CITATION = new RegExp(`(?<![\\w/-])${REQUIREMENT_NAME}(?![\\w/])`, 'g');

/** The citable facts of one Plexus version: `§ <n> <code>` for every numbered section, and every requirement name. */
export type Citable = ReadonlySet<string>;

const sectionKey = (n: string, code: string): string => `§ ${n} ${code}`;

export function lintCitations(text: string, file: string, citable: Citable): Violation[] {
  const codes = new Set([...citable].filter((c) => c.startsWith('§ ')).map((c) => c.replace(/^§ \S+ /, '')));
  const out: Violation[] = [];
  const section = (n: string, code: string, line: number) => {
    if (citable.has(sectionKey(n, code))) return;
    const excerpt = sectionKey(n, code);
    const message = codes.has(code)
      ? `${excerpt} cites a section that does not exist`
      : `${excerpt} cites ${code}, which is no module`;
    out.push({ lint: 'citations', file, line, excerpt, message });
  };
  for (const { match, line } of matches(text, SECTION_CITATION)) section(match[1] ?? '', match[2] ?? '', line);
  for (const { match, line } of matches(text, SECTIONS_CITATION))
    for (const n of (match[1] ?? '').split(/\s*(?:,|and|or|&)\s*/)) section(n, match[2] ?? '', line);
  for (const { match, line } of matches(text, NAME_CITATION))
    if (!citable.has(match[0]))
      out.push({
        lint: 'citations',
        file,
        line,
        excerpt: match[0],
        message: `${match[0]} names no requirement line`,
      });
  return out.sort((a, b) => a.line - b.line);
}

// --- template-header: at most two comment lines at the top of a template file -----

export const MAX_HEADER_LINES = 2;

/** The comment syntax of a template file by its extension, `.jinja` set aside; Markdown has only HTML comments. */
function commentSyntax(file: string): { line?: RegExp; block?: [string, string] } {
  const name = file.replace(/\.jinja$/, '');
  if (/\.(md|mdx|html)$/.test(name)) return { block: ['<!--', '-->'] };
  if (/\.(ts|tsx|js|jsx|mjs|cjs|css|json|jsonc)$/.test(name)) return { line: /^\s*\/\//, block: ['/*', '*/'] };
  if (/\.pkl$/.test(name)) return { line: /^\s*\/\//, block: ['/*', '*/'] };
  return { line: /^\s*#(?!!)/ };
}

const JINJA_TAG = /\{%-?[\s\S]*?-?%\}/g;

/** Lines (Jinja tags removed) that open a file without being content: blank, a shebang, a parser directive, a YAML document start. */
const isPreamble = (line: string): boolean =>
  line === '' || /^#!/.test(line) || /^#\s*(syntax|escape|check)\s*=/.test(line) || line === '---';

/**
 * The number of comment lines a template file's header holds: its first run of
 * comment lines, when no more than one line of content precedes it (the one
 * line a workflow names itself with, `name: on_pr`). A comment further down is
 * a comment, not a header.
 */
export function headerLines(text: string, file: string): number {
  const syntax = commentSyntax(file);
  const lines = text.split('\n').map((l) => l.replace(JINJA_TAG, '').trim());
  const [open, close] = syntax.block ?? [];
  let content = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (isPreamble(line)) continue;
    if (open && close && line.startsWith(open)) {
      let j = i;
      while (j < lines.length - 1 && !(lines[j] ?? '').includes(close, j === i ? open.length : 0)) j++;
      return j - i + 1;
    }
    if (syntax.line?.test(line)) {
      let n = 0;
      while (syntax.line.test(lines[i + n] ?? '')) n++;
      return n;
    }
    content++;
    if (content > 1) return 0;
  }
  return 0;
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

/** The issue tracker's team keys. */
export const ISSUE_KEYS = ['PLX', 'DMG'] as const;

const ISSUE_ID = new RegExp(`(?<![\\w-])(?:${ISSUE_KEYS.join('|')})-\\d+(?![\\w-])`, 'g');

export function lintIssueIds(text: string, file: string): Violation[] {
  return [...matches(text, ISSUE_ID)].map(({ match, line }) => ({
    lint: 'issue-id',
    file,
    line,
    excerpt: match[0],
    message: `${match[0]} refers to the issue tracker; say what it means instead`,
  }));
}

/**
 * A commit message's issue identifiers. Git hands the commit-msg hook the
 * message before it strips comments, so `#` lines (the status git shows in the
 * editor, which names the branch) and everything below a scissors line are left
 * out.
 */
export function lintCommitMessage(text: string): Violation[] {
  const scissors = text.search(/^# -+ >8 -+$/m);
  const kept = (scissors === -1 ? text : text.slice(0, scissors))
    .split('\n')
    .map((l) => (l.startsWith('#') ? '' : l))
    .join('\n');
  return lintIssueIds(kept, 'commit message');
}
