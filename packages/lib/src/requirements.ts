// The requirements check (§ 1.8 PLX), the compendium's `requirements.sh`
// moved: a verb, not a system.
//
//   scanPage        one page: its defects, and for a standard module its
//                   requirement lines, `§ <section> <text>`, in page order,
//                   its numbered sections and its requirement names
//   checkCompendium the map and every module page, plus the cross-page rules:
//                   unique codes, unique requirement names, known
//                   dependencies, dependencies that respect the seams (§ 1.3 PLX)
//   checkRepo       any repo: the four lints of lints.ts over its tracked
//                   files, against its baseline (baseline.ts); for the
//                   compendium, checkCompendium too
//
// The map carries no requirements and no BCP 14 keyword. A module at standard
// maturity carries its requirements as blockquoted bullets ("> - ") under
// numbered section headings; a keyword anywhere else, a blockquote that is not
// such a bullet, or any keyword or blockquote in a module below standard
// maturity is a defect. The trailing "## Maintaining" section is prose
// throughout. Extraction is structural: no classification, no heuristics.
// `plx-dev ship` compares a module's extracted lines across versions to stamp `changed`,
// so the extractor and the linter are one function and cannot disagree.
//
// A requirement line carries its name, when it has one, as its first words:
// the full name in a code span and a colon (requirementName),
//
//   > - `PLX-App/<Name>`: The app MUST ...
//   > - `PLX-App/Stateful/<Name>`: ...      (a line of the app's stateful profile)
//
// in the one format `<module>[/<profile>]/<name>`, each segment capitalised
// like a module code's word, the module being the page's code. A profile is a
// part of its module's page; `PLX-AppStateful/<Name>`, the profile spelled as
// a module, is refused. A code span that opens a requirement line and holds
// something else of that shape (lowercase, four segments, no colon) is a
// malformed name, never an unnamed line.
//
// What a citation can name, the citable index of a version (`§ <n> <code>`
// for every numbered section, and every requirement name), comes from the
// compendium checked, from a checkout given with --compendium, or else from
// the index this plx carries (standardIndex.ts), written by `plx-dev ship`
// from the compendium at the version it cuts: a tenant repo, which has no
// compendium, checks its citations against the version of plx it pins.
//
//   plx requirements <repo>                    # lint; exit 1 on any defect
//   plx requirements <repo> --write-baseline   # record today's violations
//   plx requirements --commit-msg <file>       # the commit-msg hook
//   plx requirements --extract contracts/app.md
import { join } from 'node:path';
import { BASELINE_FILE, compareBaseline, parseBaseline, renderBaseline } from './baseline.ts';
import { CATALOG_DIRS } from './catalog.ts';
import type { Context } from './context.ts';
import { type Plan, write } from './effects.ts';
import {
  type Citable,
  lintCitations,
  lintDateOrVersion,
  lintIssueIds,
  lintTemplateHeader,
  REQUIREMENT_NAME,
  renderViolation,
  type Violation,
} from './lints.ts';
import { bundledIndex, type StandardIndex } from './standardIndex.ts';

export type PageMode = 'map' | 'module';

export interface Scan {
  /** `✗ <name>: line N: ...`, in page order. */
  defects: string[];
  /** The requirement lines of a standard module; empty for anything else. */
  requirements: string[];
  /** The numbers of the page's numbered sections, in page order. */
  sections: string[];
  /** The names its requirement lines carry, in page order. */
  names: string[];
  /** The frontmatter fields the cross-page rules need. */
  code?: string;
  maturity?: string;
  binds?: string;
  depends: string[];
  consumes: string[];
}

const KEYWORD = /MUST|SHOULD|MAY/;

/** A BCP 14 keyword in a line, the informal plurals (MUSTs, SHOULDs, MAYs) not counting. */
const hasKeyword = (line: string): boolean => KEYWORD.test(line.replace(/MUSTs|SHOULDs|MAYs/g, ''));

/** A requirement line's name, and whether it is written as the format and syntax require. */
export interface RequirementName {
  name: string;
  /** What is wrong with it; absent for a well-formed name. */
  malformed?: string;
}

/**
 * The name a requirement line carries, from the text after its `> - `: the
 * full name in a code span, then a colon, at the very start. The one parser of
 * that syntax: undefined for an unnamed line, `malformed` set when the opening
 * code span holds something name-shaped (`PLX-…/…`) that is not a name.
 */
export function requirementName(bullet: string): RequirementName | undefined {
  const span = /^`(PLX-[^`\s]*\/[^`\s]*)`(:\s)?/.exec(bullet);
  if (!span) return undefined;
  const name = span[1] ?? '';
  if (!new RegExp(`^${REQUIREMENT_NAME}$`).test(name))
    return { name, malformed: 'the format is PLX-<Module>[/<Profile>]/<Name>, each segment capitalised' };
  if (!span[2]) return { name, malformed: 'a name is followed by a colon and a blank' };
  return { name };
}

/** A bracketed, comma-separated list as the frontmatter writes it: `[A, B]`. */
const list = (value: string): string[] =>
  value
    .replace(/^\s*\[/, '')
    .replace(/\].*$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function scanPage(text: string, name: string, mode: PageMode): Scan {
  const scan: Scan = { defects: [], requirements: [], sections: [], names: [], depends: [], consumes: [] };
  const lines = text.split('\n');
  const defect = (n: number, msg: string) => scan.defects.push(`✗ ${name}: line ${n + 1}: ${msg}`);

  let i = 0;
  if (lines[0] === '---') {
    for (i = 1; i < lines.length && lines[i] !== '---'; i++) {
      const line = lines[i] ?? '';
      const [key = '', ...rest] = line.split(/\s+/);
      const value = rest.join(' ');
      if (key === 'maturity:') scan.maturity = rest[0];
      else if (key === 'code:') scan.code = rest[0];
      else if (key === 'binds:') scan.binds = rest[0];
      else if (key === 'depends:') scan.depends = list(value);
      else if (key === 'consumes:') scan.consumes = list(value);
      else if (key === 'kind:') defect(i, 'kind is the folder, contracts/ or approaches/, not a field');
    }
    i++;
  }

  let inCode = false;
  let maintaining = false;
  let started = false;
  let section = '';
  for (; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (line === '## Maintaining') {
      maintaining = true;
      section = '';
      continue;
    }
    const heading = /^#+ § (\S+)/.exec(line);
    if (heading) {
      if (maintaining) defect(i, 'numbered section after Maintaining');
      section = heading[1] ?? '';
      scan.sections.push(section);
      started = true;
      continue;
    }
    if (line.startsWith('> - ')) {
      if (mode === 'map') defect(i, `requirement in the map: ${line}`);
      else if (scan.maturity !== 'standard') defect(i, `requirement in a module at ${scan.maturity} maturity: ${line}`);
      else if (maintaining) defect(i, `requirement under Maintaining: ${line}`);
      else if (!started) defect(i, 'requirement before the first § heading');
      else {
        scan.requirements.push(`§ ${section} ${line.slice(4)}`);
        const named = requirementName(line.slice(4));
        if (named?.malformed) defect(i, `malformed requirement name ${named.name}: ${named.malformed}`);
        else if (named && named.name.split('/')[0] !== scan.code)
          defect(i, `requirement name ${named.name} does not start with the page's code, ${scan.code}`);
        else if (named) scan.names.push(named.name);
      }
      continue;
    }
    if (line.startsWith('>')) {
      defect(i, 'blockquote line is not a "> - " requirement bullet');
      continue;
    }
    if (hasKeyword(line)) defect(i, `BCP 14 keyword outside a requirement: ${line}`);
  }

  if (mode === 'module') {
    const { maturity = '', binds = '', code = '' } = scan;
    // Reported at the page's last line, like awk's NR at END.
    const n = text.endsWith('\n') ? lines.length - 1 : lines.length;
    if (!/^(note|candidate|standard)$/.test(maturity))
      defect(n - 1, `maturity must be note, candidate or standard, not "${maturity}"`);
    if (!/^(repo|app|host|organisation)$/.test(binds))
      defect(n - 1, `binds must be repo, app, host or organisation, not "${binds}"`);
    if (maturity === 'note' && code !== '') defect(n - 1, 'a note carries no code');
    if (maturity !== 'note' && !/^PLX-[A-Z][A-Za-z]+$/.test(code))
      defect(n - 1, `code must be PLX- plus one capitalised word, not "${code}"`);
  }
  return scan;
}

/** The requirement lines of a page, defects ignored: what `changed` compares across versions. */
export const extractRequirements = (text: string): string[] => scanPage(text, '', 'module').requirements;

export const MAP_PAGE = 'essentials/standard.md';

export interface CompendiumCheck {
  defects: string[];
  contracts: number;
  approaches: number;
}

/** Every module page of a compendium checkout: `<dir>/<file>`, sorted, index pages left out. */
export async function modulePages(ctx: Context, compendium: string): Promise<string[]> {
  const pages: string[] = [];
  for (const dir of Object.keys(CATALOG_DIRS)) {
    const entries = await ctx.readDir(join(compendium, dir));
    for (const e of entries.filter((e) => !e.directory && e.name.endsWith('.md') && e.name !== 'index.md').sort())
      pages.push(`${dir}/${e.name}`);
  }
  return pages;
}

export async function checkCompendium(ctx: Context, compendium: string): Promise<CompendiumCheck> {
  const defects: string[] = [];
  defects.push(...scanPage(await ctx.readFile(join(compendium, MAP_PAGE)), MAP_PAGE, 'map').defects);

  const pages = await modulePages(ctx, compendium);
  const scans = new Map<string, Scan>();
  for (const page of pages) {
    const scan = scanPage(await ctx.readFile(join(compendium, page)), page, 'module');
    defects.push(...scan.defects);
    scans.set(page, scan);
  }

  // Module codes are unique across pages.
  const byCode = new Map<string, string[]>();
  for (const [page, s] of scans) if (s.code) byCode.set(s.code, [...(byCode.get(s.code) ?? []), page]);
  for (const [code, where] of byCode) if (where.length > 1) defects.push(`✗ duplicate module code: ${code}`);

  // Requirement names are unique across pages: a citation names one line. A
  // profile is part of its module's page, so a name whose module is another
  // module's code and a word (PLX-AppStateful) spells the profile as a module.
  const named = new Set<string>();
  for (const s of scans.values())
    for (const name of s.names) {
      if (named.has(name)) defects.push(`✗ duplicate requirement name: ${name}`);
      named.add(name);
      const module = name.split('/')[0] ?? '';
      const base = [...byCode.keys()].find((c) => c !== module && new RegExp(`^${c}[A-Z][a-z]+$`).test(module));
      if (base)
        defects.push(
          `✗ requirement name ${name} spells a profile of ${base} as a module; a profile's lines are named ${base}/<Profile>/<Name> on the page of ${base}`,
        );
    }

  // Every declared dependency names a module that exists.
  for (const s of scans.values())
    for (const dep of s.depends) if (!byCode.has(dep)) defects.push(`✗ unknown module in depends: ${dep}`);

  // Dependencies respect the seams (§ 1.3 PLX): a contract depends only on
  // contracts, a dependency never crosses from the dev side (repo, app) to the
  // ops side (host, organisation) or back, and what crosses a seam is listed
  // under consumes and is a contract.
  const kindOf = (page: string): 'contract' | 'approach' => (page.startsWith('contracts/') ? 'contract' : 'approach');
  const side = (binds: string) => (binds === 'repo' || binds === 'app' ? 'dev' : 'ops');
  const kinds = new Map([...byCode].map(([code, [page = '']]) => [code, kindOf(page)]));
  const binds = new Map([...byCode].map(([code, [page = '']]) => [code, scans.get(page)?.binds ?? '']));
  for (const [page, s] of scans) {
    const m = s.code ?? page.replace(/.*\//, '');
    const kind = kindOf(page);
    for (const c of s.consumes) {
      if (kind === 'contract')
        defects.push(`✗ ${m} is a contract and consumes ${c}; a contract has no other side to consume`);
      else if (kinds.has(c) && kinds.get(c) !== 'contract')
        defects.push(`✗ ${m} consumes ${c}, which is an approach; only a contract is consumed across a seam`);
      else if (!kinds.has(c)) defects.push(`✗ ${m} consumes unknown module ${c}`);
    }
    for (const d of s.depends) {
      if (!kinds.has(d)) continue;
      if (kind === 'contract' && kinds.get(d) !== 'contract')
        defects.push(`✗ ${m} is a contract and depends on the approach ${d}`);
      if (side(s.binds ?? '') !== side(binds.get(d) ?? '') && kinds.get(d) !== 'contract')
        defects.push(
          `✗ ${m} (${s.binds}) depends on ${d} (${binds.get(d)}) across the dev/ops seam; only a contract may be depended on across a seam`,
        );
    }
  }

  return {
    defects,
    contracts: pages.filter((p) => p.startsWith('contracts/')).length,
    approaches: pages.filter((p) => p.startsWith('approaches/')).length,
  };
}

/**
 * Everything a citation can name in a compendium checkout, in page order: `§ <n>
 * PLX` for the map's numbered sections, `§ <n> <code>` for a module's, and the
 * requirement names. Notes have no code and cannot be cited by one.
 */
export async function readCitable(ctx: Context, compendium: string): Promise<string[]> {
  return (await readPages(ctx, compendium)).citable;
}

/** The citable index of a compendium checkout, and the code each page's bare `§ n` stands for (`PLX` on the map). */
async function readPages(ctx: Context, compendium: string): Promise<{ citable: string[]; own: Map<string, string> }> {
  const own = new Map([[MAP_PAGE, 'PLX']]);
  const citable = scanPage(await ctx.readFile(join(compendium, MAP_PAGE)), MAP_PAGE, 'map').sections.map(
    (n) => `§ ${n} PLX`,
  );
  for (const page of await modulePages(ctx, compendium)) {
    const scan = scanPage(await ctx.readFile(join(compendium, page)), page, 'module');
    if (!scan.code) continue;
    own.set(page, scan.code);
    citable.push(...scan.sections.map((n) => `§ ${n} ${scan.code}`), ...scan.names);
  }
  return { citable, own };
}

/** What a repo is to the lints: the compendium (the map at its root), a copier template (a `_subdirectory`), or any other repo. */
export type RepoKind = 'compendium' | 'template' | 'repo';

export interface RepoOptions {
  /** A compendium checkout to resolve citations against, instead of the index this plx carries. */
  compendium?: string;
}

export interface RepoLint {
  kind: RepoKind;
  /** Where the citable sections and names came from. */
  against: string;
  /** The compendium's structural defects; never baselined. */
  defects: string[];
  violations: Violation[];
  contracts?: number;
  approaches?: number;
}

const COPIER_FILES = ['copier.yml', 'copier.yaml'];

async function kindOf(ctx: Context, dir: string): Promise<{ kind: RepoKind; templateDir?: string }> {
  if (
    await ctx.readFile(join(dir, MAP_PAGE)).then(
      () => true,
      () => false,
    )
  )
    return { kind: 'compendium' };
  for (const file of COPIER_FILES) {
    const text = await ctx.readFile(join(dir, file)).catch(() => undefined);
    const sub = text === undefined ? undefined : /^_subdirectory:\s*["']?([^"'\s#]+)/m.exec(text)?.[1];
    if (sub) return { kind: 'template', templateDir: sub.replace(/\/+$/, '') };
  }
  return { kind: 'repo' };
}

/** The repo's tracked files, relative to its root. */
async function trackedFiles(ctx: Context, dir: string): Promise<string[]> {
  const out = await ctx.read('git', ['ls-files', '-z'], { cwd: dir }).catch(() => {
    throw new Error(`${dir} is not a git checkout; the lints read its tracked files`);
  });
  return out.split('\0').filter(Boolean).sort();
}

/** Every violation of the four lints in a repo's tracked files, before the baseline; the compendium's structure too. */
export async function lintRepo(ctx: Context, dir: string, options: RepoOptions = {}): Promise<RepoLint> {
  const { kind, templateDir } = await kindOf(ctx, dir);
  const result: RepoLint = { kind, against: '', defects: [], violations: [] };
  let index: StandardIndex;
  /** The code a bare `§ n` stands for, by page: only in the compendium checked. */
  let own = new Map<string, string>();
  if (kind === 'compendium') {
    const check = await checkCompendium(ctx, dir);
    Object.assign(result, { defects: check.defects, contracts: check.contracts, approaches: check.approaches });
    const pages = await readPages(ctx, dir);
    index = { version: 'this checkout', citable: pages.citable };
    own = pages.own;
    result.against = 'this compendium';
  } else if (options.compendium) {
    index = { version: options.compendium, citable: await readCitable(ctx, options.compendium) };
    result.against = `the compendium at ${options.compendium}`;
  } else {
    index = bundledIndex();
    result.against = `Plexus ${index.version}, the index this plx carries`;
  }
  const citable: Citable = new Set(index.citable);

  for (const file of await trackedFiles(ctx, dir)) {
    if (file === BASELINE_FILE) continue;
    const text = await ctx.readFile(join(dir, file)).catch(() => undefined);
    if (text === undefined || text.includes('\0')) continue; // deleted in the worktree, a submodule, or binary
    if (kind === 'compendium' && /\.mdx?$/.test(file)) result.violations.push(...lintDateOrVersion(text, file));
    result.violations.push(...lintCitations(text, file, citable, own.get(file)));
    if (templateDir && file.startsWith(`${templateDir}/`)) result.violations.push(...lintTemplateHeader(text, file));
    result.violations.push(...lintIssueIds(text, file));
  }
  return result;
}

export interface RepoCheck {
  kind: RepoKind;
  against: string;
  /** Every reason the check fails, one line each: structural defects, violations the baseline does not hold, baseline entries that no longer occur. */
  defects: string[];
  /** Violations the baseline holds. */
  known: number;
  contracts?: number;
  approaches?: number;
}

/** The repo's lints held against its baseline: a violation it does not hold fails, and so does an entry that no longer occurs. */
export async function checkRepo(ctx: Context, dir: string, options: RepoOptions = {}): Promise<RepoCheck> {
  const lint = await lintRepo(ctx, dir, options);
  const baseline = parseBaseline(await ctx.readFile(join(dir, BASELINE_FILE)).catch(() => ''));
  const { fresh, stale, known } = compareBaseline(lint.violations, baseline);
  return {
    kind: lint.kind,
    against: lint.against,
    defects: [
      ...lint.defects,
      ...fresh.map(renderViolation),
      ...stale.map((key) => `✗ ${BASELINE_FILE}: no longer occurs, remove it: ${key}`),
    ],
    known,
    contracts: lint.contracts,
    approaches: lint.approaches,
  };
}

/** The write that records every current violation as the repo's baseline. */
export async function planBaseline(ctx: Context, dir: string, options: RepoOptions = {}): Promise<Plan> {
  const lint = await lintRepo(ctx, dir, options);
  ctx.say(`• ${lint.violations.length} known violations → ${BASELINE_FILE}`);
  return [write(join(dir, BASELINE_FILE), renderBaseline(lint.violations))];
}
