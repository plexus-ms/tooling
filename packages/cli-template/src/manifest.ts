// The manifest reader: a template's tree split into its manifest, read from
// `template.yml`, and the files it renders, below `files/`. Any other entry of
// the tree, a note for the template's authors beside the manifest, is not part
// of the template and is ignored.
//
// The manifest is YAML, a map of five keys, of which only `name` is required:
//
//   name: fruit-basket            # lowercase letters, digits and hyphens, from a letter
//   questions:                    # the answers this template owns, in the order they resolve
//     fruit:                      # a variable name: a letter, then letters, digits and `_`
//       type: str                 # str, int, float, bool, yaml or json; without it, the default's
//       default: apple            # without it, the answer is required; a string may hold Jinja
//       help: The fruit inside    # what an error about a missing answer says
//       when: "{{ basket }}"      # a boolean, or Jinja that renders one; false skips the question
//       validator: "{% if fruit == 'stone' %}not a fruit{% endif %}"   # output is the error
//       choices: [apple, pear]    # a list, a map of label to value, or Jinja that renders one
//     ripe:                       # a question with no fields
//   reads:                        # answers this template uses but another template owns
//     colour:                     # required: an error when nothing supplies it
//     size: {default: small}      # optional: the default when nothing supplies it
//   policies:                     # by source path below files/, as written there
//     "notes.md.jinja": born-once # merge (every path not listed) or born-once
//   birth:                        # commands for whoever creates a directory from the
//     - [git, init]               # template, each an argument vector; never run here
//
// What a question's fields mean when its answer is resolved is questions.ts's.
// The reader checks the shape: every key known, every value of its kind, every
// policy naming a file below `files/`, no read of a question the template owns
// itself. Names starting with `_` are left to the engine's own variables. Each
// problem is an error of the render naming `template.yml`, the template, and
// the question or read where there is one; the reader reports all of them, and
// a template with any is not rendered. Until its name is read, a template is
// named by its position in the list, `#1` for the first.
//
// Maps keep the order the manifest writes them in: questions resolve in it, and
// a map of choices is read into a `Map`, since a parsed object would move keys
// that look like integers to its front.
import { type Document, isNode, isMap as isYamlMap, parseDocument } from 'yaml';
import { messageOf } from './errors.ts';
import {
  type Manifest,
  MODE_TYPE,
  type Policy,
  type Question,
  type QuestionType,
  REGULAR,
  type Read,
  type RenderError,
  SYMLINK,
  type Tree,
} from './types.ts';

/** A template read: its manifest, and its files by their path below `files/`. */
export interface Template {
  readonly manifest: Manifest;
  readonly files: Tree;
}

/** Where a template's tree holds its manifest. */
export const MANIFEST = 'template.yml';
/** The directory of a template's tree that holds its files. */
export const FILES = 'files/';

const KEYS = ['name', 'questions', 'reads', 'policies', 'birth'];
const FIELDS = ['type', 'default', 'help', 'when', 'validator', 'choices'];
const TYPES: readonly string[] = ['str', 'int', 'float', 'bool', 'yaml', 'json'] satisfies QuestionType[];
const POLICIES: readonly string[] = ['merge', 'born-once'] satisfies Policy[];
/** What a template is called: lowercase letters, digits and hyphens, from a letter. */
export const TEMPLATE_NAME = /^[a-z][a-z0-9-]*$/;
const VARIABLE = /^[A-Za-z][A-Za-z0-9_]*$/;

const utf8 = new TextDecoder('utf-8', { fatal: true });

type Problem = (message: string, question?: string, path?: string) => void;
type YamlMap = Record<string, unknown>;

const isMap = (value: unknown): value is YamlMap =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The template in `tree`, the `position`th of a render counted from 1; its problems go to `errors`. */
export function readTemplate(tree: Tree, position: number, errors: RenderError[]): Template | undefined {
  let template = `#${position}`;
  let failed = false;
  const problem: Problem = (message, question, path = MANIFEST) => {
    failed = true;
    errors.push({ template, path, ...(question === undefined ? {} : { question }), message });
  };
  const parsed = parseManifest(tree, problem);
  if (parsed === undefined) return undefined;
  const { data, doc } = parsed;
  if (typeof data.name === 'string' && TEMPLATE_NAME.test(data.name)) template = data.name;
  else problem('the name is lowercase letters, digits and hyphens, starting with a letter');
  for (const [path, { mode }] of tree) {
    if ((mode & MODE_TYPE) === SYMLINK)
      problem(`${path} is a symlink, and a template may not hold one`, undefined, path);
  }
  for (const key of Object.keys(data)) if (!KEYS.includes(key)) problem(`unknown key ${key}`);
  const files = new Map(
    [...tree].filter(([path]) => path.startsWith(FILES)).map(([path, entry]) => [path.slice(FILES.length), entry]),
  );
  const questions = readQuestions(data.questions, doc, problem);
  const reads = readReads(data.reads, questions, problem);
  const policies = readPolicies(data.policies, files, problem);
  const birth = readBirth(data.birth, problem);
  if (failed) return undefined;
  return { manifest: { name: template, questions, reads, policies, birth }, files };
}

function parseManifest(tree: Tree, problem: Problem): { data: YamlMap; doc: Document } | undefined {
  const entry = tree.get(MANIFEST);
  if (entry === undefined) {
    problem(`the template has no ${MANIFEST}`);
    return undefined;
  }
  let doc: Document;
  let data: unknown;
  try {
    doc = parseDocument(utf8.decode(entry.bytes));
    const [error] = doc.errors;
    if (error !== undefined) throw error;
    data = doc.toJS();
  } catch (error) {
    problem(`${MANIFEST} is no YAML: ${messageOf(error)}`);
    return undefined;
  }
  if (!isMap(data)) {
    problem(`${MANIFEST} is not a map`);
    return undefined;
  }
  return { data, doc };
}

/** The map at `path` in `doc`, in the order the document writes it. */
function orderedMap(doc: Document, path: readonly string[]): Map<string, unknown> {
  const node = doc.getIn(path, true);
  const js = (value: unknown) => (isNode(value) ? value.toJS(doc) : value);
  return new Map(isYamlMap(node) ? node.items.map((pair) => [String(js(pair.key)), js(pair.value)]) : []);
}

/** The entries of an optional map section, or none when it is no map. */
function section(value: unknown, what: string, problem: Problem): [string, unknown][] {
  if (value === undefined || value === null) return [];
  if (isMap(value)) return Object.entries(value);
  problem(`${what} is a map`);
  return [];
}

function variable(name: string, what: string, problem: Problem): boolean {
  if (VARIABLE.test(name)) return true;
  problem(`a ${what}'s name is a letter, then letters, digits and underscores`, name);
  return false;
}

function readQuestions(value: unknown, doc: Document, problem: Problem): Question[] {
  return section(value, 'questions', problem).flatMap(([name, fields]): Question[] => {
    if (!variable(name, 'question', problem)) return [];
    if (fields === null) return [{ name }];
    if (!isMap(fields)) {
      problem('a question is a map of its fields', name);
      return [];
    }
    let valid = true;
    const check = (ok: boolean, message: string) => {
      if (ok) return;
      valid = false;
      problem(message, name);
    };
    for (const field of Object.keys(fields)) check(FIELDS.includes(field), `unknown field ${field}`);
    const { type, help, when, validator, choices } = fields;
    check(
      type === undefined || (typeof type === 'string' && TYPES.includes(type)),
      `type is one of ${TYPES.join(', ')}`,
    );
    check(help === undefined || typeof help === 'string', 'help is a string');
    check(when === undefined || typeof when === 'boolean' || typeof when === 'string', 'when is a boolean or a string');
    check(validator === undefined || typeof validator === 'string', 'validator is a string');
    check(
      choices === undefined || typeof choices === 'string' || (typeof choices === 'object' && choices !== null),
      'choices are a list, a map or a string',
    );
    if (!valid) return [];
    const ordered = isMap(choices) ? { choices: orderedMap(doc, ['questions', name, 'choices']) } : {};
    return [{ name, ...fields, ...ordered } as Question];
  });
}

function readReads(value: unknown, questions: readonly Question[], problem: Problem): Read[] {
  return section(value, 'reads', problem).flatMap(([name, fields]): Read[] => {
    if (!variable(name, 'read', problem)) return [];
    if (questions.some((q) => q.name === name)) {
      problem('a template does not read its own question', name);
      return [];
    }
    if (fields === null) return [{ name }];
    if (!isMap(fields)) {
      problem('a read is empty, or a map with a default', name);
      return [];
    }
    const unknown = Object.keys(fields).filter((field) => field !== 'default');
    for (const field of unknown) problem(`unknown field ${field}; a read has only a default`, name);
    return unknown.length > 0 ? [] : [{ name, ...fields }];
  });
}

function readPolicies(value: unknown, files: Tree, problem: Problem): Map<string, Policy> {
  const policies = new Map<string, Policy>();
  for (const [path, policy] of section(value, 'policies', problem)) {
    const entry = files.get(path);
    if (entry === undefined || (entry.mode & MODE_TYPE) !== REGULAR)
      problem(`policies name ${path}, which is no file below ${FILES}`);
    else if (typeof policy !== 'string' || !POLICIES.includes(policy))
      problem(`the policy of ${path} is ${POLICIES.join(' or ')}, not ${String(policy)}`);
    else policies.set(path, policy as Policy);
  }
  return policies;
}

function readBirth(value: unknown, problem: Problem): string[][] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problem('birth is a list of commands');
    return [];
  }
  return value.filter((command): command is string[] => {
    const ok = Array.isArray(command) && command.length > 0 && command.every((arg) => typeof arg === 'string');
    if (!ok) problem('each birth command is a list of strings, its first the program');
    return ok;
  });
}
