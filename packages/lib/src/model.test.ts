import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Directory, holdsApp, unitsOf } from './model.ts';

const dir = (path: string, facets: Partial<Directory> = {}, children: Directory[] = []): Directory => ({
  name: path.split('/').pop() ?? path,
  path,
  children,
  ...facets,
});
const marker = { declaration: { deviations: [], body: '' } };
const git = { gitRoot: true as const };

test('a repo is a git root, an app one of the apps the walk found for its nearest git root', () => {
  const tree = dir('/ws', {}, [
    // A repo without a marker, whose app has one: the repo is still the repo.
    dir('/ws/web', { ...git, apps: ['/ws/web/apps/site'] }, [
      dir('/ws/web/apps', {}, [dir('/ws/web/apps/site', marker)]),
    ]),
    // A checkout nested in a repo is a repo of its own, with its own apps.
    dir('/ws/ops', { ...git, ...marker }, [
      dir('/ws/ops/.claude', {}, [
        dir('/ws/ops/.claude/worktrees', {}, [
          dir('/ws/ops/.claude/worktrees/x', { ...git, ...marker, apps: ['/ws/ops/.claude/worktrees/x/apps/id'] }, [
            dir('/ws/ops/.claude/worktrees/x/apps', {}, [dir('/ws/ops/.claude/worktrees/x/apps/id', marker)]),
          ]),
        ]),
      ]),
    ]),
    // A marker outside any git root is no unit; a git root with neither marker nor app is no Plexus repo.
    dir('/ws/loose', marker),
    dir('/ws/notes', git),
  ]);
  assert.deepEqual(
    unitsOf(tree).map((u) => [u.dir.path, u.kind, u.repo?.path]),
    [
      ['/ws/web', 'repo', undefined],
      ['/ws/web/apps/site', 'app', '/ws/web'],
      ['/ws/ops', 'repo', undefined],
      ['/ws/ops/.claude/worktrees/x', 'repo', undefined],
      ['/ws/ops/.claude/worktrees/x/apps/id', 'app', '/ws/ops/.claude/worktrees/x'],
    ],
  );
});

test('what a unit is follows from where it sits, never from what a marker says', () => {
  const ops = { copier: { src: 'gh:plexus-ms/template-repo-operations', answers: {} } };
  const tree = dir('/ws', {}, [
    dir('/ws/ops', { ...git, ...marker, ...ops, apps: ['/ws/ops/apps/id'] }, [
      dir('/ws/ops/apps', {}, [dir('/ws/ops/apps/id', marker)]),
    ]),
    dir('/ws/web', { ...git, ...marker, apps: ['/ws/web/apps/site'] }, [
      dir('/ws/web/apps', {}, [
        dir('/ws/web/apps/site', marker, [
          dir('/ws/web/apps/site/apps', {}, [dir('/ws/web/apps/site/apps/x', marker)]),
        ]),
      ]),
    ]),
  ]);
  assert.deepEqual(
    unitsOf(tree).map((u) => [u.dir.path, u.kind, u.repo?.path]),
    [
      ['/ws/ops', 'operations', undefined],
      ['/ws/ops/apps/id', 'app', '/ws/ops'],
      ['/ws/web', 'repo', undefined],
      ['/ws/web/apps/site', 'app', '/ws/web'],
    ],
  );
});

test('an app holds something besides dotfiles, and no checkout of its own', () => {
  const entries = (...names: string[]) => names.map((name) => ({ name }));
  assert.equal(holdsApp(entries('docker', 'package.json')), true);
  assert.equal(holdsApp(entries()), false, 'empty');
  assert.equal(holdsApp(entries('.gitkeep')), false, 'only a dotfile');
  assert.equal(holdsApp(entries('.git', 'PLEXUS.md')), false, 'a checkout of its own');
});
