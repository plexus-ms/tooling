// `plx new` through the program, with fixture templates and no birth
// commands: the arguments reach the verb, the answers come from the flags and
// from a JSON file, and the result is printed.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { buildProgram, version } from '../program.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'plx-new-cli-')));
after(() => rmSync(dir, { recursive: true, force: true }));

const put = (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

const templates = join(dir, 'templates');
put(join(templates, 'shop'), {
  'template.yml': [
    'name: shop',
    'questions:',
    '  tenant:',
    '    type: str',
    '    help: The tenant slug',
    '  stalls:',
    '    type: int',
    '    default: 2',
    '  open:',
    '    type: bool',
    '    default: false',
    '',
  ].join('\n'),
  'files/PLEXUS.md.jinja': '- A shop.\n',
  'files/sign.txt.jinja': '{{ tenant }} {{ stalls }} {{ open }}\n',
});

let count = 0;
const fresh = () => join(dir, `site-${count++}`);

/** Runs `plx` with `args`, returning what it printed and the exit code it asked for. */
async function plx(...args: string[]) {
  let stdout = '';
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

test('new takes the directory, the templates and answers as key=value, cast to their types', async () => {
  const target = fresh();
  const { stdout, code } = await plx(
    'new',
    '--templates',
    templates,
    target,
    'shop',
    '-a',
    'tenant=acme',
    '-a',
    'stalls=3',
    '-a',
    'open=true',
  );
  assert.equal(code, 0);
  assert.equal(readFileSync(join(target, 'sign.txt'), 'utf8'), 'acme 3 True\n');
  assert.equal(
    readFileSync(join(target, 'PLEXUS.md'), 'utf8'),
    `---\nversion: ${version}\ntemplates: [shop]\nopen: true\nstalls: 3\ntenant: acme\n---\n\n- A shop.\n`,
  );
  assert.match(stdout, /^repo .*site-\d+$/m);
});

test('new reads answers from a JSON file, and an answer flag wins over the file', async () => {
  const target = fresh();
  const file = join(dir, 'answers.json');
  writeFileSync(file, JSON.stringify({ tenant: 'acme', stalls: 5 }));
  const { code } = await plx('new', '--templates', templates, '--answers', file, '-a', 'stalls=6', target, 'shop');
  assert.equal(code, 0);
  assert.match(readFileSync(join(target, 'PLEXUS.md'), 'utf8'), /\nstalls: 6\ntenant: acme\n/);
});

test('new --json prints what it created', async () => {
  const target = fresh();
  const { stdout } = await plx('--json', 'new', '--templates', templates, target, 'shop', '-a', 'tenant=acme');
  const created = JSON.parse(stdout);
  assert.equal(created.kind, 'repo');
  assert.deepEqual(created.answers, { open: false, stalls: 2, tenant: 'acme' });
  assert.deepEqual(created.files, ['PLEXUS.md', 'sign.txt']);
});

test('new --dry-run writes nothing', async () => {
  const target = fresh();
  const { code } = await plx('-n', 'new', '--templates', templates, target, 'shop', '-a', 'tenant=acme');
  assert.equal(code, 0);
  assert.equal(existsSync(target), false);
});

test('new without a required answer fails and lists the question with its help', async () => {
  const target = fresh();
  await assert.rejects(
    plx('new', '--templates', templates, target, 'shop'),
    /tenant.*The tenant slug|The tenant slug/s,
  );
  assert.equal(existsSync(target), false);
});

test('an answer that is no key=value is a usage error', async () => {
  const { UsageError } = await import('@plexus-ms/lib');
  await assert.rejects(plx('new', '--templates', templates, fresh(), 'shop', '-a', 'tenant'), UsageError);
});

test('an answers file that is no JSON object is a usage error', async () => {
  const { UsageError } = await import('@plexus-ms/lib');
  const file = join(dir, 'list.json');
  writeFileSync(file, '[1]');
  await assert.rejects(plx('new', '--templates', templates, '--answers', file, fresh(), 'shop'), UsageError);
});

test('a missing answers file is a usage error naming the option', async () => {
  const { UsageError } = await import('@plexus-ms/lib');
  await assert.rejects(
    plx('new', '--templates', templates, '--answers', join(dir, 'absent.json'), fresh(), 'shop'),
    (error: Error) => error instanceof UsageError && /--answers/.test(error.message),
  );
});

test('an answers file that is no JSON is a usage error naming the option', async () => {
  const { UsageError } = await import('@plexus-ms/lib');
  const file = join(dir, 'broken.json');
  writeFileSync(file, '{');
  await assert.rejects(
    plx('new', '--templates', templates, '--answers', file, fresh(), 'shop'),
    (error: Error) => error instanceof UsageError && /--answers/.test(error.message),
  );
});

test('new is in the help, with its options', () => {
  const help = buildProgram()
    .commands.find((c) => c.name() === 'new')
    ?.helpInformation();
  assert.match(help ?? '', /-a, --answer <key=value>/);
  assert.match(help ?? '', /--answers <file>/);
  assert.match(help ?? '', /--templates <dir>/);
});
