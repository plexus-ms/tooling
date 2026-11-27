// The spec ring for `merge`: each rule of merge.ts's header, through `merge`
// alone, with a fake merge of one file that records the sides it was given.
// The real one, git-merge-file.ts, has tests of its own.
//
// Cases ported from copier v9.19.1 name their original, file and test, in a
// comment; copier is MIT-licensed, see LICENSE.copier.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIRECTORY, type MergeFile, merge, type Policies, REGULAR, SYMLINK } from './index.ts';
import { type Listing, listing, tree } from './testing/trees.ts';

interface Case {
  readonly old?: Listing;
  readonly new?: Listing;
  readonly current?: Listing;
  /** The paths whose policy is born-once: in both renders, or in each. */
  readonly bornOnce?: readonly string[] | { readonly old: readonly string[]; readonly new: readonly string[] };
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
  const bornOnce = c.bornOnce ?? [];
  const { old: bornOld, new: bornNew } = 'old' in bornOnce ? bornOnce : { old: bornOnce, new: bornOnce };
  const policies = (l: Listing, born: readonly string[]): Policies =>
    new Map(Object.keys(l).map((path) => [path, { policy: born.includes(path) ? 'born-once' : 'merge' }]));
  const old = c.old ?? {};
  const next = c.new ?? {};
  const result = await merge(
    {
      old: tree(old),
      new: tree(next),
      current: tree(c.current ?? {}),
      files: { old: policies(old, bornOld), new: policies(next, bornNew) },
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
// deleted a file the template changes, with every name of copier's parameters.
test('merge leaves absent a path the user deleted, even where the template changed or dropped it, and reports it as kept', async () => {
  const names = [
    'normal_file',
    'unicode_âñ',
    'file with whitespace',
    ' leading_whitespace',
    'trailing_whitespace ',
    '   multi_whitespace   ',
    '\tother_whitespace\t\\t',
    '\x07\f\n\t\vcontrol\x07\f\n\t\vcharacters\v\t\n\f\x07',
    'back\\slash',
    '!special',
    'dont_wildmatch*',
  ];
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

// Ported from tests/test_updatediff.py, test_skip_update_deleted, where our
// rule differs: copier writes a skipped file the user deleted again on an
// update; merge leaves it absent, like any file the user deleted, since the old
// render holding it means it was born.
test('merge leaves absent a born-once path the old render holds and the current tree lacks, changed or not, and reports it as kept where the template changed it', async () => {
  const names = [
    'skip_normal_file',
    'skip_unicode_âñ',
    'skip file with whitespace',
    ' skip_leading_whitespace',
    'skip_trailing_whitespace ',
    '   skip_multi_whitespace   ',
    '\tskip_other_whitespace\t\\t',
    '\x07\f\n\t\vskip_control\x07\f\n\t\vcharacters\v\t\n\f\x07',
    'skip_back\\slash',
    '!skip_special',
    'sk\\ip_with_backslash_in_skip_pattern',
  ];
  const result = await run({
    old: { ...Object.fromEntries(names.map((name) => [name, '1'])), 'apple.txt': 'red\n' },
    new: { ...Object.fromEntries(names.map((name) => [name, '1'])), 'apple.txt': 'green\n' },
    current: { another_file: 'foobar' },
    bornOnce: [...names, 'apple.txt'],
  });
  assert.deepEqual(result, {
    tree: { another_file: 'foobar' },
    report: ['apple.txt: kept'],
    calls: [],
  });
});

test('merge writes a born-once path at birth, where neither the old render nor the current tree holds it, and reports it as added', async () => {
  // A template the old render lacks altogether, as when a directory takes it
  // on, and one that adds a born-once file in a later version.
  const result = await run({
    old: { 'basket.txt': 'apples\n' },
    new: { 'basket.txt': 'apples\n', 'shelf/label.txt': 'oak\n', 'notes.md': 'notes\n' },
    current: { 'basket.txt': 'apples\n', 'shelf/index.txt': 'mine\n' },
    bornOnce: ['shelf/label.txt', 'notes.md'],
  });
  assert.deepEqual(result, {
    tree: {
      'basket.txt': 'apples\n',
      'shelf/index.txt': 'mine\n',
      'shelf/label.txt': 'oak\n',
      'notes.md': 'notes\n',
    },
    report: ['notes.md: added', 'shelf/label.txt: added'],
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

// Ported from tests/test_updatediff.py, test_update_propagates_executable_bit_addition
// and test_update_propagates_executable_bit_removal: the template flips the bit
// and nothing else.
test('merge takes a change of the executable bit alone as a change, both ways', async () => {
  const result = await run({
    old: { 'launcher.sh': '#!/bin/sh\necho hi\n', 'stopper.sh': { text: '#!/bin/sh\n', mode: REGULAR | 0o755 } },
    new: { 'launcher.sh': { text: '#!/bin/sh\necho hi\n', mode: REGULAR | 0o755 }, 'stopper.sh': '#!/bin/sh\n' },
    current: { 'launcher.sh': '#!/bin/sh\necho hi\n', 'stopper.sh': { text: '#!/bin/sh\n', mode: REGULAR | 0o755 } },
  });
  assert.deepEqual(result, {
    tree: { 'launcher.sh': { text: '#!/bin/sh\necho hi\n', mode: REGULAR | 0o755 }, 'stopper.sh': '#!/bin/sh\n' },
    report: ['launcher.sh: clean', 'stopper.sh: clean'],
    calls: [],
  });
});

test('merge compares a current file’s mode by the executable bit alone, and writes the new render’s mode', async () => {
  const result = await run({
    old: { 'apple.sh': { text: 'red\n', mode: REGULAR | 0o755 }, 'pear.txt': 'green\n' },
    new: { 'apple.sh': { text: 'green\n', mode: REGULAR | 0o755 }, 'pear.txt': 'yellow\n' },
    current: {
      'apple.sh': { text: 'red\n', mode: REGULAR | 0o775 },
      'pear.txt': { text: 'green\n', mode: REGULAR | 0o664 },
    },
  });
  assert.deepEqual(result, {
    tree: { 'apple.sh': { text: 'green\n', mode: REGULAR | 0o755 }, 'pear.txt': 'yellow\n' },
    report: ['apple.sh: clean', 'pear.txt: clean'],
    calls: [],
  });
});

// Ported from tests/test_updatediff.py, test_update_with_exec_bit_change_and_merge_conflict.
test('merge gives a file the template makes executable the bit, also where its content conflicts', async () => {
  const result = await run({
    old: { 'launcher.sh': 'upstream version 1' },
    new: { 'launcher.sh': { text: 'upstream version 2', mode: REGULAR | 0o755 } },
    current: { 'launcher.sh': 'upstream version 1 + downstream' },
    conflicted: true,
  });
  assert.deepEqual(result, {
    tree: { 'launcher.sh': { text: 'merged\n', mode: REGULAR | 0o755 } },
    report: ['launcher.sh: conflicted'],
    calls: [
      {
        path: 'launcher.sh',
        old: 'upstream version 1',
        new: 'upstream version 2',
        current: 'upstream version 1 + downstream',
      },
    ],
  });
});

test('merge merges the executable bit apart from the content: a change of the bit on one side combines with a change of the content on the other', async () => {
  const result = await run({
    old: { 'apple.sh': 'red\n', 'pear.sh': 'green\n', 'plum.sh': 'blue\n' },
    new: { 'apple.sh': 'green\n', 'pear.sh': { text: 'green\n', mode: REGULAR | 0o755 }, 'plum.sh': 'purple\n' },
    current: {
      'apple.sh': { text: 'red\n', mode: REGULAR | 0o755 },
      'pear.sh': 'yellow\n',
      'plum.sh': { text: 'dark blue\n', mode: REGULAR | 0o755 },
    },
  });
  assert.deepEqual(result, {
    tree: {
      'apple.sh': { text: 'green\n', mode: REGULAR | 0o755 },
      'pear.sh': { text: 'yellow\n', mode: REGULAR | 0o755 },
      'plum.sh': { text: 'merged\n', mode: REGULAR | 0o755 },
    },
    report: ['apple.sh: clean', 'pear.sh: clean', 'plum.sh: clean'],
    calls: [{ path: 'plum.sh', old: 'blue\n', new: 'purple\n', current: 'dark blue\n' }],
  });
});

test('merge never writes or deletes a path that is a symlink in the current tree, nor through one, and reports it as kept', async () => {
  const link = (target: string) => ({ text: target, mode: SYMLINK | 0o777 });
  const result = await run({
    old: { 'apple.txt': 'red\n', 'pear.txt': 'green\n' },
    new: { 'apple.txt': 'green\n', 'basket/plum.txt': 'blue\n', 'crate/cherry.txt': 'red\n' },
    current: {
      'apple.txt': link('elsewhere/apple.txt'),
      'pear.txt': link('elsewhere/pear.txt'),
      basket: link('elsewhere'),
      crate: link('elsewhere'),
    },
    bornOnce: ['crate/cherry.txt'],
  });
  assert.deepEqual(result, {
    tree: {
      'apple.txt': link('elsewhere/apple.txt'),
      'pear.txt': link('elsewhere/pear.txt'),
      basket: link('elsewhere'),
      crate: link('elsewhere'),
    },
    report: ['apple.txt: kept', 'basket/plum.txt: kept', 'crate/cherry.txt: kept', 'pear.txt: kept'],
    calls: [],
  });
});

// Ported from tests/test_symlinks.py, test_update_renamed_dir_does_not_delete_symlink_target:
// a template cannot hold a symlink here, so the user made the directory one;
// the template then renames the directory.
test('merge does not delete the target of a symlink the user put in place of a directory the template renames', async () => {
  const result = await run({
    old: { 'foo/templates/file.txt': 'test' },
    new: { 'bar/templates/file.txt': 'test' },
    current: {
      'foo/templates': { text: '../shared/templates', mode: SYMLINK | 0o777 },
      'shared/templates/file.txt': 'test',
    },
  });
  assert.deepEqual(result, {
    tree: {
      'foo/templates': { text: '../shared/templates', mode: SYMLINK | 0o777 },
      'shared/templates/file.txt': 'test',
      'bar/templates/file.txt': 'test',
    },
    report: ['bar/templates/file.txt: added', 'foo/templates/file.txt: kept'],
    calls: [],
  });
});

/** An empty directory's entry. */
const directory = (mode = 0o755) => ({ text: '', mode: DIRECTORY | mode });

test('merge adds an empty directory of the new render that the current tree lacks, at its path and below, and reports it as added', async () => {
  const result = await run({
    new: { empty: directory(), seeds: directory(), crate: directory() },
    current: { 'seeds/apple.txt': 'red\n', crate: directory(0o700) },
  });
  assert.deepEqual(result, {
    tree: { empty: directory(), 'seeds/apple.txt': 'red\n', crate: directory(0o700) },
    report: ['empty: added'],
    calls: [],
  });
});

test('merge never deletes a directory, and reports none it does not add', async () => {
  const result = await run({
    old: { empty: directory(), gone: directory(), seeds: directory(), 'basket/apple.txt': 'red\n' },
    new: {},
    current: { empty: directory(), 'seeds/apple.txt': 'red\n' },
  });
  assert.deepEqual(result, {
    tree: { empty: directory(), 'seeds/apple.txt': 'red\n' },
    report: ['basket/apple.txt: kept'],
    calls: [],
  });
});

test('merge keeps a path that is a file on one side and a directory on another as the current tree has it, and reports it as conflicted', async () => {
  const result = await run({
    old: { apple: 'red\n' },
    new: { apple: directory(), pear: 'green\n', plum: directory(), 'cherry/stone.txt': 'hard\n' },
    current: { apple: 'red\n', 'pear/seed.txt': 'small\n', plum: 'blue\n', cherry: 'dark red\n' },
  });
  assert.deepEqual(result, {
    tree: { apple: 'red\n', 'pear/seed.txt': 'small\n', plum: 'blue\n', cherry: 'dark red\n' },
    report: ['apple: conflicted', 'cherry/stone.txt: conflicted', 'pear: conflicted', 'plum: conflicted'],
    calls: [],
  });
});

test('merge never touches a born-once path that the current tree holds as a directory, whatever the renders hold, and reports it as kept', async () => {
  const result = await run({
    old: { apple: 'red\n', pear: 'green\n' },
    new: { pear: 'yellow\n', plum: 'blue\n' },
    current: { apple: directory(), 'pear/seed.txt': 'small\n', plum: directory() },
    bornOnce: ['apple', 'pear', 'plum'],
  });
  assert.deepEqual(result, {
    tree: { apple: directory(), 'pear/seed.txt': 'small\n', plum: directory() },
    report: ['apple: kept', 'pear: kept', 'plum: kept'],
    calls: [],
  });
});

test('merge leaves absent a path the user deleted where the template turns a file into a directory or back, and reports it as kept', async () => {
  const result = await run({
    old: { fig: 'purple\n', date: directory() },
    new: { fig: directory(), date: 'brown\n' },
  });
  assert.deepEqual(result, { tree: {}, report: ['date: kept', 'fig: kept'], calls: [] });
});

test('merge leaves absent a born-once path the old render holds in any form or policy, also where a directory it lies in is a file or a symlink, and reports it as kept where the template changed it', async () => {
  const link = { text: 'elsewhere', mode: SYMLINK | 0o777 };
  const result = await run({
    old: {
      'apple.txt': 'red\n',
      'pear.txt': 'green\n',
      plum: directory(),
      'crate/cherry.txt': 'red\n',
      'tray/fig.txt': 'purple\n',
      'box/date.txt': 'brown\n',
    },
    new: {
      'apple.txt': 'green\n',
      'pear.txt': 'green\n',
      plum: 'blue\n',
      'crate/cherry.txt': 'dark red\n',
      'tray/fig.txt': 'violet\n',
      'box/date.txt': 'brown\n',
    },
    current: { crate: 'wooden\n', tray: link, box: 'cardboard\n' },
    // Merge in the old render, born-once in the new one; plum an empty directory before.
    bornOnce: {
      old: ['crate/cherry.txt', 'tray/fig.txt', 'box/date.txt'],
      new: ['apple.txt', 'pear.txt', 'plum', 'crate/cherry.txt', 'tray/fig.txt', 'box/date.txt'],
    },
  });
  assert.deepEqual(result, {
    tree: { crate: 'wooden\n', tray: link, box: 'cardboard\n' },
    report: ['apple.txt: kept', 'crate/cherry.txt: kept', 'plum: kept', 'tray/fig.txt: kept'],
    calls: [],
  });
});

test('merge leaves absent a path born-once in the old render that the new render merges, and the user deleted', async () => {
  const result = await run({
    old: { 'apple.txt': 'red\n', 'pear.txt': 'green\n' },
    new: { 'apple.txt': 'green\n', 'pear.txt': 'green\n' },
    bornOnce: { old: ['apple.txt', 'pear.txt'], new: [] },
  });
  assert.deepEqual(result, { tree: {}, report: ['apple.txt: kept'], calls: [] });
});

test('merge never reports a conflict for an empty directory the template drops or turns into the file the user already has', async () => {
  const result = await run({
    old: { apple: directory(), pear: directory() },
    new: { pear: 'green\n' },
    current: { apple: 'red\n', pear: 'green\n' },
  });
  assert.deepEqual(result, { tree: { apple: 'red\n', pear: 'green\n' }, report: ['pear: clean'], calls: [] });
});

test('merge refuses a render that holds a symlink, which render never writes', async () => {
  const link = { text: 'elsewhere', mode: SYMLINK | 0o777 };
  await assert.rejects(run({ old: { apple: link }, current: { apple: link } }), /apple.*symlink/);
  await assert.rejects(run({ new: { apple: link } }), /apple.*symlink/);
});

// The cases below pin what the rules above already give, where a change to the
// code could break one without breaking a test above.

test('merge takes a path that shares a prefix with one of the current tree as a path of its own', async () => {
  const result = await run({ new: { app: 'green\n' }, current: { 'apple.txt': 'red\n' } });
  assert.deepEqual(result, { tree: { app: 'green\n', 'apple.txt': 'red\n' }, report: ['app: added'], calls: [] });
});

test('merge looks at every directory an added path lies in, not only its parent', async () => {
  const link = { text: 'elsewhere', mode: SYMLINK | 0o777 };
  const result = await run({
    new: { 'basket/shelf/apple.txt': 'red\n', 'crate/shelf/pear.txt': 'green\n' },
    current: { basket: link, crate: 'wooden\n' },
  });
  assert.deepEqual(result, {
    tree: { basket: link, crate: 'wooden\n' },
    report: ['basket/shelf/apple.txt: kept', 'crate/shelf/pear.txt: conflicted'],
    calls: [],
  });
});

test('merge takes the policy of a path the new render holds from the new render, born-once in the old one or not', async () => {
  const result = await run({
    old: { 'apple.txt': 'red\n', 'pear.txt': 'green\n' },
    new: { 'apple.txt': 'green\n', 'pear.txt': 'yellow\n' },
    current: { 'apple.txt': 'red\n', 'pear.txt': 'light green\n' },
    bornOnce: { old: ['apple.txt', 'pear.txt'], new: [] },
  });
  assert.deepEqual(result, {
    tree: { 'apple.txt': 'green\n', 'pear.txt': 'merged\n' },
    report: ['apple.txt: clean', 'pear.txt: clean'],
    calls: [{ path: 'pear.txt', old: 'green\n', new: 'yellow\n', current: 'light green\n' }],
  });
});

test('merge tells an empty file from an empty directory', async () => {
  const result = await run({ old: { apple: '' }, new: { apple: directory() }, current: { apple: '' } });
  assert.deepEqual(result, { tree: { apple: '' }, report: ['apple: conflicted'], calls: [] });
});

test('merge keeps a file the template drops whose mode alone the user changed, as conflicted', async () => {
  const result = await run({
    old: { 'apple.sh': 'red\n' },
    current: { 'apple.sh': { text: 'red\n', mode: REGULAR | 0o755 } },
  });
  assert.deepEqual(result, {
    tree: { 'apple.sh': { text: 'red\n', mode: REGULAR | 0o755 } },
    report: ['apple.sh: conflicted'],
    calls: [],
  });
});

test('merge keeps the executable bit of a file both sides add where only the user made it executable', async () => {
  const result = await run({
    new: { 'apple.sh': 'green\n' },
    current: { 'apple.sh': { text: 'red\n', mode: REGULAR | 0o755 } },
  });
  assert.deepEqual(result, {
    tree: { 'apple.sh': { text: 'merged\n', mode: REGULAR | 0o755 } },
    report: ['apple.sh: clean'],
    calls: [{ path: 'apple.sh', old: '', new: 'green\n', current: 'red\n' }],
  });
});

test("merge reads a current mode by its owner's executable bit alone: 0o611 is not executable, 0o700 is", async () => {
  const result = await run({
    old: { 'apple.txt': 'red\n', 'pear.sh': { text: 'green\n', mode: REGULAR | 0o755 } },
    new: { 'apple.txt': 'green\n', 'pear.sh': { text: 'yellow\n', mode: REGULAR | 0o755 } },
    current: {
      'apple.txt': { text: 'red\n', mode: REGULAR | 0o611 },
      'pear.sh': { text: 'green\n', mode: REGULAR | 0o700 },
    },
  });
  assert.deepEqual(result, {
    tree: { 'apple.txt': 'green\n', 'pear.sh': { text: 'yellow\n', mode: REGULAR | 0o755 } },
    report: ['apple.txt: clean', 'pear.sh: clean'],
    calls: [],
  });
});

test('merge keeps the current file where all three sides differ and only the current or only the old side is binary', async () => {
  const binary = (...bytes: number[]) => ({ bytes, mode: REGULAR | 0o644 });
  const result = await run({
    old: { 'apple.txt': 'red\n', 'pear.txt': binary(0xff, 0, 1) },
    new: { 'apple.txt': 'green\n', 'pear.txt': 'yellow\n' },
    current: { 'apple.txt': binary(0xff, 0, 3), 'pear.txt': 'light green\n' },
  });
  assert.deepEqual(result, {
    tree: { 'apple.txt': binary(0xff, 0, 3), 'pear.txt': 'light green\n' },
    report: ['apple.txt: conflicted', 'pear.txt: conflicted'],
    calls: [],
  });
});

test('merge takes a NUL byte at index 7999 as binary and one at index 8000 as not', async () => {
  const at = (index: number, text: string) => `${text}${'a'.repeat(index - text.length)}\0`;
  const result = await run({
    old: { 'apple.txt': at(7999, 'red\n'), 'pear.txt': at(8000, 'green\n') },
    new: { 'apple.txt': at(7999, 'pink\n'), 'pear.txt': at(8000, 'lime\n') },
    current: { 'apple.txt': at(7999, 'rose\n'), 'pear.txt': at(8000, 'teal\n') },
  });
  assert.deepEqual(result.report, ['apple.txt: conflicted', 'pear.txt: clean']);
  assert.deepEqual(
    result.calls.map(({ path }) => path),
    ['pear.txt'],
  );
});

test('merge leaves the current tree it was given as it was', async () => {
  const current = tree({ 'apple.txt': 'red\n', 'pear.txt': 'green\n' });
  const before = listing(current);
  await merge(
    {
      old: tree({ 'apple.txt': 'red\n', 'pear.txt': 'green\n' }),
      new: tree({ 'apple.txt': 'green\n', 'plum.txt': 'blue\n' }),
      current,
      files: { old: new Map(), new: new Map() },
    },
    async () => assert.fail('no file is merged'),
  );
  assert.deepEqual(listing(current), before);
});
