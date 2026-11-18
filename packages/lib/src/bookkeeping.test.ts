import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bumpWorkflowRefs, hasUnmergedEntries } from './bookkeeping.ts';

test('bumpWorkflowRefs pins every tooling workflow, whatever the ref looked like', () => {
  const wf =
    'jobs:\n  a:\n    uses: plexus-ms/tooling/.github/workflows/_pipeline.yml@0.1.0\n  b:\n    uses: plexus-ms/tooling/.github/workflows/verify.yml@v0.9\n  c:\n    uses: other/repo/.github/workflows/x.yml@0.1.0\n';
  assert.equal(
    bumpWorkflowRefs(wf, '0.2.0'),
    wf.replace('_pipeline.yml@0.1.0', '_pipeline.yml@0.2.0').replace('verify.yml@v0.9', 'verify.yml@0.2.0'),
  );
});

test('hasUnmergedEntries', () => {
  assert.equal(hasUnmergedEntries(' M a.txt\nUU b.txt\n'), true);
  assert.equal(hasUnmergedEntries(' M a.txt\n?? c\n'), false);
});
