// @plexus-ms/cli-template: the engine of plx-template as a library, a generic
// alternative to copier for several templates in one directory. It knows
// templates, answers, rendering and three-way merging, and nothing of who
// calls it: it imports no Plexus package (boundary.test.ts), reads and writes
// no directory, runs no command and keeps no state.
//
// Two functions over in-memory trees, whose types and their meaning are in
// types.ts: `render` and `merge`.
export { gitMergeFile } from './git-merge-file.ts';
export { merge } from './merge.ts';
export { render } from './render.ts';
export {
  type Answers,
  type BirthCommand,
  DIRECTORY,
  type Entry,
  type FileSides,
  type Manifest,
  type MergedFile,
  type MergeEntry,
  type MergeFile,
  type MergeInput,
  type MergeResult,
  MODE_TYPE,
  type Origin,
  type Outcome,
  type Policies,
  type Policy,
  type Question,
  type QuestionType,
  REGULAR,
  type Read,
  type RenderError,
  type RenderResult,
  SYMLINK,
  type Tree,
} from './types.ts';
