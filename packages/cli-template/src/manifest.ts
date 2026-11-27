// The manifest reader: a template's tree split into its manifest, read from
// `template.yml`, and the files it renders, below `files/`.
//
// The manifest is YAML:
//
//   name: basket              # the template's name
//   questions:                # the answers this template owns, in order
//     fruit:
//       type: str
import { parse } from 'yaml';
import type { Manifest, Question, RenderError, Tree } from './types.ts';

/** A template read: its manifest, and its files by their path below `files/`. */
export interface Template {
  readonly manifest: Manifest;
  readonly files: Tree;
}

const MANIFEST = 'template.yml';
const FILES = 'files/';

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The template in `tree`, the `position`th of a render counted from 1; its problems go to `errors`. */
export function readTemplate(tree: Tree, _position: number, _errors: RenderError[]): Template | undefined {
  const entry = tree.get(MANIFEST);
  if (!entry) return undefined;
  const data = parse(utf8.decode(entry.bytes));
  const questions: Question[] = Object.entries(data.questions ?? {}).map(([name, fields]) => ({
    name,
    ...(fields as object),
  }));
  const manifest: Manifest = { name: data.name, questions, reads: [], policies: new Map(), birth: [] };
  const files = new Map(
    [...tree].filter(([path]) => path.startsWith(FILES)).map(([path, e]) => [path.slice(FILES.length), e]),
  );
  return { manifest, files };
}
