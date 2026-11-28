import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context, newSite, realIo, templatesRoot, UsageError } from '@plexus-ms/lib';
import { appsOfDeploys } from '../commands/displayVersions.ts';
import { fakeIo, notThere } from '../testing/fakeIo.ts';
import {
  displayVersions,
  majorOf,
  nextVersion,
  notesOf,
  parseVersion,
  tagDisplayVersion,
  versionsOf,
} from './displayVersions.ts';

const SHA = 'f'.repeat(40);
const commitOf = (tag: string) => `c-${tag}`;

/**
 * A repo whose version tags are `tags`, a marker with `major` (none when
 * undefined), and a registry holding `digests` by `<app>:<commit>`.
 */
function repo(options: {
  tags: string[];
  major?: unknown;
  digests: Record<string, string>;
  log?: string;
  curl?: string[][];
  existing?: Record<string, string>;
  /** The version tag the released commit carries, if any. */
  at?: string;
}) {
  const marker = options.major === undefined ? '---\n---\n' : `---\nmajor: ${options.major}\n---\n`;
  const crane: string[] = [];
  return {
    crane,
    io: fakeIo(
      { repo: { 'PLEXUS.md': marker } },
      (_cwd, args) => {
        if (args[0] === 'tag' && args[1] === '--merged') return [...options.tags, 'some-other-tag'].join('\n');
        if (args[0] === 'rev-parse' && args[1] === '-q') {
          const tag = /^refs\/tags\/(.+)\^\{commit\}$/.exec(args[3] ?? '')?.[1] ?? '';
          return options.existing?.[tag];
        }
        if (args[0] === 'rev-parse') {
          const rev = (args[1] ?? '').replace('^{commit}', '');
          return rev === SHA || rev === options.at ? `${SHA}\n` : `${commitOf(rev)}\n`;
        }
        if (args[0] === 'log') return options.log ?? '';
        return undefined;
      },
      {
        crane: (_cwd, args) => {
          const ref = args[1] ?? '';
          crane.push(ref);
          const key = ref.replace('ghcr.io/acme/', '');
          return options.digests[key] ?? notThere('crane');
        },
        curl: (_cwd, _args, input) => {
          options.curl?.push([input ?? '']);
          return '{}';
        },
      },
    ),
  };
}

const run = (r: ReturnType<typeof repo>, environment = 'production', apps = ['web', 'api'], dryRun = false) =>
  displayVersions(new Context({ dryRun }, r.io), { dir: 'repo', environment, sha: SHA, apps, prefix: 'ghcr.io/acme' });

test('versions are MAJOR.MINOR without a prefix, newest first; other tags are not versions', () => {
  assert.deepEqual(parseVersion('1.10'), { tag: '1.10', major: 1, minor: 10 });
  for (const t of ['v1.2', '1.2.3', '01.2', '1', 'a.b']) assert.equal(parseVersion(t), undefined);
  assert.deepEqual(
    versionsOf(['1.9', '1.10', '2.0', 'x', '0.3']).map((v) => v.tag),
    ['2.0', '1.10', '1.9', '0.3'],
  );
});

test('the next version counts the minor up, starts a raised major at .0, and never lowers a major', () => {
  assert.equal(nextVersion(undefined, 1), '1.0');
  assert.equal(nextVersion(parseVersion('1.9'), 1), '1.10');
  assert.equal(nextVersion(parseVersion('1.9'), 2), '2.0');
  assert.throws(() => nextVersion(parseVersion('2.3'), 1), UsageError);
});

test('production: a changed app cuts the next version, which every app is handed; only the last version is looked at', async () => {
  const r = repo({
    tags: ['1.0', '1.1', '1.2'],
    major: 1,
    digests: {
      [`web:${SHA}`]: 'W2',
      'web:c-1.2': 'W2',
      'web:c-1.1': 'W2',
      'web:c-1.0': 'W1',
      [`api:${SHA}`]: 'A3',
      'api:c-1.2': 'A2',
    },
  });
  assert.deepEqual(await run(r), {
    environment: 'production',
    previous: '1.2',
    version: '1.3',
    apps: { web: '1.3', api: '1.3' },
  });
  assert.ok(!r.crane.some((ref) => ref.endsWith(':c-1.1') || ref.endsWith(':c-1.0')));
});

test('production: nothing changed, no version; a commit without the tag deviates from the last one', async () => {
  const digests = { [`web:${SHA}`]: 'W', 'web:c-1.1': 'W', 'web:c-1.0': 'W', [`api:${SHA}`]: 'A', 'api:c-1.1': 'A' };
  // An app handed this is one that restarts all the same, for a changed run shape.
  assert.deepEqual(await run(repo({ tags: ['1.0', '1.1'], major: 1, digests })), {
    environment: 'production',
    previous: '1.1',
    version: '',
    apps: { web: '1.1+', api: '1.1+' },
  });
  // A re-run of the release that cut 1.1: the commit carries the tag.
  const rerun = repo({
    tags: ['1.0', '1.1'],
    major: 1,
    at: '1.1',
    digests: { [`web:${SHA}`]: 'W', [`api:${SHA}`]: 'A' },
  });
  assert.deepEqual(await run(rerun), {
    environment: 'production',
    previous: '1.1',
    version: '',
    apps: { web: '1.1', api: '1.1' },
  });
});

test('production: a raised major starts at .0; the first version is <major>.0; a new app is changed', async () => {
  const raised = repo({ tags: ['1.4'], major: 2, digests: { [`web:${SHA}`]: 'W2', 'web:c-1.4': 'W1' } });
  assert.equal((await run(raised, 'production', ['web'])).version, '2.0');
  const first = repo({ tags: [], major: 1, digests: { [`web:${SHA}`]: 'W' } });
  assert.deepEqual(await run(first, 'production', ['web']), {
    environment: 'production',
    version: '1.0',
    apps: { web: '1.0' },
  });
  const added = repo({
    tags: ['1.0'],
    major: 1,
    digests: { [`web:${SHA}`]: 'W', 'web:c-1.0': 'W', [`new:${SHA}`]: 'N' },
  });
  assert.deepEqual((await run(added, 'production', ['web', 'new'])).apps, { web: '1.1', new: '1.1' });
});

test('a marker without a whole-number major of 1 or higher is a usage error, on every run and in every environment', async () => {
  const digests = { [`web:${SHA}`]: 'W2', 'web:c-1.0': 'W1' };
  await assert.rejects(run(repo({ tags: ['1.0'], digests }), 'production', ['web']), /states no major/);
  await assert.rejects(run(repo({ tags: ['1.0'], major: '"one"', digests }), 'production', ['web']), /whole number/);
  await assert.rejects(run(repo({ tags: [], major: 0, digests }), 'production', ['web']), /1 or higher/);
  const unchanged = { [`web:${SHA}`]: 'W', 'web:c-1.0': 'W' };
  await assert.rejects(run(repo({ tags: ['1.0'], digests: unchanged }), 'production', ['web']), /states no major/);
  await assert.rejects(run(repo({ tags: ['1.0'], digests: {} }), 'staging'), /states no major/);
  await assert.rejects(run(repo({ tags: ['2.3'], major: 1, digests: {} }), 'staging'), /never goes back/);
});

test('the major a newborn repo-turbo repo with display versions states is the one this reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plx-ci-major-'));
  try {
    for (const [answers, major] of [
      [{}, 1],
      [{ major: 3 }, 3],
    ] as const) {
      const target = join(dir, `major-${major}`);
      // The birth commands and git are not the matter here: nothing but the tree is written.
      const ctx = new Context({ yes: true }, { ...realIo(), exec: async () => '' });
      await newSite(ctx, {
        dir: target,
        templates: ['repo-turbo'],
        answers: { tenant: 'acme', display_versions: true, ...answers },
        plxVersion: '0.0.0',
        root: templatesRoot(),
      });
      assert.equal(await majorOf(new Context({}, realIo()), target), major);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('production: an image that is not published is an error, since publish runs first', async () => {
  await assert.rejects(run(repo({ tags: ['1.0'], major: 1, digests: {} }), 'production', ['web']), /is not published/);
});

test('staging: the last version with a +, the bare version at its own commit, 0.0+ before the first; never a version', async () => {
  assert.deepEqual(await run(repo({ tags: ['1.0', '1.2', '1.1'], major: 1, digests: {} }), 'staging'), {
    environment: 'staging',
    previous: '1.2',
    version: '',
    apps: { web: '1.2+', api: '1.2+' },
  });
  assert.deepEqual((await run(repo({ tags: ['1.0', '1.2'], major: 1, at: '1.2', digests: {} }), 'staging')).apps, {
    web: '1.2',
    api: '1.2',
  });
  // An older tag at the commit is not the last version of its history.
  assert.deepEqual((await run(repo({ tags: ['1.0', '1.2'], major: 1, at: '1.0', digests: {} }), 'staging')).apps, {
    web: '1.2+',
    api: '1.2+',
  });
  assert.deepEqual(await run(repo({ tags: [], major: 1, digests: {} }), 'staging'), {
    environment: 'staging',
    version: '',
    apps: { web: '0.0+', api: '0.0+' },
  });
});

test('notes list the commit subjects since the previous version; the first version says so', async () => {
  const r = repo({ tags: [], digests: {}, log: 'feat: a\n\nfix: b\n' });
  const ctx = new Context({}, r.io);
  assert.equal(await notesOf(ctx, 'repo', SHA, '1.2'), '- feat: a\n- fix: b');
  assert.equal(await notesOf(ctx, 'repo', SHA, undefined), 'The first version.');
});

test('tagging posts a release at the commit, and a re-run finds its tag; a tag elsewhere is never moved', async () => {
  const curl: string[][] = [];
  const fresh = repo({ tags: ['1.2'], digests: {}, log: 'feat: a\n', curl });
  const tagged = await tagDisplayVersion(new Context({}, fresh.io), {
    dir: 'repo',
    repo: 'acme/app',
    token: 'secret',
    version: '1.3',
    sha: SHA,
  });
  assert.deepEqual(tagged, { version: '1.3', sha: SHA, existed: false });
  assert.equal(curl.length, 1);
  const config = curl[0]?.[0] ?? '';
  assert.match(config, /url = "https:\/\/api.github.com\/repos\/acme\/app\/releases"/);
  const data = JSON.parse(JSON.parse(/^data = (.*)$/m.exec(config)?.[1] ?? '""')) as Record<string, string>;
  assert.deepEqual(data, { tag_name: '1.3', target_commitish: SHA, name: '1.3', body: '- feat: a' });

  const again = repo({ tags: ['1.2', '1.3'], digests: {}, existing: { '1.3': SHA }, curl });
  const opts = { dir: 'repo', repo: 'acme/app', token: 't', version: '1.3', sha: SHA };
  assert.equal((await tagDisplayVersion(new Context({}, again.io), opts)).existed, true);
  const elsewhere = repo({ tags: ['1.3'], digests: {}, existing: { '1.3': 'other' }, curl });
  await assert.rejects(tagDisplayVersion(new Context({}, elsewhere.io), opts), /never moves/);
  assert.equal(curl.length, 1);

  const dry = repo({ tags: ['1.2'], digests: {}, curl });
  await tagDisplayVersion(new Context({ dryRun: true }, dry.io), opts);
  assert.equal(curl.length, 1);
  await assert.rejects(tagDisplayVersion(new Context({}, dry.io), { ...opts, version: 'v1.3' }), UsageError);
});

test('the apps are read from the deploys the verify planned', () => {
  assert.deepEqual(appsOfDeploys('[{"app":"web","host":"h","image":"i"},{"app":"api","host":"h","image":"i"}]'), [
    'web',
    'api',
  ]);
  assert.deepEqual(appsOfDeploys('[]'), []);
  assert.throws(() => appsOfDeploys('{'), UsageError);
  assert.throws(() => appsOfDeploys('[{"host":"h"}]'), UsageError);
});
