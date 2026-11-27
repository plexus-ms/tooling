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
