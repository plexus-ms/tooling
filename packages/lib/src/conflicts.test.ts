import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filesWithConflictMarkers, hasConflictMarkers, hasUnmergedEntries } from './conflicts.ts';
import { Context } from './context.ts';
import { fakeIo } from './testing/fakeIo.ts';

const OPEN = '<'.repeat(7);
const CLOSE = '>'.repeat(7);
const SPLIT = '='.repeat(7);

test('a line that opens or closes a conflict, followed by a space or the end of the line, is a marker', () => {
  assert.equal(hasConflictMarkers(`a\n${OPEN} HEAD\nx\n${SPLIT}\ny\n${CLOSE} theirs\n`), true);
  assert.equal(hasConflictMarkers(`a\n${OPEN}\nx\n`), true, 'an opening line with nothing after it');
  assert.equal(hasConflictMarkers(`x\n${CLOSE} after`), true, 'a closing line alone');
  assert.equal(hasConflictMarkers(`x\n${CLOSE}`), true, 'at the end of the text');
  assert.equal(hasConflictMarkers(`x\r\n${OPEN}\r\ny\r\n`), true, 'a CRLF line ends before its carriage return');
});

test('nothing else is a marker: the separator alone, a longer run, a marker inside a line', () => {
  assert.equal(hasConflictMarkers(`Title\n${SPLIT}\n\nProse.\n`), false, 'a Markdown setext heading');
  assert.equal(hasConflictMarkers(`${OPEN}< eight\n${CLOSE}> eight\n`), false);
  assert.equal(hasConflictMarkers(`${OPEN}x\n`), false, 'no space after it');
  assert.equal(hasConflictMarkers(`printf '${OPEN} before'\n  ${OPEN} indented\n`), false);
  assert.equal(hasConflictMarkers(''), false);
});

test('hasUnmergedEntries', () => {
  assert.equal(hasUnmergedEntries(' M a.txt\nUU b.txt\n'), true);
  assert.equal(hasUnmergedEntries(' M a.txt\n?? c\n'), false);
});

test('the tracked files that hold a marker: git grep names candidates, the detector decides', async () => {
  const calls: string[][] = [];
  const tree = {
    r: { 'a.txt': `${OPEN} ours\nx\n`, 'b.md': `${OPEN}< not one\n`, 'c.txt': `y\n${CLOSE}\n` },
  };
  const git = (cwd: string, args: string[]) => {
    calls.push(args);
    assert.equal(cwd, '/r');
    return args[0] === 'grep' ? 'c.txt\0a.txt\0b.md\0' : undefined;
  };
  const ctx = new Context({}, fakeIo(tree, git));
  assert.deepEqual(await filesWithConflictMarkers(ctx, '/r'), ['a.txt', 'c.txt']);
  assert.deepEqual(calls, [['grep', '-l', '-z', '-E', '-e', '^(<<<<<<<|>>>>>>>)', '--']]);
});

test('the files of a ref are read from git, no checkout needed; no match is none', async () => {
  const shown: Record<string, string> = { 'origin/x:apps/a.txt': `${CLOSE} theirs\n`, 'origin/x:b.txt': 'clean\n' };
  const git = (_cwd: string, args: string[]) => {
    if (args[0] === 'grep') return args.includes('origin/x') ? 'origin/x:apps/a.txt\0origin/x:b.txt\0' : undefined;
    if (args[0] === 'show') return shown[args[1] ?? ''];
    return undefined;
  };
  const ctx = new Context({}, fakeIo({}, git));
  assert.deepEqual(await filesWithConflictMarkers(ctx, '/r', 'origin/x'), ['apps/a.txt']);
  assert.deepEqual(await filesWithConflictMarkers(ctx, '/r'), [], 'git grep exits 1 when nothing matches');
});
