import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from './context.ts';
import { fakeIo } from './testing/fakeIo.ts';
import { isPlexusVersion, plxPinOf, preflightForge } from './version.ts';

const withGh = (gh: () => string | undefined) =>
  new Context(
    {},
    fakeIo({}, () => undefined, { gh }),
  );

test('preflightForge needs a logged-in gh', async () => {
  await preflightForge(withGh(() => 'Logged in\n'));
  await assert.rejects(preflightForge(withGh(() => undefined)), /gh is not logged in/);
});

test('a Plexus version is plain semver', () => {
  assert.equal(isPlexusVersion('0.118.0'), true);
  assert.equal(isPlexusVersion('v0.21'), false);
  assert.equal(isPlexusVersion('0.100.0-rc.1'), false);
});

test('plxPinOf reads the version a repo is on from its mise.toml, in either spelling', () => {
  assert.equal(
    plxPinOf('[tools]\n"npm:@plexus-ms/cli" = { version = "0.122.0", allow_low_downloads = true }\n'),
    '0.122.0',
  );
  assert.equal(plxPinOf('[tools]\n"npm:@plexus-ms/cli" = "0.122.0"\n'), '0.122.0');
  assert.equal(plxPinOf('[tools]\n"npm:@plexus-ms/cli-ci" = "0.122.0"\n'), undefined, 'plx-ci is not plx');
  assert.equal(plxPinOf('[tools]\nnode = "24"\n'), undefined);
});
