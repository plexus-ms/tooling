import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Report } from '@plexus-ms/lib';
import { style } from '../style.ts';
import { renderReport } from './doctor.ts';

test('renderReport prints a failing check as one line: name, unit, what is wrong', () => {
  const report: Report = {
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
  assert.equal(renderReport({ units: [], failed: 0 }, style(false), true), '✗ no PLEXUS.md marker found');
  assert.equal(
    renderReport({ units: [{ path: '.', kind: 'repo', deviations: [], findings: [] }], failed: 0 }, style(false), true),
    '✓ .\n✓ 1 unit passes every check',
  );
});
