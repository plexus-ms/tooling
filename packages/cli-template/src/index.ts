// @plexus-ms/cli-template: the engine of plx-template as a library, a generic
// alternative to copier for several templates in one directory. It knows
// templates, answers, rendering and three-way merging, and nothing of who
// calls it: it imports no Plexus package (boundary.test.ts) and keeps no state.
//
// The core is two functions over in-memory trees, whose types and their
// meaning are in types.ts: `render` and `merge`. It reads and writes no
// directory and runs no command (boundary.test.ts). `gitMergeFile`, the real
// merge of one file that the caller hands to `merge`, is the one function
// that does: it writes temporary files and runs git. The functions that touch
// a directory for a caller of the library are exported beside them, `readTree`,
// `readManifest`, `readRender` and `planMerge` (directory.ts).
export {
  type MergePlan,
  planMerge,
  type RenderedSide,
  readManifest,
  readRender,
  readTemplateDirectory,
  readTree,
  type TemplateDirectory,
} from './directory.ts';
export { gitMergeFile } from './git-merge-file.ts';
export { TEMPLATE_NAME } from './manifest.ts';
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
