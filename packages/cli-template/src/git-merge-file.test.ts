// The real merge of one file, gitMergeFile: these tests run git. The rules of
// `merge` around it are tested with a fake in merge.test.ts.
//
// Cases ported from copier v9.19.1 name their original, file and test, in a
// comment; copier is MIT-licensed, see LICENSE.copier. Copier's labels differ
// from ours, and so do the expected files.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitMergeFile } from './index.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The merge of three texts, the result as text. */
async function mergeTexts(old: string, next: string, current: string) {
  const { bytes, conflicted } = await gitMergeFile({
    path: 'fruit.txt',
    old: encoder.encode(old),
    new: encoder.encode(next),
    current: encoder.encode(current),
  });
  return { text: decoder.decode(bytes), conflicted };
}

// Ported from tests/test_updatediff.py, test_update_needs_more_context: the
// template adds a function above, the user a line below, among similar blocks.
test('gitMergeFile merges changes to different parts of a file cleanly', async () => {
  const block = (name: string, extra = '') =>
    `def ${name}():\n${'    print("This line is equal to the next one.")\n'.repeat(2)}${extra}${'    print("This line is equal to the next one.")\n'.repeat(2)}    print("Previous line lied.")\n`;
  const old = `${block('function_one')}\n${block('function_two')}`;
  const next = `${block('function_zero')}\n${old}`;
  const current = `${block('function_one')}\n${block('function_two', '    print("This line is new.")\n')}`;
  assert.deepEqual(await mergeTexts(old, next, current), {
    text: `${block('function_zero')}\n${current}`,
    conflicted: false,
  });
});

// Ported from tests/test_updatediff.py, test_conflict_on_update_with_unicode_in_content.
test('gitMergeFile leaves a conflict in the file between its labels, current first, and reports it', async () => {
  assert.deepEqual(
    await mergeTexts('aaa🐍\nbbb🐍\nzzz🐍\n', 'aaa🐍\nbbb🐍\nccc🐍\nzzz🐍\n', 'aaa🐍\nbbb🐍\njjj🐍\nzzz🐍\n'),
    {
      text: 'aaa🐍\nbbb🐍\n<<<<<<< current\njjj🐍\n=======\nccc🐍\n>>>>>>> new render\nzzz🐍\n',
      conflicted: true,
    },
  );
});

// Ported from tests/test_updatediff.py, test_update_with_new_file_in_template_and_project.
test('gitMergeFile merges against an empty old side, and keeps what both sides share outside the conflict', async () => {
  const current =
    'tests:\n    stage: test\n    script:\n        - ./test.sh\n\npages:\n    stage: deploy\n    script:\n        - ./deploy.sh\n';
  const next = 'tests:\n    stage: test\n    script:\n        - ./test.sh --slow\n';
  assert.deepEqual(await mergeTexts('', next, current), {
    text: 'tests:\n    stage: test\n    script:\n<<<<<<< current\n        - ./test.sh\n\npages:\n    stage: deploy\n    script:\n        - ./deploy.sh\n=======\n        - ./test.sh --slow\n>>>>>>> new render\n',
    conflicted: true,
  });
});

test('gitMergeFile reports clean a file that merges cleanly although it holds lines that start like conflict markers', async () => {
  const lines = (fruit: string) =>
    `<<<<<<< HEAD\n<<<<<<< currently\n${fruit}\n=======\n>>>>>>> new render, almost\n>>>>>>>\n`;
  assert.deepEqual(
    await mergeTexts(`apple\n${lines('pear')}`, `apricot\n${lines('pear')}`, `apple\n${lines('plum')}`),
    {
      text: `apricot\n${lines('plum')}`,
      conflicted: false,
    },
  );
});

test('gitMergeFile carries bytes as they are: line endings, bytes that are not UTF-8, a missing final newline', async () => {
  const { bytes, conflicted } = await gitMergeFile({
    path: 'fruit.txt',
    old: Uint8Array.from([...encoder.encode('apple\r\npear\r\n'), 0xe9, 0x0d, 0x0a, ...encoder.encode('plum')]),
    new: Uint8Array.from([...encoder.encode('apricot\r\npear\r\n'), 0xe9, 0x0d, 0x0a, ...encoder.encode('plum')]),
    current: Uint8Array.from([...encoder.encode('apple\r\npear\r\n'), 0xe8, 0x0d, 0x0a, ...encoder.encode('plum')]),
  });
  assert.deepEqual(
    { bytes: [...bytes], conflicted },
    {
      bytes: [...encoder.encode('apricot\r\npear\r\n'), 0xe8, 0x0d, 0x0a, ...encoder.encode('plum')],
      conflicted: false,
    },
  );
});

test('gitMergeFile detects a conflict in a file with CRLF line endings, whose label lines end in CRLF too', async () => {
  assert.deepEqual(await mergeTexts('apple\r\n', 'pear\r\n', 'plum\r\n'), {
    text: '<<<<<<< current\r\nplum\r\n=======\r\npear\r\n>>>>>>> new render\r\n',
    conflicted: true,
  });
});

/** A conflict as git prints it in its default style, whatever configuration asks for another. */
const conflict = { text: '<<<<<<< current\nplum\n=======\npear\n>>>>>>> new render\n', conflicted: true };

/** Runs `body` with `vars` in the environment, and puts the environment back. */
async function withEnv(vars: Readonly<Record<string, string>>, body: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    await body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Runs `body` with a scratch directory, and removes it. */
async function withScratch(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'git-merge-file-test-'));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true });
  }
}

/** Makes `dir` a git repository whose own configuration asks for another conflict style. */
function initRepository(dir: string): void {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  execFileSync('git', ['init', '-q', dir], { env });
  execFileSync('git', ['config', 'merge.conflictStyle', 'diff3'], { cwd: dir, env });
}

test('gitMergeFile merges the same whatever global git configuration the caller has', async () => {
  await withScratch(async (dir) => {
    const config = join(dir, 'gitconfig');
    await writeFile(config, '[merge]\n\tconflictStyle = zdiff3\n');
    await withEnv({ GIT_CONFIG_GLOBAL: config }, async () => {
      assert.deepEqual(await mergeTexts('apple\n', 'pear\n', 'plum\n'), conflict);
    });
  });
});

test('gitMergeFile merges the same where the temporary directory lies in a git repository with a configuration of its own', async () => {
  await withScratch(async (dir) => {
    initRepository(dir);
    const temporary = join(dir, 'tmp');
    await mkdir(temporary);
    await withEnv({ TMPDIR: temporary }, async () => {
      assert.equal(tmpdir(), temporary, 'the temporary directory lies in the repository');
      assert.deepEqual(await mergeTexts('apple\n', 'pear\n', 'plum\n'), conflict);
    });
  });
});

test("gitMergeFile merges the same where the environment names a repository with a configuration of its own, as a hook's does", async () => {
  await withScratch(async (dir) => {
    initRepository(dir);
    await withEnv({ GIT_DIR: join(dir, '.git') }, async () => {
      assert.deepEqual(await mergeTexts('apple\n', 'pear\n', 'plum\n'), conflict);
    });
  });
});

test('gitMergeFile fails where git cannot merge, with what git said', async () => {
  await assert.rejects(
    gitMergeFile({
      path: 'fruit.bin',
      old: Uint8Array.from([1, 0, 1]),
      new: Uint8Array.from([1, 0, 2]),
      current: Uint8Array.from([1, 0, 3]),
    }),
    /fruit\.bin.*binary/s,
  );
});
