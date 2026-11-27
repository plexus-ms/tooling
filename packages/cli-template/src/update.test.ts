// An update by hand, as the header of cli.ts describes it: three runs of the
// command, on two versions of a template of baskets. Render the old version,
// render the new one, merge into a directory that started as the old render and
// has local edits.
import assert from 'node:assert/strict';
import { chmodSync, cpSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { plx, put, read, scratch } from './testing/run.ts';

const MANIFEST = [
  'name: basket',
  'questions:',
  '  fruit:',
  '    type: str',
  '  count:',
  '    type: int',
  '    default: 3',
  'policies:',
  '  notes.md: born-once',
  '',
].join('\n');

const V1 = {
  'template.yml': MANIFEST,
  'files/README.md.jinja': 'A basket of {{ count }} {{ fruit }}s.\n',
  'files/list.txt': 'apple\npear\nplum\n',
  'files/motto.txt': 'fresh\n',
  'files/old-label.txt': 'v1\n',
  'files/notes.md': 'notes, first draft\n',
  'files/bin/run.sh': '#!/bin/sh\necho 1\n',
  'files/bin/count.sh': { text: '#!/bin/sh\necho 3\n', mode: 0o755 },
};
const V2 = {
  'template.yml': MANIFEST,
  'files/README.md.jinja': 'A basket of {{ count }} {{ fruit }}s.\n',
  'files/list.txt': 'apple\npear\nplum\nfig\n',
  'files/motto.txt': 'ripe\n',
  'files/new-label.txt': 'v2\n',
  'files/notes.md': 'notes, second draft\n',
  'files/bin/run.sh': { text: '#!/bin/sh\necho 1\n', mode: 0o755 },
  'files/bin/count.sh': { text: '#!/bin/sh\necho 3\n', mode: 0o755 },
};

test('an update by hand: render the old template, render the new one, merge into a directory with local edits', () => {
  const s = scratch();
  try {
    put(s.path('v1'), V1);
    put(s.path('v2'), V2);
    put(s.dir, { 'answers.json': '{"fruit": "pear"}' });

    const first = plx(['render', '--answers', s.path('answers.json'), s.path('old'), s.path('v1')]);
    assert.equal(first.code, 0, first.stderr);
    const second = plx(['render', '--answers', s.path('answers.json'), s.path('new'), s.path('v2')]);
    assert.equal(second.code, 0, second.stderr);

    // The project: the old render, as it was committed, and what the user did to it.
    cpSync(s.path('old'), s.path('project'), { recursive: true });
    const project = (path: string) => s.path(`project/${path}`);
    writeFileSync(project('list.txt'), 'APPLE\npear\nplum\n');
    writeFileSync(project('motto.txt'), 'juicy\n');
    writeFileSync(project('notes.md'), 'my notes\n');
    writeFileSync(project('mine.txt'), "not the template's\n");
    chmodSync(project('bin/count.sh'), 0o755);

    const merged = plx(['merge', s.path('old'), s.path('new'), s.path('project')]);
    assert.equal(merged.code, 0, merged.stderr);
    assert.deepEqual(JSON.parse(merged.stdout).report, [
      { path: 'bin/run.sh', outcome: 'clean' },
      { path: 'list.txt', outcome: 'clean' },
      { path: 'motto.txt', outcome: 'conflicted' },
      { path: 'new-label.txt', outcome: 'added' },
      { path: 'notes.md', outcome: 'kept' },
      { path: 'old-label.txt', outcome: 'deleted' },
    ]);
    assert.deepEqual(read(s.path('project')), {
      'README.md': 'A basket of 3 pears.\n',
      'bin/count.sh': { text: '#!/bin/sh\necho 3\n', mode: 0o755 },
      'bin/run.sh': { text: '#!/bin/sh\necho 1\n', mode: 0o755 },
      'list.txt': 'APPLE\npear\nplum\nfig\n',
      'mine.txt': "not the template's\n",
      'motto.txt': '<<<<<<< current\njuicy\n=======\nripe\n>>>>>>> new render\n',
      'new-label.txt': 'v2\n',
      'notes.md': 'my notes\n',
    });
    assert.equal(statSync(s.path('project/bin/run.sh')).mode & 0o777, 0o755);
    assert.equal(readFileSync(s.path('new/notes.md'), 'utf8'), 'notes, second draft\n');
  } finally {
    s.remove();
  }
});
