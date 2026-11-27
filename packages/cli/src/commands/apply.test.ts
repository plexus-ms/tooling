// `plx apply` through the program, on a scratch repo with fixture templates
// (real git, as the lib's tests): the arguments reach the verb, the report is
// the result on standard output, and a conflict makes the exit code non-zero.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { buildProgram, version } from '../program.ts';
import { outcomeOf } from './apply.ts';

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
  // The test runner reports through this stream in bytes; only the verb's text is taken.
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk !== 'string') return (write as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
    stdout += chunk;
    return true;
  }) as typeof process.stdout.write;
  let diagnostics = '';
  const stderr = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    diagnostics += Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  process.exitCode = undefined;
  try {
    await buildProgram().parseAsync(args, { from: 'user' });
    return { stdout, stderr: diagnostics, code: process.exitCode ?? 0 };
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

test('apply takes the repo and the templates relative to the working directory', async () => {
  const { repo, templates } = fixture('relative', 'apple\n');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const { code } = await plx('-y', 'apply', '--templates', basename(templates), basename(repo));
    assert.equal(code, 0);
  } finally {
    process.chdir(cwd);
  }
  assert.equal(readFileSync(join(repo, 'list.txt'), 'utf8'), 'pear\n');
});

test('apply prints the defaults it writes into a marker, and says what it did on its last line', async () => {
  const { repo, templates } = fixture('defaults', 'apple\n');
  put(join(templates, 'shelf'), {
    'template.yml': 'name: shelf\nquestions:\n  width:\n    type: int\n    default: 4\n',
    'files/shelf.txt': 'a shelf\n',
  });
  put(repo, { 'PLEXUS.md': `---\nversion: ${version}\ntemplates: [basket, shelf]\nfruit: pear\n---\n` });
  const { stdout, stderr, code } = await plx('-y', 'apply', '--templates', templates, repo);
  assert.equal(code, 0);
  assert.match(stdout, /^ {2}\+ width: 4$/m);
  assert.match(stderr, /✓ applied; review the diff, then commit\n$/);
});

test('apply says so on its last line when a conflict is left', async () => {
  const { repo, templates } = fixture('lastline', 'mine\n');
  const { stderr } = await plx('-y', 'apply', '--templates', templates, repo);
  assert.match(stderr, /✗ 1 conflicted: resolve them, then commit\n$/);
});

test('apply prints a line for a site it re-rendered without a change to any file', async () => {
  const { repo, templates } = fixture('identical', 'apple\n');
  put(repo, { 'PLEXUS.md': `---\nversion: ${version}\ntemplates: [basket]\nfruit: apple\nnote: 1\n---\n` });
  const { stdout, stderr, code } = await plx('-y', 'apply', '--templates', templates, repo);
  assert.equal(code, 0);
  assert.match(stdout, /^\.: re-rendered, no file changed$/m);
  assert.match(stderr, /✓ the markers changed nothing in the files\n$/);
});

test('a dry run writes nothing and exits 0 even where a file would conflict', async () => {
  const { repo, templates } = fixture('dry', 'mine\n');
  const { stderr, code } = await plx('-n', 'apply', '--templates', templates, repo);
  assert.equal(code, 0);
  assert.equal(readFileSync(join(repo, 'list.txt'), 'utf8'), 'mine\n');
  assert.match(stderr, /✓ dry run: nothing written, 1 file would be conflicted\n$/);
});

test('nothing to apply is said, and exits 0', async () => {
  const { repo, templates } = fixture('nothing', 'apple\n');
  put(repo, { 'PLEXUS.md': marker('apple') });
  const { stderr, code } = await plx('-y', 'apply', '--templates', templates, repo);
  assert.equal(code, 0);
  assert.match(stderr, /✓ nothing to apply: no marker differs from HEAD\n$/);
});

test('an answer of no writes nothing and fails: the outcome says so', () => {
  const sites = [{ dir: '.', report: [{ path: 'a', outcome: 'clean' as const }], defaults: {} }];
  assert.deepEqual(outcomeOf({ sites, conflicted: 0, applied: false, declined: true }, false), {
    line: 'nothing written: the answer was no',
    ok: false,
    code: 1,
  });
});

test('apply names a templates root it was given relatively by its absolute path', async () => {
  const { repo, templates } = fixture('named', 'apple\n');
  put(repo, { 'PLEXUS.md': `---\nversion: ${version}\ntemplates: [basket, ghost]\nfruit: pear\n---\n` });
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await assert.rejects(plx('-y', 'apply', '--templates', basename(templates), repo), (error: Error) => {
      assert.ok(error.message.includes(`no template ghost in ${templates}`), error.message);
      return true;
    });
  } finally {
    process.chdir(cwd);
  }
});

test('apply takes a repo given relatively as the repo it is, not as a directory inside one', async () => {
  const { repo, templates } = fixture('top', 'apple\n');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const { stderr } = await plx('-y', 'apply', '--templates', templates, basename(repo));
    assert.doesNotMatch(stderr, /using the top of the repo/);
  } finally {
    process.chdir(cwd);
  }
});
