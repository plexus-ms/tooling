// The offline harness of the deploy verb, reborn from ci-cd's bash days: a
// fake `ssh` on PATH that runs each remote one-liner locally with bash, in a
// scratch app dir standing in for /opt/stacks/<app>, with a fake
// `docker` next to it. Every docker call is appended to FAKE_LOG; the fake
// docker keeps "what runs" in <app dir>/.running, read by `compose ps`/`inspect`,
// written by `compose up`, so reality on the fake host is a file the verb
// never reads itself.
//
//   FAKE_PULL_FAIL=1        `docker compose pull` exits 1
//   FAKE_STARTING_LOOKS=n   the first n looks at the health status, counted
//                           in <app dir>/.looks, answer `starting`
//   an image containing "bad" never turns healthy
//   FAKE_IMAGE_ID=<id>      every ref names the image <id>, the running one
//                           among them; without it a ref's id is the ref
//
// A no-op `sleep` stands in for the wait's pause between looks: the tests
// count looks, not seconds.
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { Context, type Options } from './context.ts';
import { deploy } from './deploy.ts';
import { realIo } from './io.ts';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'plx-deploy-')));
after(() => rmSync(TMP, { recursive: true, force: true }));

const BIN = join(TMP, 'bin');
mkdirSync(BIN);
const fake = (name: string, script: string) => {
  writeFileSync(join(BIN, name), `#!/usr/bin/env bash\nset -euo pipefail\n${script}`);
  chmodSync(join(BIN, name), 0o755);
};

// ssh: skip the options, run what follows `--` locally; `-O exit` is a no-op.
fake(
  'ssh',
  `
for a in "$@"; do [ "$a" = -O ] && exit 0; done
while [ "$1" != -- ]; do shift; done; shift
exec bash -c "$1"
`,
);

// docker: compose pull/run/up/ps/config/logs and inspect, against the cwd's
// compose file (or the -f one), state in .running.
fake(
  'docker',
  `
echo "docker $*" >> "$FAKE_LOG"
file=compose.yaml
if [ "$1" = pull ]; then exit 0; fi
if [ "$1" = image ]; then
  # image inspect --format {{.Id}} <ref>
  echo "\${FAKE_IMAGE_ID:-$5}"
  exit 0
fi
if [ "$1" = inspect ]; then
  # inspect --format <fmt> <cid>
  case "$3" in
    *Config.Image*) cat .running ;;
    *.Image*) echo "\${FAKE_IMAGE_ID:-$(cat .running)}" ;;
    *State.Health*)
      n=$(( $(cat .looks 2>/dev/null || echo 0) + 1 )); echo "$n" > .looks
      if grep -q bad .running || [ "$n" -le "\${FAKE_STARTING_LOOKS:-0}" ]; then echo starting; else echo healthy; fi ;;
  esac
  exit 0
fi
shift  # compose
while [ "$1" = --project-directory ] || [ "$1" = -f ] || [ "$1" = --profile ]; do
  [ "$1" = -f ] && file="$2"; shift 2
done
case "$1" in
  pull) [ -z "\${FAKE_PULL_FAIL:-}" ] || { echo "pull failed" >&2; exit 1; } ;;
  run) : ;;
  up) sed -n 's/^ *image: *//p' compose.yaml | head -1 > .running ;;
  ps) [ -f .running ] && echo cid || true ;;
  config) sed -n 's/^  \\([a-z]*\\):$/\\1/p' "$file" ;;
  logs) echo "fake log line" ;;
esac
`,
);

fake('sleep', ':');

const COMPOSE = `services:
  web:
    image: \${PLEXUS_DEPLOYMENT_IMAGE:?set}
    ports: ["127.0.0.1:3011:3000"]
    healthcheck:
      test: ["CMD", "true"]
  migrate:
    image: \${PLEXUS_DEPLOYMENT_IMAGE:?set}
    command: pnpm migrate
    profiles: ["migrate"]
`;

function fixture(previous?: string, compose = COMPOSE) {
  const root = mkdtempSync(join(TMP, 'case-'));
  const checkout = join(root, 'checkout');
  mkdirSync(join(checkout, 'apps/web/docker'), { recursive: true });
  writeFileSync(join(checkout, 'apps/web/docker/compose.yaml'), compose);
  const appDir = join(root, 'host', 'web');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, '.env'), 'PLEXUS_LOOPBACK_PORT=3011\n');
  if (previous) {
    writeFileSync(join(appDir, 'compose.yaml'), COMPOSE.replaceAll('${PLEXUS_DEPLOYMENT_IMAGE:?set}', previous));
    writeFileSync(join(appDir, '.running'), `${previous}\n`);
  }
  const log = join(root, 'docker.log');
  writeFileSync(log, '');
  return { checkout, appDir, log };
}

function run(
  options: Options,
  checkout: string,
  appDir: string,
  image: string,
  env: Record<string, string> = {},
  retries = 1,
) {
  const stderr = new PassThrough();
  let err = '';
  stderr.on('data', (c: Buffer) => {
    err += c;
  });
  const io = realIo();
  io.stderr = stderr;
  const saved = { ...process.env };
  process.env.PATH = `${BIN}:${process.env.PATH}`;
  Object.assign(process.env, env);
  const ctx = new Context(options, io);
  return deploy(ctx, { host: 'deploy@fake', app: 'web', image, appDir, dir: checkout, retries })
    .finally(() => {
      // In place: a child process takes the environment object Node started
      // with, so assigning a new one to process.env would leave this run's
      // values in every later one.
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    })
    .then(
      (result) => ({ result, err }),
      (error: unknown) => Promise.reject(Object.assign(error as Error, { err })),
    );
}

const dockerLog = (log: string) =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.replace(/ --project-directory \. -f \.incoming\/compose\.yaml/, ' [staged]'));

test('happy path on the fake host: pull and migrate against the staged file, swap, up, healthy, staging gone', async () => {
  const { checkout, appDir, log } = fixture('ghcr.io/x/web:old');
  const { result, err } = await run({}, checkout, appDir, 'ghcr.io/x/web:new', { FAKE_LOG: log });
  assert.equal(result.healthy, true);
  assert.equal(result.previous, 'ghcr.io/x/web:old');
  assert.equal(result.live, 'ghcr.io/x/web:new');
  assert.equal(readFileSync(join(appDir, '.running'), 'utf8').trim(), 'ghcr.io/x/web:new');
  assert.match(readFileSync(join(appDir, 'compose.yaml'), 'utf8'), /image: ghcr.io\/x\/web:new/);
  assert.ok(!existsSync(join(appDir, '.incoming')));
  const actions = dockerLog(log).filter((l) => /pull|run|up/.test(l));
  assert.deepEqual(actions, [
    'docker pull -q ghcr.io/x/web:new',
    'docker compose [staged] pull',
    'docker compose [staged] run --rm migrate',
    'docker compose up -d --remove-orphans',
  ]);
  assert.match(err, /health: {2}the healthcheck of service web/);
  assert.match(err, /✓ ghcr.io\/x\/web:new is live and healthy/);
});

test('an unhealthy image is rolled back to the previous compose file and image', async () => {
  const { checkout, appDir, log } = fixture('ghcr.io/x/web:old');
  const { result, err } = await run({}, checkout, appDir, 'ghcr.io/x/web:bad', { FAKE_LOG: log });
  assert.equal(result.healthy, false);
  assert.equal(result.rolledBack, true);
  assert.equal(readFileSync(join(appDir, '.running'), 'utf8').trim(), 'ghcr.io/x/web:old');
  assert.match(readFileSync(join(appDir, 'compose.yaml'), 'utf8'), /image: ghcr.io\/x\/web:old/);
  assert.ok(!existsSync(join(appDir, '.incoming')));
  assert.equal(dockerLog(log).filter((l) => l === 'docker compose up -d --remove-orphans').length, 2);
  assert.match(err, /✗ healthcheck failed after \d+s/);
  assert.match(err, / {4}fake log line/);
  assert.match(err, /✓ rolled back to ghcr.io\/x\/web:old/);
});

test('a failed pull changes nothing on the host and the error names the command', async () => {
  const { checkout, appDir, log } = fixture('ghcr.io/x/web:old');
  await assert.rejects(
    run({}, checkout, appDir, 'ghcr.io/x/web:new', { FAKE_LOG: log, FAKE_PULL_FAIL: '1' }),
    /pull failed/,
  );
  assert.equal(readFileSync(join(appDir, '.running'), 'utf8').trim(), 'ghcr.io/x/web:old');
  assert.match(readFileSync(join(appDir, 'compose.yaml'), 'utf8'), /image: ghcr.io\/x\/web:old/);
  assert.ok(!existsSync(join(appDir, '.incoming')));
  assert.ok(!dockerLog(log).some((l) => /run|up/.test(l)));
});

test('a first deploy on an empty app dir works, and an unhealthy one fails without a rollback', async () => {
  const ok = fixture();
  const { result } = await run({}, ok.checkout, ok.appDir, 'ghcr.io/x/web:new', { FAKE_LOG: ok.log });
  assert.equal(result.healthy, true);
  assert.equal(result.previous, undefined);
  const bad = fixture();
  const { result: r, err } = await run({}, bad.checkout, bad.appDir, 'ghcr.io/x/web:bad', { FAKE_LOG: bad.log });
  assert.equal(r.healthy, false);
  assert.equal(r.rolledBack, false);
  assert.match(err, /nothing to roll back to/);
  assert.ok(!existsSync(join(bad.appDir, 'compose.yaml.prev')));
});

test('an app service without a healthcheck fails before the host is touched, naming the requirement', async () => {
  const { checkout, appDir, log } = fixture('ghcr.io/x/web:old', COMPOSE.replace(/ {4}healthcheck:\n.*\n/, ''));
  await assert.rejects(
    run({}, checkout, appDir, 'ghcr.io/x/web:new', { FAKE_LOG: log }),
    /declares no healthcheck.*PLX-App\/Healthcheck/,
  );
  assert.equal(readFileSync(join(appDir, '.running'), 'utf8').trim(), 'ghcr.io/x/web:old');
  assert.match(readFileSync(join(appDir, 'compose.yaml'), 'utf8'), /image: ghcr.io\/x\/web:old/);
  assert.ok(!existsSync(join(appDir, '.incoming')));
  assert.deepEqual(dockerLog(log), []);
});

/** The health looks in a docker log, in order. */
const looks = (lines: string[]) => lines.filter((l) => l.includes('State.Health'));

test('a container that turns healthy only after a few looks is accepted, within --retries looks', async () => {
  const { checkout, appDir, log } = fixture('ghcr.io/x/web:old');
  const env = { FAKE_LOG: log, FAKE_STARTING_LOOKS: '2' };
  const { result, err } = await run({}, checkout, appDir, 'ghcr.io/x/web:new', env, 3);
  assert.equal(result.healthy, true);
  assert.equal(result.rolledBack, false);
  assert.equal(looks(dockerLog(log)).length, 3);
  assert.match(err, /✓ ghcr.io\/x\/web:new is live and healthy/);

  // One look fewer than it needs, and it is rolled back.
  const short = fixture('ghcr.io/x/web:old');
  const { result: r } = await run(
    {},
    short.checkout,
    short.appDir,
    'ghcr.io/x/web:new',
    { ...env, FAKE_LOG: short.log },
    2,
  );
  assert.equal(r.healthy, false);
  assert.equal(r.rolledBack, true);
});

test('"already live and healthy" is decided by a single look; a container still starting gets the full deploy', async () => {
  const { checkout, appDir, log } = fixture('ghcr.io/x/web:same');
  const env = { FAKE_LOG: log, FAKE_STARTING_LOOKS: '1' };
  const { result } = await run({}, checkout, appDir, 'ghcr.io/x/web:same', env, 3);
  assert.equal(result.unchanged, undefined);
  assert.equal(result.healthy, true);
  const lines = dockerLog(log);
  const pull = lines.findIndex((l) => l.endsWith(' pull'));
  assert.ok(pull > 0);
  assert.equal(looks(lines.slice(0, pull)).length, 1);

  const healthy = fixture('ghcr.io/x/web:same');
  const { result: same } = await run(
    {},
    healthy.checkout,
    healthy.appDir,
    'ghcr.io/x/web:same',
    { FAKE_LOG: healthy.log },
    3,
  );
  assert.equal(same.unchanged, true);
  assert.equal(looks(dockerLog(healthy.log)).length, 1);
  assert.ok(!dockerLog(healthy.log).some((l) => l.endsWith(' pull')));
});

test('a new ref naming the running image, from the same run shape, is already live; from a changed one it deploys', async () => {
  const { checkout, appDir, log } = fixture('ghcr.io/x/web:old');
  const env = { FAKE_LOG: log, FAKE_IMAGE_ID: 'sha256:one' };
  const { result, err } = await run({}, checkout, appDir, 'ghcr.io/x/web:new', env);
  assert.equal(result.unchanged, true);
  assert.equal(result.live, 'ghcr.io/x/web:old');
  assert.equal(readFileSync(join(appDir, '.running'), 'utf8').trim(), 'ghcr.io/x/web:old');
  assert.match(readFileSync(join(appDir, 'compose.yaml'), 'utf8'), /image: ghcr.io\/x\/web:old/);
  assert.ok(!dockerLog(log).some((l) => l.endsWith(' pull') || l.includes(' up ')));
  assert.match(err, /already live and healthy; nothing to do/);

  const changed = fixture('ghcr.io/x/web:old', COMPOSE.replace('3011:3000', '3012:3000'));
  const { result: full } = await run({}, changed.checkout, changed.appDir, 'ghcr.io/x/web:new', {
    FAKE_LOG: changed.log,
    FAKE_IMAGE_ID: 'sha256:one',
  });
  assert.equal(full.unchanged, undefined);
  assert.equal(full.live, 'ghcr.io/x/web:new');
});
