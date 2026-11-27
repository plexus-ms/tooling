// `plx-template render` as a process, on template directories of baskets and
// shelves in a scratch directory.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { test } from 'node:test';
import { plxTemplate, put, read, type Scratch, scratch } from './testing/run.ts';

const BASKET = [
  'name: basket',
  'questions:',
  '  fruit:',
  '    type: str',
  '    help: The fruit inside',
  '  count:',
  '    type: int',
  '    default: 3',
  'policies:',
  '  notes.md.jinja: born-once',
  'birth:',
  '  - [git, init]',
  '',
].join('\n');

/** A scratch directory holding a basket template, removed when `body` is done. */
function withBasket(body: (s: Scratch, basket: string) => void): void {
  const s = scratch();
  try {
    put(s.dir, {
      'basket/template.yml': BASKET,
      'basket/files/README.md.jinja': 'A basket of {{ count }} {{ fruit }}s.\n',
      'basket/files/notes.md.jinja': 'Notes on {{ fruit }}.\n',
      'basket/files/bin/count.sh': { text: '#!/bin/sh\necho 3\n', mode: 0o755 },
    });
    mkdirSync(s.path('basket/files/shelf/empty'), { recursive: true });
    body(s, s.path('basket'));
  } finally {
    s.remove();
  }
}

test('render writes the tree beside the policies, and prints the result as JSON', () => {
  withBasket((s, basket) => {
    put(s.dir, { 'answers.json': '{"fruit": "pear", "colour": "green"}' });
    const out = s.path('out');
    const run = plxTemplate(['render', '--answers', s.path('answers.json'), out, basket]);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(read(out), {
      'README.md': 'A basket of 3 pears.\n',
      'notes.md': 'Notes on pear.\n',
      'bin/count.sh': { text: '#!/bin/sh\necho 3\n', mode: 0o755 },
      'shelf/empty/': '',
    });
    assert.deepEqual(JSON.parse(run.stdout), {
      answers: { count: 3, fruit: 'pear' },
      unused: ['colour'],
      files: {
        'README.md': { template: 'basket', policy: 'merge' },
        'bin/count.sh': { template: 'basket', policy: 'merge' },
        'notes.md': { template: 'basket', policy: 'born-once' },
        'shelf/empty': { template: 'basket', policy: 'merge' },
      },
      birth: [{ template: 'basket', command: ['git', 'init'] }],
      errors: [],
    });
    assert.deepEqual(JSON.parse(read(s.dir)['out.plx-template.json'] as string), {
      files: JSON.parse(run.stdout).files,
    });
  });
});

test('render takes the answers from standard input with -', () => {
  withBasket((s, basket) => {
    const out = s.path('out');
    const run = plxTemplate(['render', '--answers', '-', out, basket], '{"fruit": "plum", "count": 5}');
    assert.equal(run.code, 0, run.stderr);
    assert.equal(read(out)['README.md'], 'A basket of 5 plums.\n');
    assert.deepEqual(JSON.parse(run.stdout).answers, { count: 5, fruit: 'plum' });
  });
});

/** What a failed render left behind: nothing of the render. */
function assertNothingWritten(out: string): void {
  assert.equal(existsSync(out), false, 'no output directory');
  assert.equal(existsSync(`${out}.plx-template.json`), false, 'no policies file');
}

test('an error in the inputs is code 3: every error listed in the JSON and on standard error, nothing written', () => {
  withBasket((s, basket) => {
    put(s.dir, {
      'shelf/template.yml': 'name: shelf\nreads:\n  colour:\nquestions:\n  height:\n    help: How high\n',
      'shelf/files/README.md': 'a shelf\n',
    });
    const out = s.path('out');
    const run = plxTemplate(['render', out, basket, s.path('shelf')]);
    assert.equal(run.code, 3);
    const { errors, files } = JSON.parse(run.stdout);
    assert.deepEqual(files, {});
    assert.deepEqual(
      errors.map((e: { template: string; question?: string; path?: string; other?: string }) => [
        e.template,
        e.question,
        e.other,
      ]),
      [
        ['basket', 'fruit', undefined],
        ['shelf', 'colour', undefined],
        ['shelf', 'height', undefined],
      ],
    );
    for (const e of errors) assert.match(run.stderr, new RegExp(e.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(run.stderr, /How high/);
    assertNothingWritten(out);
  });
});

test('two templates writing one path are an error naming both, in template and other', () => {
  withBasket((s, basket) => {
    put(s.dir, {
      'shelf/template.yml': 'name: shelf\n',
      'shelf/files/README.md.jinja': 'a shelf\n',
    });
    const out = s.path('out');
    const run = plxTemplate(['render', '--answers', '-', out, basket, s.path('shelf')], '{"fruit": "fig"}');
    assert.equal(run.code, 3);
    const [error] = JSON.parse(run.stdout).errors;
    assert.deepEqual([error.template, error.other], ['basket', 'shelf']);
    assert.match(error.path, /README\.md/);
    assert.match(run.stderr, /other template shelf/);
    assertNothingWritten(out);
  });
});

test('an output directory that is not empty is refused, and nothing in it is touched', () => {
  withBasket((s, basket) => {
    const out = s.path('out');
    put(s.dir, { 'out/mine.txt': 'mine\n' });
    const run = plxTemplate(['render', '--answers', '-', out, basket], '{"fruit": "fig"}');
    assert.equal(run.code, 3);
    assert.deepEqual(JSON.parse(run.stdout).errors, [{ message: 'is not empty', path: out }]);
    assert.deepEqual(read(out), { 'mine.txt': 'mine\n' });
    assert.equal(existsSync(`${out}.plx-template.json`), false);
  });
});

test('an empty output directory is taken, a missing one, with its parents, is created', () => {
  withBasket((s, basket) => {
    mkdirSync(s.path('empty'));
    for (const out of [s.path('empty'), s.path('deep/er/out')]) {
      const run = plxTemplate(['render', '--answers', '-', out, basket], '{"fruit": "fig"}');
      assert.equal(run.code, 0, run.stderr);
      assert.equal(read(out)['README.md'], 'A basket of 3 figs.\n');
    }
  });
});

test('answers that cannot be read, are no JSON or no object, a template directory that is missing: code 3 each, all listed', () => {
  withBasket((s, basket) => {
    put(s.dir, { 'list.json': '[1]', 'bad.json': '{' });
    const cases: [string[], string][] = [
      [['--answers', s.path('absent.json'), s.path('o1'), basket], s.path('absent.json')],
      [['--answers', s.path('bad.json'), s.path('o2'), basket], s.path('bad.json')],
      [['--answers', s.path('list.json'), s.path('o3'), basket], s.path('list.json')],
      [['--answers', '-', s.path('o4'), s.path('no-such')], s.path('no-such')],
    ];
    for (const [args, path] of cases) {
      const run = plxTemplate(['render', ...args], '{"fruit": "fig"}');
      assert.equal(run.code, 3, args.join(' '));
      assert.ok(
        JSON.parse(run.stdout).errors.some((e: { path?: string }) => e.path === path),
        args.join(' '),
      );
    }
    const both = plxTemplate([
      'render',
      '--answers',
      s.path('bad.json'),
      s.path('o5'),
      s.path('no-such'),
      s.path('also-not'),
    ]);
    assert.equal(JSON.parse(both.stdout).errors.length, 3);
    assertNothingWritten(s.path('o5'));
  });
});

test('a symlink in a template is an error, and a template that holds nothing is one', () => {
  withBasket((s, basket) => {
    symlinkSync('README.md.jinja', s.path('basket/files/link'));
    mkdirSync(s.path('void'));
    const run = plxTemplate(['render', '--answers', '-', s.path('out'), basket, s.path('void')], '{"fruit": "fig"}');
    assert.equal(run.code, 3);
    const errors = JSON.parse(run.stdout).errors;
    assert.ok(errors.some((e: { path?: string }) => e.path === 'files/link'));
    assert.ok(errors.some((e: { template: string }) => e.template === '#2'));
  });
});
