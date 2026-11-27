// The command tests' harness: `plx-template` run as a process, and directories
// in a scratch location that a test creates and removes. Not shipped
// (excluded in tsconfig).
//
// `put` writes a listing (testing/trees.ts) below a directory, `read` lists
// what a directory holds the way a tree is listed, so that a test compares
// directories with `assert.deepEqual`. Symlinks are listed as `-> target`.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DIRECTORY, MODE_TYPE } from '../types.ts';
import type { Listing } from './trees.ts';

const BIN = join(import.meta.dirname, '..', 'bin.ts');

export interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A scratch directory, and its removal. */
export interface Scratch {
  readonly dir: string;
  /** The path of `name` below the scratch directory. */
  path(name: string): string;
  remove(): void;
}

export function scratch(): Scratch {
  const dir = mkdtempSync(join(tmpdir(), 'plx-template-test-'));
  return { dir, path: (name) => join(dir, name), remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Runs `plx-template` with `args`, `input` on its standard input. */
export function plx(args: readonly string[], input = '', cwd?: string): Run {
  const result = spawnSync(process.execPath, [BIN, ...args], { input, encoding: 'utf8', cwd });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Writes `files` below `dir`: a string is a file of mode 0o644, `{ text, mode }` a file of its own mode, or an empty directory where the mode says so. */
export function put(dir: string, files: Listing): void {
  for (const [path, listed] of Object.entries(files)) {
    const file = join(dir, path);
    if (typeof listed !== 'string' && (listed.mode & MODE_TYPE) === DIRECTORY) {
      mkdirSync(file, { recursive: true });
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    if (typeof listed === 'string') writeFileSync(file, listed, { mode: 0o644 });
    else if ('text' in listed) writeFileSync(file, listed.text);
    else writeFileSync(file, Uint8Array.from(listed.bytes));
    if (typeof listed !== 'string') chmodSync(file, listed.mode & 0o777);
  }
}

/** What `dir` holds: each file by its path with its text, and its permission bits where they are not 0o644. */
export function read(dir: string, prefix = ''): Record<string, string | { text: string; mode: number }> {
  const out: Record<string, string | { text: string; mode: number }> = {};
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const stat = lstatSync(join(dir, path));
    if (stat.isSymbolicLink()) out[path] = `-> ${readlinkSync(join(dir, path))}`;
    else if (stat.isDirectory()) {
      const inner = read(dir, path);
      if (Object.keys(inner).length === 0) out[`${path}/`] = '';
      Object.assign(out, inner);
    } else {
      const text = readFileSync(join(dir, path), 'utf8');
      const mode = stat.mode & 0o777;
      out[path] = mode === 0o644 ? text : { text, mode };
    }
  }
  return out;
}
