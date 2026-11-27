// The spec ring for `merge`: each rule of merge.ts's header, through `merge`
// alone, with a fake merge of one file that records the sides it was given.
// The real one, git-merge-file.ts, has tests of its own.
//
// Cases ported from copier v9.19.1 name their original, file and test, in a
// comment; copier is MIT-licensed, see LICENSE.copier.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type MergeFile, merge, type Policies, REGULAR } from './index.ts';
import { type Listing, listing, tree } from './testing/trees.ts';

interface Case {
  readonly old?: Listing;
  readonly new?: Listing;
  readonly current?: Listing;
  /** The paths whose policy is born-once, in both renders. */
  readonly bornOnce?: readonly string[];
  /** What the fake merge of one file reports. */
  readonly conflicted?: boolean;
}

/** The text of one side as the fake was given it. */
type Sides = Readonly<Record<'path' | 'old' | 'new' | 'current', string>>;

const decoder = new TextDecoder();

/** `merge` over the three listings, its tree as a listing, its report as `path: outcome` lines, and the fake's calls. */
async function run(c: Case) {
  const calls: Sides[] = [];
  const mergeFile: MergeFile = async (sides) => {
    calls.push({
      path: sides.path,
      old: decoder.decode(sides.old),
      new: decoder.decode(sides.new),
      current: decoder.decode(sides.current),
    });
    return { bytes: new TextEncoder().encode('merged\n'), conflicted: c.conflicted ?? false };
  };
  const policies = (l: Listing): Policies =>
    new Map(Object.keys(l).map((path) => [path, { policy: c.bornOnce?.includes(path) ? 'born-once' : 'merge' }]));
  const old = c.old ?? {};
  const next = c.new ?? {};
  const result = await merge(
    {
      old: tree(old),
      new: tree(next),
      current: tree(c.current ?? {}),
      files: { old: policies(old), new: policies(next) },
    },
    mergeFile,
  );
  return {
    tree: listing(result.tree),
    report: result.report.map(({ path, outcome }) => `${path}: ${outcome}`),
    calls,
  };
}

test('merge leaves a path alone that both renders hold alike, edited or deleted, and reports nothing for it', async () => {
  const result = await run({
    old: { 'apple.txt': 'red\n', 'pear.txt': 'green\n', 'plum.txt': 'blue\n' },
    new: { 'apple.txt': 'red\n', 'pear.txt': 'green\n', 'plum.txt': 'blue\n' },
    current: { 'apple.txt': 'crimson\n', 'plum.txt': 'blue\n' },
  });
  assert.deepEqual(result, {
    tree: { 'apple.txt': 'crimson\n', 'plum.txt': 'blue\n' },
    report: [],
    calls: [],
  });
});

test('merge leaves a path alone that neither render holds: it is the user’s, untouched and unreported', async () => {
  const result = await run({
    old: { 'apple.txt': 'red\n' },
    new: { 'apple.txt': 'red\n' },
    current: {
      'apple.txt': 'red\n',
      'basket/cherry.txt': 'dark red\n',
      'basket/notes': { text: '#!/bin/sh\n', mode: REGULAR | 0o755 },
    },
  });
  assert.deepEqual(result, {
    tree: {
      'apple.txt': 'red\n',
      'basket/cherry.txt': 'dark red\n',
      'basket/notes': { text: '#!/bin/sh\n', mode: REGULAR | 0o755 },
    },
    report: [],
    calls: [],
  });
});

// Ported from tests/test_updatediff.py, test_update_deleted_path: the part of
// `dont_wildmatch`, a file the template changes and the user did not.
test('merge gives a path the user did not edit the new render’s entry, and reports it as clean, in path order', async () => {
  const result = await run({
    old: { 'pear.txt': 'green\n', 'apple.txt': 'red\n', 'basket/cherry.txt': 'dark red\n' },
    new: {
      'pear.txt': 'yellow\n',
      'apple.txt': 'red\r\n',
      'basket/cherry.txt': { bytes: [0xe9], mode: REGULAR | 0o644 },
    },
    current: { 'pear.txt': 'green\n', 'apple.txt': 'red\n', 'basket/cherry.txt': 'dark red\n' },
  });
  assert.deepEqual(result, {
    tree: {
      'pear.txt': 'yellow\n',
      'apple.txt': 'red\r\n',
      'basket/cherry.txt': { bytes: [0xe9], mode: REGULAR | 0o644 },
    },
    report: ['apple.txt: clean', 'basket/cherry.txt: clean', 'pear.txt: clean'],
    calls: [],
  });
});

test('merge merges a path that differs on all three sides with the merge of one file, line endings unnormalised, and reports it clean', async () => {
  const result = await run({
    old: { 'apple.txt': 'red\nround\n', 'pear.txt': 'green\n' },
    new: { 'apple.txt': 'red\nround\nsweet\n', 'pear.txt': 'yellow\n' },
    current: { 'apple.txt': 'crimson\nround\n', 'pear.txt': 'green\r\n' },
  });
  assert.deepEqual(result, {
    tree: { 'apple.txt': 'merged\n', 'pear.txt': 'merged\n' },
    report: ['apple.txt: clean', 'pear.txt: clean'],
    calls: [
      { path: 'apple.txt', old: 'red\nround\n', new: 'red\nround\nsweet\n', current: 'crimson\nround\n' },
      { path: 'pear.txt', old: 'green\n', new: 'yellow\n', current: 'green\r\n' },
    ],
  });
});

test('merge reports as conflicted a path whose merge of one file holds a conflict, and keeps the markers in the file', async () => {
  const result = await run({
    old: { 'apple.txt': 'red\n' },
    new: { 'apple.txt': 'green\n' },
    current: { 'apple.txt': 'crimson\n' },
    conflicted: true,
  });
  assert.deepEqual(result, {
    tree: { 'apple.txt': 'merged\n' },
    report: ['apple.txt: conflicted'],
    calls: [{ path: 'apple.txt', old: 'red\n', new: 'green\n', current: 'crimson\n' }],
  });
});

test('merge reports as clean a path the user already changed as the template did, without merging it', async () => {
  const result = await run({
    old: { 'apple.txt': 'red\n' },
    new: { 'apple.txt': 'green\n' },
    current: { 'apple.txt': 'green\n' },
  });
  assert.deepEqual(result, { tree: { 'apple.txt': 'green\n' }, report: ['apple.txt: clean'], calls: [] });
});

test('merge writes a path the new render adds and the current tree lacks, and reports it as added', async () => {
  const result = await run({
    old: { 'apple.txt': 'red\n' },
    new: { 'apple.txt': 'red\n', 'basket/pear.txt': 'green\n' },
    current: { 'apple.txt': 'red\n' },
  });
  assert.deepEqual(result, {
    tree: { 'apple.txt': 'red\n', 'basket/pear.txt': 'green\n' },
    report: ['basket/pear.txt: added'],
    calls: [],
  });
});

// Ported from tests/test_updatediff.py,
// test_update_with_new_file_in_template_and_project: both sides add the file.
test('merge merges a path the new render adds and the current tree already has against an empty old side', async () => {
  const result = await run({
    new: { 'basket.yml': 'apple:\n  colour: green\n', 'empty.txt': 'pear\n' },
    current: { 'basket.yml': 'apple:\n  colour: red\n\npear:\n  colour: yellow\n', 'empty.txt': '' },
  });
  assert.deepEqual(result, {
    tree: { 'basket.yml': 'merged\n', 'empty.txt': 'pear\n' },
    report: ['basket.yml: clean', 'empty.txt: clean'],
    calls: [
      {
        path: 'basket.yml',
        old: '',
        new: 'apple:\n  colour: green\n',
        current: 'apple:\n  colour: red\n\npear:\n  colour: yellow\n',
      },
    ],
  });
});

// Ported from tests/test_updatediff.py, test_file_removed: the template drops
// files and directories the user never edited, beside files of the user's own.
test('merge deletes a path the new render drops and the user never edited, and reports it as deleted', async () => {
  const result = await run({
    old: {
      '1.txt': 'content 1',
      'dir 2/2.txt': 'content 2',
      'dir 3/subdir 3/3.txt': 'content 3',
      'dir 4/subdir 4/4.txt': 'content 4',
    },
    new: { '6.txt': 'content 6' },
    current: {
      '1.txt': 'content 1',
      'dir 2/2.txt': 'content 2',
      'dir 3/subdir 3/3.txt': 'content 3',
      'dir 4/subdir 4/4.txt': 'content 4',
      'I.txt': 'content I',
      'dir 3/subdir III/III.txt': 'content III',
      'dir 4/subdir 4/IV.txt': 'content IV',
    },
  });
  assert.deepEqual(result, {
    tree: {
      '6.txt': 'content 6',
      'I.txt': 'content I',
      'dir 3/subdir III/III.txt': 'content III',
      'dir 4/subdir 4/IV.txt': 'content IV',
    },
    report: [
      '1.txt: deleted',
      '6.txt: added',
      'dir 2/2.txt: deleted',
      'dir 3/subdir 3/3.txt: deleted',
      'dir 4/subdir 4/4.txt: deleted',
    ],
    calls: [],
  });
});

// Ported from tests/test_updatediff.py, test_file_removed, where our rule
// differs: copier deletes the file the template drops even when the user
// edited it; merge keeps it.
test('merge keeps a path the new render drops and the user edited, and reports it as conflicted', async () => {
  const result = await run({
    old: { '1.txt': 'content 1', 'dir 2/2.txt': 'content 2' },
    new: {},
    current: { '1.txt': 'content 1, edited', 'dir 2/2.txt': 'content 2\r\n' },
  });
  assert.deepEqual(result, {
    tree: { '1.txt': 'content 1, edited', 'dir 2/2.txt': 'content 2\r\n' },
    report: ['1.txt: conflicted', 'dir 2/2.txt: conflicted'],
    calls: [],
  });
});

test('merge keeps the user’s edits to a file the template renames, as a deletion of the old name, conflicted, and an addition', async () => {
  const result = await run({
    old: { 'apple.txt': 'red\nround\n' },
    new: { 'fruit/apple.txt': 'red\nround\n' },
    current: { 'apple.txt': 'red\nround\ncrisp\n' },
  });
  assert.deepEqual(result, {
    tree: { 'apple.txt': 'red\nround\ncrisp\n', 'fruit/apple.txt': 'red\nround\n' },
    report: ['apple.txt: conflicted', 'fruit/apple.txt: added'],
    calls: [],
  });
});

// Ported from tests/test_updatediff.py, test_update_deleted_path: the user
// deleted a file the template changes; names as copier's parameters have them.
test('merge leaves absent a path the user deleted, even where the template changed or dropped it, and reports it as kept', async () => {
  const names = ['normal_file', 'unicode_âñ', 'file with whitespace', ' leading_whitespace', '!special', 'back\\slash'];
  const result = await run({
    old: { ...Object.fromEntries(names.map((name) => [name, 'foo'])), 'pear.txt': 'green\n' },
    new: Object.fromEntries(names.map((name) => [name, 'bar'])),
  });
  assert.deepEqual(result, {
    tree: {},
    report: [...names, 'pear.txt'].sort().map((name) => `${name}: kept`),
    calls: [],
  });
});

// Ported from tests/test_updatediff.py, test_skip_update_deleted: a born-once
// file the user deleted is written again, names as copier's parameters have them.
test('merge writes a born-once path the current tree lacks, changed or not, and reports it as added', async () => {
  const names = ['skip_normal_file', 'skip file with whitespace', ' skip_leading_whitespace', '!skip_special'];
  const result = await run({
    old: { ...Object.fromEntries(names.map((name) => [name, '1'])), 'apple.txt': 'red\n' },
    new: { ...Object.fromEntries(names.map((name) => [name, '1'])), 'apple.txt': 'green\n' },
    current: { another_file: 'foobar' },
    bornOnce: [...names, 'apple.txt'],
  });
  assert.deepEqual(result, {
    tree: { ...Object.fromEntries(names.map((name) => [name, '1'])), 'apple.txt': 'green\n', another_file: 'foobar' },
    report: [...names, 'apple.txt'].sort().map((name) => `${name}: added`),
    calls: [],
  });
});

// Ported from tests/test_updatediff.py, test_skip_update: a born-once file the
// template changes is never touched, edited or not.
test('merge never touches a born-once path the current tree has, and reports it as kept where the template changed it', async () => {
  const result = await run({
    old: { skip_me: '1', 'apple.txt': 'red\n', 'pear.txt': 'green\n' },
    new: { skip_me: '3', 'apple.txt': 'green\n', 'pear.txt': 'green\n' },
    current: { skip_me: '2', 'apple.txt': 'red\n', 'pear.txt': 'yellow\n' },
    bornOnce: ['skip_me', 'apple.txt', 'pear.txt'],
  });
  assert.deepEqual(result, {
    tree: { skip_me: '2', 'apple.txt': 'red\n', 'pear.txt': 'yellow\n' },
    report: ['apple.txt: kept', 'skip_me: kept'],
    calls: [],
  });
});

test('merge keeps a born-once path the template drops, edited or not, and reports it as kept', async () => {
  const result = await run({
    old: { 'apple.txt': 'red\n', 'pear.txt': 'green\n' },
    new: {},
    current: { 'apple.txt': 'red\n', 'pear.txt': 'yellow\n' },
    bornOnce: ['apple.txt', 'pear.txt'],
  });
  assert.deepEqual(result, {
    tree: { 'apple.txt': 'red\n', 'pear.txt': 'yellow\n' },
    report: ['apple.txt: kept', 'pear.txt: kept'],
    calls: [],
  });
});

test('merge keeps a born-once path that no longer renders, its name rendering empty, edited or not, and reports it as kept', async () => {
  // The old render had `{{ colour }}/notes.txt` as `red/notes.txt`; the new
  // answer renders the directory's name empty, which drops the file.
  const result = await run({
    old: { 'red/notes.txt': 'red\n', 'red/label.txt': 'red\n', 'basket.txt': 'apples\n' },
    new: { 'basket.txt': 'apples\n' },
    current: { 'red/notes.txt': 'red\n', 'red/label.txt': 'crimson\n', 'basket.txt': 'apples\n' },
    bornOnce: ['red/notes.txt', 'red/label.txt'],
  });
  assert.deepEqual(result, {
    tree: { 'red/notes.txt': 'red\n', 'red/label.txt': 'crimson\n', 'basket.txt': 'apples\n' },
    report: ['red/label.txt: kept', 'red/notes.txt: kept'],
    calls: [],
  });
});

test('merge keeps the current file where all three sides differ and one is binary, by a NUL byte, and reports it as conflicted', async () => {
  const binary = (...bytes: number[]) => ({ bytes, mode: REGULAR | 0o644 });
  const result = await run({
    old: { 'apple.png': binary(0xff, 0, 1), 'pear.txt': 'green\n', 'plum.png': binary(0xff, 0, 1) },
    new: { 'apple.png': binary(0xff, 0, 2), 'pear.txt': binary(0xfe, 0, 2), 'plum.png': binary(0xff, 0, 2) },
    current: { 'apple.png': binary(0xff, 0, 3), 'pear.txt': 'yellow\n', 'plum.png': binary(0xff, 0, 1) },
  });
  assert.deepEqual(result, {
    tree: { 'apple.png': binary(0xff, 0, 3), 'pear.txt': 'yellow\n', 'plum.png': binary(0xff, 0, 2) },
    report: ['apple.png: conflicted', 'pear.txt: conflicted', 'plum.png: clean'],
    calls: [],
  });
});

test('merge takes a file as binary by a NUL byte among its first 8000 bytes only, as git does', async () => {
  const late = `${'a'.repeat(8000)}\0`;
  const result = await run({
    old: { 'apple.txt': `red\n${late}` },
    new: { 'apple.txt': `green\n${late}` },
    current: { 'apple.txt': `crimson\n${late}` },
  });
  assert.deepEqual(result.report, ['apple.txt: clean']);
  assert.deepEqual(
    result.calls.map((c) => c.path),
    ['apple.txt'],
  );
});
