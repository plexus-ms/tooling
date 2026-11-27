// gitMergeFile: the real merge of one file, the `MergeFile` the CLI hands to
// `merge`. It is the one part of the package outside the core that touches the
// filesystem and runs a command, and the core never imports it: it writes the
// three sides to a temporary directory, runs `git merge-file` there, and
// removes the directory again.
//
//   git merge-file -p -L current -L "old render" -L "new render" -- current old new
//
// `-p` prints the merged file instead of overwriting the current side. The
// labels name the three sides, and a conflict stays in the file between them:
//
//   <<<<<<< current
//   the user's lines
//   =======
//   the new render's lines
//   >>>>>>> new render
//
// The merge is reported conflicted when the result holds the opening or the
// closing label line exactly, `\r\n` line endings included: never by a bare
// `<<<<<<<`, which a file may hold for reasons of its own. A file that already
// holds one of the two exact label lines is reported conflicted however it
// merges; the labels are chosen to make that unlikely. git's exit code is the
// number of conflicts, which serves only to tell a failed run (above 127) from
// a merge.
//
// git runs with no configuration but its built-in defaults: none of the
// caller's, so that `merge.conflictStyle` and the like cannot change the
// result, and none from the environment of a git process that may have started
// this one, a hook's for one. Bytes are carried as they are: git merges lines
// whatever their ending and leaves the bytes of each line alone. A binary side
// never reaches it, since the core decides what is binary (merge.ts); git
// would fail on one.
//
// Ported from copier v9.19.1, copier/_main.py, the `merge-file` call with three
// labels and the conflict detection of `_apply_update`; MIT-licensed, see
// LICENSE.copier.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileSides, MergedFile } from './types.ts';

/** The labels of the three sides, in the order git merge-file takes them. */
const LABELS = { current: 'current', old: 'old render', new: 'new render' } as const;

/** The lines that open and close a conflict, without their line ending. */
const MARKERS = new Set([`<<<<<<< ${LABELS.current}`, `>>>>>>> ${LABELS.new}`]);

/** The three-way merge of one file by `git merge-file`. */
export async function gitMergeFile(sides: FileSides): Promise<MergedFile> {
  const dir = await mkdtemp(join(tmpdir(), 'merge-file-'));
  try {
    await Promise.all([
      writeFile(join(dir, 'current'), sides.current),
      writeFile(join(dir, 'old'), sides.old),
      writeFile(join(dir, 'new'), sides.new),
    ]);
    const labels = [LABELS.current, LABELS.old, LABELS.new].flatMap((label) => ['-L', label]);
    const bytes = await git(['merge-file', '-p', ...labels, '--', 'current', 'old', 'new'], dir, sides.path);
    return { bytes, conflicted: conflicted(bytes) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Whether `bytes` hold a line that opens or closes a conflict between our labels. */
function conflicted(bytes: Uint8Array): boolean {
  // latin1 maps each byte to one character, so that any bytes split into lines.
  return Buffer.from(bytes)
    .toString('latin1')
    .split('\n')
    .some((line) => MARKERS.has(line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** What git prints for `args` in `cwd`, with no configuration but its defaults; a failure names `path`. */
function git(args: readonly string[], cwd: string, path: string): Promise<Uint8Array> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' });
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== null && code <= 127) resolve(new Uint8Array(Buffer.concat(stdout)));
      else reject(new Error(`git merge-file failed on ${path}: ${Buffer.concat(stderr).toString().trim()}`));
    });
  });
}
