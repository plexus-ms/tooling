// `plx apply` through the program, on a scratch repo with fixture templates
// (real git, as the lib's tests): the arguments reach the verb, the report is
// the result on standard output, and a conflict makes the exit code non-zero.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { buildProgram, version } from '../program.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'plx-apply-cli-')));
after(() => rmSync(dir, { recursive: true, force: true }));

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdio: 'pipe',
  }).toString();

const put = (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

const marker = (fruit: string) => `---\nversion: ${version}\ntemplates: [basket]\nfruit: ${fruit}\n---\n`;

/** A repo with a basket of apples at HEAD, and the pears the working tree's marker asks for. */
function fixture(name: string, list: string) {
  const templates = join(dir, `${name}-templates`);
  put(join(templates, 'basket'), {
    'template.yml': 'name: basket\nquestions:\n  fruit:\n    type: str\n',
    'files/list.txt.jinja': '{{ fruit }}\n',
  });
  const repo = join(dir, `${name}-repo`);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  put(repo, { 'PLEXUS.md': marker('apple'), 'list.txt': 'apple\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  put(repo, { 'PLEXUS.md': marker('pear'), 'list.txt': list });
  return { repo, templates };
}

/** Runs `plx` with `args`, returning what it printed and the exit code it asked for. */
async function plx(...args: string[]) {
  let stdout = '';
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string) => {
    stdout += chunk;
    return true;
  }) as typeof process.stdout.write;
  const stderr = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.exitCode = undefined;
  try {
    await buildProgram().parseAsync(args, { from: 'user' });
    return { stdout, code: process.exitCode ?? 0 };
  } finally {
    process.stdout.write = write;
    process.stderr.write = stderr;
    process.exitCode = undefined;
  }
}

test('apply renders the changed site and prints the report as JSON', async () => {
  const { repo, templates } = fixture('clean', 'apple\n');
  const { stdout, code } = await plx('-y', '--json', 'apply', '--templates', templates, repo);
  assert.equal(code, 0);
  assert.equal(readFileSync(join(repo, 'list.txt'), 'utf8'), 'pear\n');
  assert.deepEqual(JSON.parse(stdout).sites, [
    { dir: '.', report: [{ path: 'list.txt', outcome: 'clean' }], defaults: {} },
  ]);
});

test('apply exits non-zero when a file is conflicted, and leaves the conflict in the file', async () => {
  const { repo, templates } = fixture('conflict', 'mine\n');
  const { stdout, code } = await plx('-y', 'apply', '--templates', templates, repo);
  assert.equal(code, 1);
  assert.match(
    readFileSync(join(repo, 'list.txt'), 'utf8'),
    /^<<<<<<< current\nmine\n=======\npear\n>>>>>>> new render\n$/,
  );
  assert.match(stdout, /conflicted list\.txt/);
});

test('apply is in the help, and names the root of templates as an option', () => {
  const help = buildProgram()
    .commands.find((c) => c.name() === 'apply')
    ?.helpInformation();
  assert.match(help ?? '', /--templates <dir>/);
});
