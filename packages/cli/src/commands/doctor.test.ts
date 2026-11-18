import assert from 'node:assert/strict';
import { test } from 'node:test';
import { style } from '../style.ts';
import { type DoctorReport, renderReport } from './doctor.ts';

const at = { root: '/ws', inRepo: false, skipped: [], links: [], unreadable: [] };

test('renderReport prints a failing check as one line: name, unit, what is wrong', () => {
  const report: DoctorReport = {
    ...at,
    units: [
      { path: 'web', kind: 'repo', deviations: [], findings: [] },
      {
        path: 'web/apps/shop',
        kind: 'app',
        profile: 'stateful',
        deviations: ['PLX-App/Stateful/Seed'],
        findings: [],
      },
      {
        path: 'ops',
        kind: 'operations',
        deviations: [],
        findings: [{ requirement: 'PLX-Repo/Verbs', problem: 'no root mise task `build`' }],
      },
    ],
    failed: 1,
  };
  assert.equal(
    renderReport(report, style(false), true),
    [
      '✓ web',
      '✓ web/apps/shop [app, stateful, deviates: PLX-App/Stateful/Seed]',
      '✗ PLX-Repo/Verbs ops: no root mise task `build`',
      '✗ 1 of 3 units fails a check',
    ].join('\n'),
  );
  assert.equal(renderReport(report, style(false), false).split('\n').length, 2, '-q keeps failures and the summary');
  assert.equal(renderReport({ ...at, units: [], failed: 0 }, style(false), true), '✗ no Plexus repo found');
});

test('renderReport says which repo it checked from inside one, and which git roots of a workspace it skipped', () => {
  const repo = { root: '/ws/web', inRepo: true, skipped: [], links: [], unreadable: [] };
  const passing = { units: [{ path: '.', kind: 'repo' as const, deviations: [], findings: [] }], failed: 0 };
  assert.equal(renderReport({ ...repo, ...passing }, style(false), true), '✓ .\n✓ 1 unit passes every check');
  assert.equal(
    renderReport({ ...repo, ...passing }, style(false), true, '/ws/web/apps/site'),
    '• the repo at /ws/web\n✓ .\n✓ 1 unit passes every check',
  );
  assert.equal(
    renderReport({ ...at, skipped: ['notes', 'x/compendium'], ...passing }, style(false), true),
    '✓ .\n• not Plexus repos (no PLEXUS.md, no app in apps/), not checked: notes, x/compendium\n✓ 1 unit passes every check',
  );
});

test('renderReport names the symbolic links it did not follow and the directories it could not read', () => {
  const passing = { units: [{ path: 'web', kind: 'repo' as const, deviations: [], findings: [] }], failed: 0 };
  assert.equal(
    renderReport(
      { ...at, links: ['web/apps/shop', 'mirror'], unreadable: [{ path: 'locked', why: 'EACCES' }], ...passing },
      style(false),
      true,
    ),
    [
      '✓ web',
      '• symbolic links, not followed, not checked: web/apps/shop, mirror',
      '! could not be read, not checked: locked (EACCES)',
      '✓ 1 unit passes every check',
    ].join('\n'),
  );
});

test('renderReport gives a hint as a line of its own, which -q leaves out', () => {
  const report: DoctorReport = {
    ...at,
    units: [
      {
        path: 'web',
        kind: 'repo',
        deviations: [],
        findings: [],
        hints: ["the marker's `plexus` and `modules` are no longer read and can go"],
      },
    ],
    failed: 0,
  };
  assert.equal(
    renderReport(report, style(false), true),
    "✓ web\n• web: the marker's `plexus` and `modules` are no longer read and can go\n✓ 1 unit passes every check",
  );
  assert.equal(renderReport(report, style(false), false), '✓ 1 unit passes every check');
});
