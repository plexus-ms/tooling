// What the ring needs from outside it: the template repos cloned, the real
// copier run, and an environment in which git behaves the same on every
// machine. Nothing here decides what is compared; parity.test.ts does.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { copierVia } from '../packages/lib/src/copier.ts';

const execFileAsync = promisify(execFile);

export type TemplateName = 'repo-turbo' | 'repo-operations' | 'app-nextjs';

/** The template repo each template is, by name. */
export const TEMPLATE_REPOS: Readonly<Record<TemplateName, string>> = {
  'repo-turbo': 'template-repo-turbo',
  'repo-operations': 'template-repo-operations',
  'app-nextjs': 'template-app-nextjs',
};

/** Where the template repos are cloned from when nothing overrides it. */
export const GITHUB = 'https://github.com/plexus-ms';

/** A directory (or URL prefix) holding the three template repos, which replaces GitHub. */
export const OVERRIDE = 'PLX_PARITY_TEMPLATE_REPOS';

/**
 * The git configuration of every git and copier run of the ring: an identity,
 * no signing, and nothing of the machine's own (a `merge.conflictStyle` there
 * would change what copier merges).
 */
export const GIT_CONFIG = `[user]
\tname = parity
\temail = parity@example.invalid
[commit]
\tgpgsign = false
[init]
\tdefaultBranch = main
[protocol "file"]
\tallow = always
`;

/** The process's environment, without any `GIT_*` variable (a hook sets some) and with `configFile` as git's only configuration. */
export function isolatedEnv(configFile: string): NodeJS.ProcessEnv {
  const kept = Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'));
  return {
    ...Object.fromEntries(kept),
    GIT_CONFIG_GLOBAL: configFile,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** Runs a program to its end, and fails with its standard error in the message. */
export async function run(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(file, args, { env, cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
    return stdout;
  } catch (error) {
    const { stderr, message } = error as { stderr?: string; message: string };
    throw new Error(`${file} ${args.join(' ')} failed: ${(stderr || message).trim()}`);
  }
}

/**
 * Clones each template repo from `<base>/<repo>` into `<into>/<repo>`, whole,
 * so that every tag comes with it, and returns where each template's repo is.
 * Any failure is an error naming the repo and where it was cloned from.
 */
export async function cloneTemplateRepos(
  base: string,
  into: string,
  env: NodeJS.ProcessEnv,
): Promise<Record<TemplateName, string>> {
  const clones = {} as Record<TemplateName, string>;
  for (const [name, repo] of Object.entries(TEMPLATE_REPOS) as [TemplateName, string][]) {
    const from = `${base}/${repo}`;
    clones[name] = join(into, repo);
    try {
      await run('git', ['clone', '--quiet', from, clones[name]], env);
    } catch (error) {
      throw new Error(
        `parity ring: cannot clone ${repo} from ${from} (${OVERRIDE} names another place): ${(error as Error).message}`,
      );
    }
  }
  return clones;
}

/** The real copier, at the version `plx` pins, run through mise. */
export async function copier(args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  await run('mise', copierVia([...args]), env, cwd);
}
