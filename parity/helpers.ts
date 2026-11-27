// The helpers of the parity ring that decide something: how a copier tree is
// made comparable to the engine's, how two trees are compared, and what a
// consumer edits before a replay. Each has its test in helpers.test.ts.
import { type Answers, DIRECTORY, MODE_TYPE, SYMLINK, type Tree } from '../packages/cli-template/src/index.ts';
import type { TemplateName } from './harness.ts';

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

/** The marker's name: the one file whose frontmatter copier writes and the engine does not. */
export const MARKER = 'PLEXUS.md';
const ANSWERS_FILE = '.copier-answers.yml';

/**
 * The marker without the frontmatter copier's template wrote, and without the
 * blank line after it: `plx` writes the frontmatter after the engine renders,
 * so the engine's marker starts at the body. A frontmatter that ends the file
 * leaves nothing. A file that does not start with a frontmatter, or whose body
 * does not follow a blank line, is an error: it would be a marker this does not know.
 */
export function stripCopierMarker(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes);
  const frontmatter = /^---\n(?:[\s\S]*?\n)?---\n/.exec(text);
  if (!frontmatter) throw new Error('a copier marker without a frontmatter');
  const rest = text.slice(frontmatter[0].length);
  if (rest === '') return encoder.encode('');
  if (!rest.startsWith('\n')) throw new Error('a copier marker whose body does not follow a blank line');
  return encoder.encode(rest.slice(1));
}

/**
 * What copier is given for the answers of the engine's spelling: the profile as
 * `stateless-app` or `stateful-app` for the app template, and, for it, the
 * tenant in the answers file of the enclosing repo (`parent`), where copier reads it.
 */
export function copierJob(template: TemplateName, answers: Answers): { data: Answers; parent?: Answers } {
  if (template !== 'app-nextjs') return { data: answers };
  const { tenant, profile, ...rest } = answers;
  const data = { ...rest, ...(profile === undefined ? {} : { profile: `${String(profile)}-app` }) };
  return tenant === undefined ? { data } : { data, parent: { tenant } };
}

/** An answer copier recorded, as the engine spells it: the profile without `-app`. */
export function copierAnswersAsEngine(recorded: Answers): Answers {
  const { profile, ...rest } = recorded;
  if (typeof profile !== 'string') return recorded;
  return { ...rest, profile: profile.replace(/-app$/, '') };
}

/** A copier tree as the engine's would be: without its answers file, and its marker without frontmatter. */
export function normaliseCopierTree(tree: Tree): Tree {
  const normal = new Map(tree);
  normal.delete(ANSWERS_FILE);
  const marker = normal.get(MARKER);
  if (marker) normal.set(MARKER, { ...marker, bytes: stripCopierMarker(marker.bytes) });
  return normal;
}

const kindOf = (mode: number): string => {
  const type = mode & MODE_TYPE;
  return type === DIRECTORY ? 'directory' : type === SYMLINK ? 'symlink' : 'file';
};

/** Each way the two trees differ, by path in path order, copier's first in each message. */
export function diffTrees(copier: Tree, engine: Tree): string[] {
  const found: string[] = [];
  for (const path of [...new Set([...copier.keys(), ...engine.keys()])].sort()) {
    const c = copier.get(path);
    const e = engine.get(path);
    if (!c) found.push(`${path}: only the engine writes it`);
    else if (!e) found.push(`${path}: only copier writes it`);
    else if (kindOf(c.mode) !== kindOf(e.mode))
      found.push(`${path}: copier has a ${kindOf(c.mode)}, the engine a ${kindOf(e.mode)}`);
    else if (kindOf(c.mode) === 'directory') continue;
    else {
      if (!Buffer.from(c.bytes).equals(e.bytes))
        found.push(`${path}: bytes differ, ${firstDifference(c.bytes, e.bytes)}`);
      const [ce, ee] = [(c.mode & 0o100) !== 0, (e.mode & 0o100) !== 0];
      if (ce !== ee) found.push(`${path}: executable bit differs: copier ${ce}, engine ${ee}`);
    }
  }
  return found;
}

function firstDifference(copier: Uint8Array, engine: Uint8Array): string {
  const [c, e] = [Buffer.from(copier).toString('utf8').split('\n'), Buffer.from(engine).toString('utf8').split('\n')];
  const at = c.findIndex((line, i) => line !== e[i]);
  if (at === -1 && c.length === e.length) return 'not as text';
  const line = at === -1 ? Math.min(c.length, e.length) : at;
  return `first at line ${line + 1}: copier ${JSON.stringify(c[line])}, engine ${JSON.stringify(e[line])}`;
}

/** The lines of each side's conflict markers that carry a label. */
const LABELS = {
  copier: ['<<<<<<< before updating', '>>>>>>> after updating'],
  engine: ['<<<<<<< current', '>>>>>>> new render'],
} as const;

/** The conflict markers of one side's labels without their labels, and every other line as it is. */
export function unifyConflictLabels(text: string, side: keyof typeof LABELS): string {
  const labelled: readonly string[] = LABELS[side];
  return text
    .split('\n')
    .map((line) => (labelled.includes(line) ? line.slice(0, 7) : line))
    .join('\n');
}

/** What the consumer does to a file before a replay. */
export interface ConsumerEdit {
  readonly path: string;
  /** The file's whole text after the edit. */
  readonly text: string;
  /**
   * `merge`: a line far from every line the template changed, so that the merge is clean;
   * `conflict`: the first line the template changed, so that it conflicts;
   * `born-once`: the marker's body; `untouched`: a file the template left alone;
   * `own`: a file of the consumer's own, which no template writes.
   */
  readonly kind: 'merge' | 'conflict' | 'born-once' | 'untouched' | 'own';
}

const text = (entry: { bytes: Uint8Array; mode: number } | undefined): string | undefined => {
  if (!entry || kindOf(entry.mode) !== 'file' || entry.bytes.subarray(0, 8000).includes(0)) return undefined;
  try {
    return decoder.decode(entry.bytes);
  } catch {
    return undefined;
  }
};

const withLine = (source: string, line: string): string =>
  `${source}${source === '' || source.endsWith('\n') ? '' : '\n'}${line}\n`;

/**
 * The edits of a consumer that has `old`, the render before the update, when
 * `next`, the render after it, is merged into it. Files the template changed
 * are edited alternately to merge and to conflict, so that a replay shows both;
 * the marker's body is edited, which a born-once file must keep; one file the
 * template left alone is edited, and one of the consumer's own is added. Files
 * that are not text, and paths only one render holds, are left alone.
 */
export function consumerEdits(old: Tree, next: Tree): ConsumerEdit[] {
  const edits: ConsumerEdit[] = [];
  const paths = [...old.keys()].filter((path) => next.has(path)).sort();
  let changed = 0;
  for (const path of paths) {
    const [before, after] = [text(old.get(path)), text(next.get(path))];
    if (path === MARKER || before === undefined || after === undefined || before === after) continue;
    const lines = before.endsWith('\n') ? before.slice(0, -1).split('\n') : before.split('\n');
    const kept = new Set(after.split('\n'));
    const moved = lines.flatMap((line, i) => (line.trim() !== '' && !kept.has(line) ? [i] : []));
    const edited = [...lines];
    const first = moved[0];
    const trailing = before.endsWith('\n') ? '\n' : '';
    if (changed++ % 2 === 0 && first !== undefined) {
      edited[first] = `${edited[first]} # local`;
      edits.push({ path, kind: 'conflict', text: edited.join('\n') + trailing });
    } else {
      const far = lines.map((_, i) => Math.min(Infinity, ...moved.map((m) => Math.abs(m - i))));
      const at = far.indexOf(Math.max(...far));
      edited.splice(at + 1, 0, 'local edit');
      edits.push({ path, kind: 'merge', text: edited.join('\n') + trailing });
    }
  }
  const marker = text(old.get(MARKER));
  if (marker !== undefined) edits.push({ path: MARKER, kind: 'born-once', text: withLine(marker, 'local prose') });
  const alone = paths.find(
    (path) => path !== MARKER && text(old.get(path)) !== undefined && text(old.get(path)) === text(next.get(path)),
  );
  if (alone !== undefined)
    edits.push({ path: alone, kind: 'untouched', text: withLine(text(old.get(alone)) ?? '', 'local edit') });
  edits.push({ path: 'local/notes.md', kind: 'own', text: 'local notes\n' });
  return edits;
}
