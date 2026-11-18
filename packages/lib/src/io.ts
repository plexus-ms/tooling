// Everything a verb does to the world goes through an Io, injected into the
// Context (context.ts). The real one wraps node; a test hands in a fake and
// asserts what was asked of it, with no subprocess and no filesystem.
import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import type { Writable } from 'node:stream';

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Fed to the process's stdin, then closed. */
  input?: string;
  /**
   * Pass the process's output through to the terminal instead of capturing it,
   * and, when nothing is fed in, its input too: a program that asks questions
   * (copier) gets to ask them. Both of its streams go to stderr: stdout is the
   * verb's result and stays clean for `--json` and pipes.
   */
  inherit?: boolean;
  /**
   * Capture the process's output as usual, and pass both of its streams
   * through to stderr as they come: for a step whose output the verb goes on
   * with, shown when the verbosity asks for subprocess output.
   */
  echo?: boolean;
  /**
   * How long the process may run, in milliseconds. It then runs in a process
   * group of its own, which is sent SIGTERM when the time is up (SIGKILL a
   * few seconds later) and SIGKILL when this process is interrupted, so that
   * nothing it started outlives it; the exec rejects with a TimeoutError.
   */
  timeout?: number;
}

export interface Io {
  stdout: Writable;
  stderr: Writable;
  /**
   * Ask a yes/no question of a human, or undefined when there is none: off a
   * terminal, or in a program that brings no prompt (the CLI supplies one).
   */
  prompt?: (question: string) => Promise<boolean>;
  /** Run a process to completion; resolves with its stdout, rejects with ExecError on nonzero exit. */
  exec(command: string, args: string[], options?: ExecOptions): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** The entries of a directory, in no particular order. */
  readDir(path: string): Promise<DirEntry[]>;
}

export interface DirEntry {
  name: string;
  /** A directory itself; a symlink to one is not (`symlink`). */
  directory: boolean;
  /** A symbolic link, to whatever it points at. */
  symlink?: boolean;
}

export class ExecError extends Error {
  readonly command: string;
  readonly code: number | null;
  readonly stderr: string;

  constructor(command: string, code: number | null, stderr: string) {
    super(`${command} exited with ${code ?? 'signal'}${stderr ? `\n${stderr.trimEnd()}` : ''}`);
    this.command = command;
    this.code = code;
    this.stderr = stderr;
  }
}

/** A process killed because it ran past its time limit (`ExecOptions.timeout`). */
export class TimeoutError extends ExecError {
  readonly limit: number;

  constructor(command: string, limit: number, stderr: string) {
    super(command, null, stderr);
    this.message = `${command} did not finish within ${limit} ms and was killed${stderr ? `\n${stderr.trimEnd()}` : ''}`;
    this.limit = limit;
  }
}

/** How long a process past its time limit has between SIGTERM and SIGKILL. */
const GRACE = 5000;

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;
const cleanups: (() => void)[] = [];

function interrupted(signal: NodeJS.Signals): void {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      cleanup();
    } catch {
      // the others still run, and the process still ends
    }
  }
  for (const s of SIGNALS) process.removeListener(s, interrupted);
  process.kill(process.pid, signal);
}

/**
 * Run `cleanup` (synchronous) if the process is ended by SIGINT or SIGTERM
 * before the returned release is called: what a `finally` cannot do, since a
 * signal ends node without unwinding. The latest registered runs first; the
 * process then ends by the same signal, as it would have without.
 */
export function onInterrupt(cleanup: () => void): () => void {
  if (cleanups.length === 0) for (const s of SIGNALS) process.on(s, interrupted);
  cleanups.push(cleanup);
  return () => {
    const at = cleanups.indexOf(cleanup);
    if (at >= 0) cleanups.splice(at, 1);
    if (cleanups.length === 0) for (const s of SIGNALS) process.removeListener(s, interrupted);
  };
}

/**
 * A read whose failure can be the answer "not there": undefined when it
 * rejects with an ExecError that `absent` accepts, the error otherwise. By
 * default any exit is that answer (`git show` of a path the commit lacks, a
 * check on a host); a read whose tool fails for other reasons too (a registry
 * that refuses the login, a sidecar that does not answer) names its own. A
 * tool that could not start at all is never "not there".
 */
export async function orAbsent<T>(
  read: Promise<T>,
  absent: (error: ExecError) => boolean = () => true,
): Promise<T | undefined> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof ExecError && absent(error)) return undefined;
    throw error;
  }
}

/** True when a human is on both ends of the terminal. */
export const isInteractive = (): boolean => process.stdin.isTTY === true && process.stderr.isTTY === true;

export function realIo(prompt?: Io['prompt']): Io {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    prompt: prompt && isInteractive() ? prompt : undefined,
    exec: (command, args, options = {}) =>
      new Promise((resolve, reject) => {
        const limit = options.timeout;
        const child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env,
          detached: limit !== undefined,
          stdio: [
            options.input !== undefined ? 'pipe' : options.inherit ? 'inherit' : 'ignore',
            options.inherit ? process.stderr.fd : 'pipe',
            'pipe',
          ],
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk;
          if (options.echo) process.stderr.write(chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk;
          if (options.inherit || options.echo) process.stderr.write(chunk);
        });
        let timedOut = false;
        const group = (signal: NodeJS.Signals) => () => {
          try {
            if (child.pid !== undefined) process.kill(-child.pid, signal);
          } catch {
            // the group is gone already
          }
        };
        const timer =
          limit === undefined
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                group('SIGTERM')();
                setTimeout(group('SIGKILL'), GRACE).unref();
              }, limit);
        const release = limit === undefined ? undefined : onInterrupt(group('SIGKILL'));
        const settle = () => {
          clearTimeout(timer);
          release?.();
        };
        child.on('error', (error) => {
          settle();
          reject(error);
        });
        child.on('close', (code) => {
          settle();
          if (timedOut && limit !== undefined) reject(new TimeoutError(render(command, args), limit, stderr));
          else if (code === 0) resolve(stdout);
          else reject(new ExecError(render(command, args), code, stderr));
        });
        if (options.input !== undefined) child.stdin?.end(options.input);
      }),
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, content) => writeFile(path, content),
    readDir: async (path) =>
      (await readdir(path, { withFileTypes: true })).map((e) => ({
        name: e.name,
        directory: e.isDirectory(),
        ...(e.isSymbolicLink() ? { symlink: true } : {}),
      })),
  };
}

/** The command line as a shell would need it typed: args quoted when they must be. */
export function render(command: string, args: string[]): string {
  return [command, ...args].map(quote).join(' ');
}

function quote(arg: string): string {
  return /^[\w./:@%+=,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}
