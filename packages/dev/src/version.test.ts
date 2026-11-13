import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context, UsageError, VERSIONED_REPOS } from '@plexus-ms/lib';
import { fakeIo } from './testing/fakeIo.ts';
import { latestTag, nextMinor, PHASES, phasesOf, preflightRelease, readVersioned, resolveVersion } from './version.ts';

test('latestTag compares across both tag eras', () => {
  assert.equal(latestTag(['v0.21', '0.22.0', 'v0.9', '0.10.0']), '0.22.0');
  assert.equal(latestTag(['v0.21', 'v0.9']), 'v0.21');
  assert.equal(latestTag(['0.76.0', '0.100.0-rc.3']), '0.76.0', 'a prerelease is not a version');
  assert.equal(latestTag([]), undefined);
  assert.equal(nextMinor('0.22.0'), '0.23.0');
});

/** A fake upstream where every repo answers the same tags, except as overridden. */
function upstream(
  tags: Record<string, string[]>,
  extra: (cwd: string, args: string[]) => string | undefined = () => undefined,
  other: Record<string, (cwd: string, args: string[]) => string | undefined> = {},
) {
  const git = (cwd: string, args: string[]): string | undefined => {
    const name = cwd.split('/').pop() ?? '';
    const sub = args[0];
    if (sub === 'rev-parse' && args[1] === '--git-dir') return '.git\n';
    if (sub === 'fetch') return '';
    if (sub === 'tag') return `${(tags[name] ?? tags['*'] ?? []).join('\n')}\n`;
    if (sub === 'log') return name === 'compendium' ? 'abc fix: thing\n' : '';
    return extra(cwd, args);
  };
  return new Context({}, fakeIo({}, git, other));
}

test('readVersioned reads tags and pending commits and detects skew', async () => {
  const version = await readVersioned(upstream({ '*': ['0.1.0', 'v0.0.9'] }), '/ws/plexus-ms');
  assert.deepEqual(
    version.repos.map((r) => r.name),
    [...VERSIONED_REPOS],
  );
  assert.equal(version.last, '0.1.0');
  assert.equal(version.skew, false);
  assert.deepEqual(version.repos.find((r) => r.name === 'compendium')?.pending, ['abc fix: thing']);
  assert.deepEqual(
    phasesOf(version).map((phase) => phase.map((r) => r.name)),
    [['tooling'], ['template-repo-turbo', 'template-app-nextjs', 'template-repo-operations', 'compendium']],
    'tooling alone first, then the rest',
  );
  assert.deepEqual(PHASES.flat(), [...VERSIONED_REPOS]);
  assert.equal(resolveVersion(version, undefined), '0.2.0');
  assert.equal(resolveVersion(version, '1.0.0'), '1.0.0');

  const skewed = await readVersioned(upstream({ '*': ['0.1.0'], tooling: ['0.1.0', '0.2.0'] }), '/ws/plexus-ms');
  assert.equal(skewed.skew, true);
  assert.equal(skewed.last, '0.2.0');
  assert.throws(
    () => resolveVersion(skewed, undefined),
    /latest tags disagree:\n {2}tooling: 0.2.0\n {2}template-repo-turbo: 0.1.0[\s\S]*--to 0.2.0/,
  );
  assert.equal(resolveVersion(skewed, '0.2.0'), '0.2.0');
  assert.throws(() => resolveVersion(skewed, '1.2'), UsageError);
});

test('preflightRelease names the first offending repo', async () => {
  const state = { branch: 'main', status: '', behind: '0' };
  const ctx = upstream({ '*': ['0.1.0'] }, (cwd, args) => {
    if (!cwd.endsWith('/compendium')) return args[0] === 'rev-list' ? '0\n' : args[0] === 'status' ? '' : 'main\n';
    if (args[0] === 'rev-parse') return `${state.branch}\n`;
    if (args[0] === 'status') return state.status;
    if (args[0] === 'rev-list') return `${state.behind}\n`;
    return undefined;
  });
  const version = await readVersioned(ctx, '/ws/plexus-ms');
  await preflightRelease(ctx, version);
  state.behind = '2';
  await assert.rejects(preflightRelease(ctx, version), /compendium is 2 commit\(s\) behind origin\/main/);
  state.status = ' M x\n';
  await assert.rejects(preflightRelease(ctx, version), /compendium has uncommitted changes/);
  state.branch = 'feature';
  await assert.rejects(preflightRelease(ctx, version), /compendium is on 'feature'/);
});
