import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context, UsageError } from '@plexus-ms/lib';
import { appsOfDeploys } from '../commands/displayVersions.ts';
import { fakeIo, notThere } from '../testing/fakeIo.ts';
import {
  displayVersions,
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
}) {
  const marker = options.major === undefined ? '---\n---\n' : `---\nmajor: ${options.major}\n---\n`;
  const crane: string[] = [];
  return {
    crane,
    io: fakeIo(
      { repo: { 'PLEXUS.md': marker } },
      (_cwd, args) => {
        if (args[0] === 'tag' && args[1] === '--merged') return [...options.tags, 'some-other-tag'].join('\n');
        if (args[0] === 'rev-parse' && args[1] === '--short=7') return 'abcdef1\n';
        if (args[0] === 'rev-parse' && args[1] === '-q') {
          const tag = /^refs\/tags\/(.+)\^\{commit\}$/.exec(args[3] ?? '')?.[1] ?? '';
          return options.existing?.[tag];
        }
        if (args[0] === 'rev-parse') return `${commitOf((args[1] ?? '').replace('^{commit}', ''))}\n`;
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

test('production: a changed app cuts the next version and shows it, an unchanged one shows the version it was first released in', async () => {
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
    apps: { web: '1.1', api: '1.3' },
  });
  // The walk stops at the first version with another image.
  assert.ok(!r.crane.includes('ghcr.io/acme/api:c-1.1'));
});

test('production: nothing changed, no version; every app keeps the version it shows', async () => {
  const r = repo({
    tags: ['1.0', '1.1'],
    major: 1,
    digests: { [`web:${SHA}`]: 'W', 'web:c-1.1': 'W', 'web:c-1.0': 'W', [`api:${SHA}`]: 'A', 'api:c-1.1': 'A' },
  });
  assert.deepEqual(await run(r), {
    environment: 'production',
    previous: '1.1',
    version: '',
    apps: { web: '1.0', api: '1.1' },
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
  assert.deepEqual((await run(added, 'production', ['web', 'new'])).apps, { web: '1.0', new: '1.1' });
});

test('production: a marker without a whole-number major is a usage error, asked only when a version is cut', async () => {
  const digests = { [`web:${SHA}`]: 'W2', 'web:c-1.0': 'W1' };
  await assert.rejects(run(repo({ tags: ['1.0'], digests }), 'production', ['web']), /states no major/);
  await assert.rejects(run(repo({ tags: ['1.0'], major: '"one"', digests }), 'production', ['web']), /whole number/);
  const unchanged = repo({ tags: ['1.0'], digests: { [`web:${SHA}`]: 'W', 'web:c-1.0': 'W' } });
  assert.equal((await run(unchanged, 'production', ['web'])).version, '');
});

test('production: an image that is not published is an error, since publish runs first', async () => {
  await assert.rejects(run(repo({ tags: ['1.0'], major: 1, digests: {} }), 'production', ['web']), /is not published/);
});

test('staging: the last version in the history and the short sha, or the short sha alone; never a version', async () => {
  assert.deepEqual(await run(repo({ tags: ['1.0', '1.2', '1.1'], digests: {} }), 'staging'), {
    environment: 'staging',
    previous: '1.2',
    version: '',
    apps: { web: '1.2+abcdef1', api: '1.2+abcdef1' },
  });
  assert.deepEqual((await run(repo({ tags: [], digests: {} }), 'staging')).apps, {
    web: 'abcdef1',
    api: 'abcdef1',
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
