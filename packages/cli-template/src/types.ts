// The core's types: what `render` and `merge` take and return. Both are plain
// functions over in-memory trees; nothing here reads or writes a directory.
//
// A tree maps a relative path to an entry: its bytes and its mode. Paths are
// POSIX, separated by `/`, with no leading `./`, no leading or trailing `/` and
// no `.` or `..` part. A mode is a POSIX mode as `lstat` gives it, so that its
// type bits (`MODE_TYPE`) say what the entry is:
//
//   REGULAR    a file; its bytes are its content, carried as they are, line
//              endings included; of its permission bits only the executable
//              ones (0o111) mean anything to the engine
//   SYMLINK    a symbolic link; its bytes are the link's target. A template
//              holding one is an error, and `merge` never writes or deletes
//              through one in the current tree
//   DIRECTORY  a directory that holds nothing; its bytes are empty. A directory
//              that holds entries is implied by their paths and need not be
//              listed
//
// A template is a tree too: its manifest at `template.yml` and the files it
// renders below `files/`. The manifest's format is stated in manifest.ts; the
// reader turns it into a `Manifest`.
//
// Answers are one flat namespace of JSON values by name. `render` takes the
// given answers and returns the resolved ones: the given answers the templates
// own, and the defaults of the questions nobody answered. A given answer no
// template owns or reads is listed as unused, and is no error.
//
// `render` reports what went wrong as data: every error it found, each a
// sentence for a person with the template, the path and the question it
// concerns where there is one. A render with errors writes nothing: its tree,
// its files and its birth commands are empty.
//
// Each rendered path has an owner, the template that wrote it, and a policy:
// `merge` (the default) or `born-once`, written when the path is absent and
// never touched again. `merge` reads the policies from the new side's render.
//
// `merge` takes three trees, the old render, the new render and the current
// directory, and returns the current tree with the merge applied, and one
// report entry per path it touched. The merge of one file whose three sides
// all differ is the injected `MergeFile`; the real one calls `git merge-file`,
// a fake stands in for it in tests. It returns the merged bytes and whether
// they hold a conflict, which it detects by its own label lines.

/** The bits of a mode that say what an entry is. */
export const MODE_TYPE = 0o170000;
/** A file's type bits. */
export const REGULAR = 0o100000;
/** An empty directory's type bits. */
export const DIRECTORY = 0o040000;
/** A symbolic link's type bits. */
export const SYMLINK = 0o120000;

/** One entry of a tree: its bytes and its mode. */
export interface Entry {
  readonly bytes: Uint8Array;
  readonly mode: number;
}

/** A directory's content in memory, by relative path. */
export type Tree = ReadonlyMap<string, Entry>;

/** Answers by name, each a JSON value. */
export type Answers = Readonly<Record<string, unknown>>;

/** How `merge` treats a path. */
export type Policy = 'merge' | 'born-once';

/** The six types an answer is cast to. */
export type QuestionType = 'str' | 'int' | 'float' | 'bool' | 'yaml' | 'json';

/** A question a template owns, as its manifest declares it. A field the manifest leaves out is absent. */
export interface Question {
  readonly name: string;
  readonly type?: QuestionType;
  /** Present when the manifest gives one, even as `null`. */
  readonly default?: unknown;
  readonly help?: string;
  readonly when?: boolean | string;
  readonly validator?: string;
  readonly choices?: string | readonly unknown[] | Readonly<Record<string, unknown>>;
}

/** An answer a template uses but does not own. Without a default it is required. */
export interface Read {
  readonly name: string;
  /** Present when the manifest gives one, even as `null`. */
  readonly default?: unknown;
}

/** A template's manifest, read from its `template.yml`. */
export interface Manifest {
  readonly name: string;
  /** In the order the manifest declares them. */
  readonly questions: readonly Question[];
  readonly reads: readonly Read[];
  /** By source path below `files/`, as it is written there; a path not listed is `merge`. */
  readonly policies: ReadonlyMap<string, Policy>;
  /** Each an argument vector, its first element the program. */
  readonly birth: readonly (readonly string[])[];
}

/** One thing that kept `render` from producing a tree. */
export interface RenderError {
  readonly message: string;
  /** The template's name; where its manifest yields none, its position in the list, `#1` for the first. */
  readonly template?: string;
  /** A path in the template's tree, such as `files/a.txt.jinja` or `template.yml`. */
  readonly path?: string;
  readonly question?: string;
}

/** Who wrote a rendered path, and how `merge` treats it. */
export interface Origin {
  readonly template: string;
  readonly policy: Policy;
}

/** A birth command, by the template that declares it. */
export interface BirthCommand {
  readonly template: string;
  readonly command: readonly string[];
}

/** What `render` returns. */
export interface RenderResult {
  readonly tree: Tree;
  readonly answers: Answers;
  /** The names of given answers that no template owns or reads. */
  readonly unused: readonly string[];
  /** Every path of `tree`, with its owner and policy. */
  readonly files: ReadonlyMap<string, Origin>;
  /** In the order the templates were given, each template's in its manifest's order. */
  readonly birth: readonly BirthCommand[];
  readonly errors: readonly RenderError[];
}

/** What `merge` takes. `new` and `files` come from the new side's render. */
export interface MergeInput {
  readonly old: Tree;
  readonly new: Tree;
  readonly current: Tree;
  readonly files: ReadonlyMap<string, { readonly policy: Policy }>;
}

/** What happened to a path. */
export type Outcome = 'clean' | 'added' | 'deleted' | 'conflicted' | 'kept';

/** One path `merge` touched. */
export interface MergeEntry {
  readonly path: string;
  readonly outcome: Outcome;
}

/** What `merge` returns. */
export interface MergeResult {
  /** The current tree with the merge applied. */
  readonly tree: Tree;
  /** In path order. */
  readonly report: readonly MergeEntry[];
}

/** The three sides of one file; a side that lacks the file is empty bytes. */
export interface FileSides {
  readonly path: string;
  readonly old: Uint8Array;
  readonly new: Uint8Array;
  readonly current: Uint8Array;
}

/** The merged bytes of one file, and whether they hold a conflict. */
export interface MergedFile {
  readonly bytes: Uint8Array;
  readonly conflicted: boolean;
}

/** The three-way merge of one file. */
export type MergeFile = (sides: FileSides) => Promise<MergedFile>;
