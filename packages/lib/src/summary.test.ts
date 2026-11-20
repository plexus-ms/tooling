import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isClean, mergeLine, renderSummary, summarize } from './summary.ts';
import type { Outcome } from './update.ts';

test('renderSummary lists every site and ends with the verdict', () => {
  const base = {
    version: '0.2.0',
    preview: false,
    clean: ['acme/web'],
    conflicted: [],
    failed: [],
    skipped: [],
    resting: [] as { path: string; reason: string }[],
    pulls: ['https://github.com/acme/web/pull/7'],
    mergeable: [] as string[],
  };
  assert.equal(
    renderSummary(base, 'plx-dev -y ship --to 0.2.0 .').split('\n').slice(1).join('\n'),
    '  ✓ clean:      acme/web\n  → pull:       https://github.com/acme/web/pull/7\n✓ done — review and merge the pull requests',
  );
  assert.equal(
    renderSummary({ ...base, preview: true }, 'plx-dev -y ship --to 0.2.0 .')
      .split('\n')
      .slice(1)
      .join('\n'),
    '  ✓ clean:      acme/web\n  → pull:       https://github.com/acme/web/pull/7\n  (preview only — nothing was changed)\n✓ dry run clean — run it for real: plx-dev -y ship --to 0.2.0 .',
  );
  const bad = renderSummary(
    {
      ...base,
      conflicted: ['acme/web/apps/site'],
      skipped: [{ path: 'acme/platform', reason: 'has uncommitted changes' }],
    },
    '',
  );
  assert.match(bad, /^ {2}✗ conflicts: {2}acme\/web\/apps\/site$/m);
  assert.match(bad, /^ {2}⚠ skipped: {4}acme\/platform \(has uncommitted changes\)$/m);
  assert.match(bad, /^✗ needs attention/m);
  assert.doesNotMatch(bad, /✓ done/);
  const resting = renderSummary(
    {
      ...base,
      clean: [],
      pulls: [],
      resting: [{ path: 'web', reason: '1 newer version, the oldest (0.2.0) cut 3 days ago' }],
    },
    '',
  );
  assert.match(resting, /^ {2}• resting: {4}web \(1 newer version, the oldest \(0\.2\.0\) cut 3 days ago\)$/m);
  assert.match(resting, /^✓ done — no pull request$/m, 'a resting repo needs nobody');
  assert.doesNotMatch(
    renderSummary({ ...base, preview: true, clean: [], pulls: [], resting: [{ path: 'web', reason: 'r' }] }, 'real'),
    /run it for real/,
    'a resting dry run names no command that would take the version',
  );
});

test('the summary ends the pull requests with one line that merges the clean ones', () => {
  const s = {
    version: '0.2.0',
    preview: false,
    clean: ['acme/web', 'acme/platform'],
    conflicted: ['acme/docs'],
    failed: [],
    skipped: [],
    resting: [],
    pulls: [
      'https://github.com/acme/web/pull/7',
      'https://github.com/acme/platform/pull/12',
      'https://github.com/acme/docs/pull/3',
    ],
    mergeable: ['https://github.com/acme/web/pull/7', 'https://github.com/acme/platform/pull/12'],
  };
  const out = renderSummary(s, '');
  assert.match(out, /^ {2}the clean ones, to merge once their checks pass:$/m);
  assert.match(out, /^ {2}gh pr merge -md -R acme\/web 7 && gh pr merge -md -R acme\/platform 12$/m);
  assert.doesNotMatch(out, /acme\/docs 3/, 'a conflicted one is not offered');
  assert.doesNotMatch(renderSummary({ ...s, preview: true }, ''), /gh pr merge/, 'a preview opened nothing');
  assert.doesNotMatch(renderSummary({ ...s, mergeable: [] }, ''), /clean ones/);
  assert.doesNotMatch(
    renderSummary({ ...s, preview: true, clean: [], conflicted: [] }, 'real'),
    /run it for real/,
    'a dry run that only found pull requests has nothing to run',
  );
  assert.equal(
    mergeLine(['acme/web plexus/0.2.0', 'https://forge/x/pull/1']),
    '',
    'what is no pull request URL is left out',
  );
});

test('summarize folds what each repo came to, in order, without touching the outcomes', () => {
  const outcomes: Outcome[] = [
    { repo: 'acme/docs', version: '', kind: 'skipped', reason: 'no origin remote' },
    { repo: 'acme/old', version: '0.2.0', kind: 'current' },
    { repo: 'acme/ops', version: '0.2.0', kind: 'resting', reason: 'inside the interval' },
    {
      repo: 'acme/found',
      version: '0.2.0',
      kind: 'found',
      pull: 'https://forge/acme/found/pull/2',
      marked: [],
      mergeable: true,
    },
    {
      repo: 'acme/marked',
      version: '0.2.0',
      kind: 'found',
      pull: 'https://forge/acme/marked/pull/3',
      marked: ['apps/a/x.ts'],
      mergeable: false,
    },
    { repo: 'acme/gone', version: '0.2.0', kind: 'found', marked: [], mergeable: false },
    { repo: 'acme/broken', version: '0.2.0', kind: 'failed', detail: 'worktree' },
    {
      repo: 'acme/web',
      version: '0.2.0',
      kind: 'taken',
      taken: {
        rel: 'acme/web',
        sites: [
          { rel: 'acme/web', outcome: 'clean' },
          { rel: 'acme/web/apps/site', outcome: 'conflicted' },
        ],
        lockfile: 'failed',
        marked: ['apps/site/x.txt'],
        pull: { branch: 'plexus/0.2.0', url: 'https://forge/acme/web/pull/7', draft: true },
      },
    },
    {
      repo: 'acme/platform',
      version: '0.2.0',
      kind: 'taken',
      taken: {
        rel: 'acme/platform',
        sites: [{ rel: 'acme/platform', outcome: 'clean' }],
        pull: { branch: 'plexus/0.2.0', draft: false },
      },
    },
    {
      repo: 'acme/clean',
      version: '0.2.0',
      kind: 'taken',
      taken: {
        rel: 'acme/clean',
        sites: [{ rel: 'acme/clean', outcome: 'clean' }],
        lockfile: 'refreshed',
        pull: { branch: 'plexus/0.2.0', url: 'https://forge/acme/clean/pull/1', draft: false },
      },
    },
    {
      repo: 'acme/push',
      version: '0.2.0',
      kind: 'taken',
      taken: { rel: 'acme/push', sites: [{ rel: 'acme/push', outcome: 'failed', detail: 'boom' }], failed: 'push' },
    },
  ];
  const before = JSON.stringify(outcomes);
  assert.deepEqual(summarize(outcomes, false), {
    version: '0.2.0',
    preview: false,
    clean: ['acme/web', 'acme/platform', 'acme/clean'],
    conflicted: ['acme/marked/apps/a/x.ts', 'acme/web/apps/site'],
    failed: ['acme/broken', 'acme/web/pnpm-lock.yaml', 'acme/push', 'acme/push'],
    skipped: [{ path: 'acme/docs', reason: 'no origin remote' }],
    resting: [{ path: 'acme/ops', reason: 'inside the interval' }],
    pulls: [
      'https://forge/acme/found/pull/2',
      'https://forge/acme/marked/pull/3',
      'https://forge/acme/web/pull/7',
      'acme/platform plexus/0.2.0',
      'https://forge/acme/clean/pull/1',
    ],
    mergeable: ['https://forge/acme/found/pull/2', 'https://forge/acme/clean/pull/1'],
  });
  assert.equal(JSON.stringify(outcomes), before, 'the outcomes are as they were');
  assert.equal(summarize([], true, '0.3.0').version, '0.3.0', "a version given is the summary's");
});

test('a file holding a marker outside any conflicted site makes the opening run need a human', () => {
  const taken = (sites: { rel: string; outcome: 'clean' | 'conflicted' }[], marked: string[]): Outcome => ({
    repo: 'acme/web',
    version: '0.2.0',
    kind: 'taken',
    taken: {
      rel: 'acme/web',
      sites,
      marked,
      pull: { branch: 'plexus/0.2.0', url: 'https://forge/acme/web/pull/1', draft: true },
    },
  });
  const clean = summarize([taken([{ rel: 'acme/web', outcome: 'clean' }], ['docs/old.md'])], false);
  assert.deepEqual(clean.conflicted, ['acme/web/docs/old.md'], 'no site reported it, the summary does');
  assert.deepEqual(clean.mergeable, []);
  assert.equal(isClean(clean), false, 'so the run exits nonzero');
  assert.match(renderSummary(clean, ''), /^✗ needs attention/m);
  const covered = summarize(
    [
      taken(
        [
          { rel: 'acme/web', outcome: 'clean' },
          { rel: 'acme/web/apps/site', outcome: 'conflicted' },
        ],
        ['apps/site/a.txt', 'apps/sitex/b.txt'],
      ),
    ],
    false,
  );
  assert.deepEqual(
    covered.conflicted,
    ['acme/web/apps/site', 'acme/web/apps/sitex/b.txt'],
    'a file in a conflicted site is that site',
  );
});
