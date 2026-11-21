import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { declaresHealthcheck, healthcheckOf, parseCompose } from './compose.ts';
import { Context, type Options } from './context.ts';
import { defaultAppDir, deploy, q, renderCompose, renderDisplayVersion, seconds, slowStart } from './deploy.ts';
import { fakeIo, type Tree } from './testing/fakeIo.ts';
import { UsageError } from './version.ts';

const COMPOSE = 'services:\n  web:\n    image: ${PLEXUS_DEPLOYMENT_IMAGE:?set}\n';
const PINNED = 'services:\n  web:\n    image: ghcr.io/x/beszel:1.0\n';
/** The app service's healthcheck (PLX-App/Healthcheck), which every deployed file declares. */
const HEALTHCHECK = '    healthcheck:\n      test: [CMD, "true"]\n';

test('renderCompose pins the placeholder once, with or without a message, and refuses a mismatch', () => {
  assert.equal(renderCompose(COMPOSE, 'ghcr.io/x/web:abc', 'c'), 'services:\n  web:\n    image: ghcr.io/x/web:abc\n');
  assert.equal(
    renderCompose('a: ${PLEXUS_DEPLOYMENT_IMAGE}\nb: ${PLEXUS_DEPLOYMENT_IMAGE}\n', 'i', 'c'),
    'a: i\nb: i\n',
  );
  assert.equal(renderCompose(PINNED, undefined, 'c'), PINNED);
  assert.throws(() => renderCompose(PINNED, 'ghcr.io/x/web:abc', 'apps/x/compose.yaml'), UsageError);
  assert.throws(() => renderCompose(COMPOSE, undefined, 'apps/x/compose.yaml'), UsageError);
});

test('renderDisplayVersion quotes a whole unquoted value, fills one inside a string, and leaves a file without it alone', () => {
  const file = [
    'services:',
    '  web:',
    '    environment:',
    '      PLEXUS_DISPLAY_VERSION: ${PLEXUS_DISPLAY_VERSION:-}',
    '      QUOTED: "${PLEXUS_DISPLAY_VERSION}"',
    '      LABEL: Vernier ${PLEXUS_DISPLAY_VERSION:-dev}',
    '    command: [run, "--version=${PLEXUS_DISPLAY_VERSION}"]',
    '',
  ].join('\n');
  const rendered = renderDisplayVersion(file, '1.10', 'c');
  assert.equal(
    rendered,
    [
      'services:',
      '  web:',
      '    environment:',
      '      PLEXUS_DISPLAY_VERSION: "1.10"',
      '      QUOTED: "1.10"',
      '      LABEL: Vernier 1.10',
      '    command: [run, "--version=1.10"]',
      '',
    ].join('\n'),
  );
  // Read back as compose would: a string, never the number 1.1.
  const environment = parseCompose(rendered, 'c').services.web?.environment as Record<string, unknown> | undefined;
  assert.equal(environment?.PLEXUS_DISPLAY_VERSION, '1.10');
  assert.equal(renderDisplayVersion(COMPOSE, '1.10', 'c'), COMPOSE);
  assert.equal(renderDisplayVersion(file, undefined, 'c'), file);
  assert.equal(renderDisplayVersion(file, '', 'c'), file);
  assert.match(renderDisplayVersion(file, '1.4+a1b2c3d', 'c'), /PLEXUS_DISPLAY_VERSION: "1\.4\+a1b2c3d"/);
  assert.throws(() => renderDisplayVersion(file, '1.4 "x"', 'c'), UsageError);
  assert.throws(() => renderDisplayVersion(file, '-1', 'c'), UsageError);
});

test('q quotes for a remote shell', () => {
  assert.equal(q('/opt/stacks/a'), "'/opt/stacks/a'");
  assert.equal(q("it's"), "'it'\\''s'");
});

/** The remote command of an ssh call, and what was fed to it. */
const remoteOf = (args: string[]) => args[args.indexOf('--') + 1] ?? args.join(' ');

interface Host {
  /** Answers a remote command: output, or undefined to fail it. */
  answer: (command: string, input?: string) => string | undefined;
}

function harness(tree: Tree, host: Host, options: Options = {}) {
  const commands: string[] = [];
  const io = fakeIo(tree, undefined, {
    ssh: (_cwd, args, input) => {
      if (args.includes('-O')) return '';
      const command = remoteOf(args);
      commands.push(command);
      return host.answer(command, input);
    },
  });
  const stderr = new PassThrough();
  let err = '';
  stderr.on('data', (c: Buffer) => {
    err += c;
  });
  io.stderr = stderr;
  return { ctx: new Context(options, io), commands, err: () => err };
}

const checkout: Tree = { repo: { apps: { web: { docker: { 'compose.yaml': COMPOSE + HEALTHCHECK } } } } };
const D = "'/opt/stacks/web'";

/**
 * A host serving `previous`, declaring migrate, healthy unless the live image
 * contains "bad". `sameImage`: every other ref names the image it runs, and
 * `serving` is the compose file it serves.
 */
function host(
  previous: string | undefined,
  { migrate = true, sameImage = false, serving = '' } = {},
): Host & { live?: string; staged?: string } {
  const h: Host & { live?: string; staged?: string } = {
    live: previous,
    answer(command, input) {
      if (command.includes('docker pull -q')) return sameImage ? '' : undefined;
      if (command.startsWith('cat ') && command.endsWith('/compose.yaml')) return serving;
      if (command.startsWith('rm -rf') && command.includes('cat >')) {
        h.staged = input;
        return '';
      }
      if (command.includes("inspect --format '{{.Config.Image}}'")) return h.live ?? '';
      if (command.includes('grep -qx migrate')) return migrate ? '' : undefined;
      if (command.includes('test -f')) return previous === undefined ? undefined : '';
      if (command.includes('mv .incoming/compose.yaml compose.yaml')) {
        h.live = /image: (\S+)/.exec(h.staged ?? '')?.[1];
        return '';
      }
      if (command.includes('cp -p .incoming/compose.yaml.prev compose.yaml')) {
        h.live = previous;
        return '';
      }
      if (command.includes('.State.Health.Status')) return h.live?.includes('bad') ? undefined : '';
      if (command.includes('cmp -s')) return '';
      if (command.includes('logs')) return 'boom\n';
      return '';
    },
  };
  return h;
}

test('happy path: stage, pull, migrate, keep the previous file, swap, up, wait for the healthcheck', async () => {
  const h = host('ghcr.io/x/web:old');
  const { ctx, commands, err } = harness(checkout, h);
  const result = await deploy(ctx, {
    host: 'deploy@h',

    app: 'web',
    image: 'ghcr.io/x/web:new',
    dir: '/repo',
  });
  assert.equal(h.staged, `services:\n  web:\n    image: ghcr.io/x/web:new\n${HEALTHCHECK}`);
  assert.deepEqual(
    commands.filter((c) => !c.includes('inspect') || c.includes('.State.Health.Status')),
    [
      `rm -rf ${D}/.incoming && mkdir -p ${D}/.incoming && cat > ${D}/.incoming/compose.yaml`,
      `cd ${D} && docker compose --project-directory . -f .incoming/compose.yaml pull`,
      `cd ${D} && docker compose --project-directory . -f .incoming/compose.yaml --profile migrate config --services 2>/dev/null | grep -qx migrate`,
      `cd ${D} && docker compose --project-directory . -f .incoming/compose.yaml run --rm migrate </dev/null`,
      `test -f ${D}/compose.yaml`,
      `cd ${D} && cp -p compose.yaml .incoming/compose.yaml.prev`,
      `cd ${D} && mv .incoming/compose.yaml compose.yaml`,
      `cd ${D} && docker compose up -d --remove-orphans`,
      `cd ${D} && for _ in $(seq 1 30); do [ "$(docker compose ps -q web 2>/dev/null | head -1 | xargs -r docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null)" = healthy ] && exit 0; sleep 2; done; exit 1`,
      `rm -rf ${D}/.incoming`,
    ],
  );
  assert.deepEqual(result, {
    host: 'deploy@h',
    appDir: '/opt/stacks/web',
    compose: 'apps/web/docker/compose.yaml',
    image: 'ghcr.io/x/web:new',
    previous: 'ghcr.io/x/web:old',
    live: 'ghcr.io/x/web:new',
    healthy: true,
    rolledBack: false,
  });
  assert.match(err(), /✓ ghcr.io\/x\/web:new is live and healthy/);
});

test('a display version is pinned into the staged file and reported; a file without the placeholder deploys as before', async () => {
  const env = '    environment:\n      PLEXUS_DISPLAY_VERSION: ${PLEXUS_DISPLAY_VERSION:-}\n';
  const withVersion: Tree = { repo: { apps: { web: { docker: { 'compose.yaml': COMPOSE + env + HEALTHCHECK } } } } };
  const h = host('ghcr.io/x/web:old');
  const { ctx } = harness(withVersion, h);
  const result = await deploy(ctx, {
    host: 'deploy@h',
    app: 'web',
    image: 'ghcr.io/x/web:new',
    displayVersion: '1.10',
    dir: '/repo',
  });
  assert.equal(
    h.staged,
    `services:\n  web:\n    image: ghcr.io/x/web:new\n    environment:\n      PLEXUS_DISPLAY_VERSION: "1.10"\n${HEALTHCHECK}`,
  );
  assert.equal(result.displayVersion, '1.10');

  const plain = host('ghcr.io/x/web:old');
  const without = harness(checkout, plain);
  const unused = await deploy(without.ctx, {
    host: 'deploy@h',
    app: 'web',
    image: 'ghcr.io/x/web:new',
    displayVersion: '1.10',
    dir: '/repo',
  });
  assert.equal(plain.staged, `services:\n  web:\n    image: ghcr.io/x/web:new\n${HEALTHCHECK}`);
  assert.equal(unused.displayVersion, undefined);
  assert.equal(unused.healthy, true);
});

test('no migrate service and a third-party file: fewer steps, nothing rendered', async () => {
  const h = host(undefined, { migrate: false });
  const tree: Tree = { repo: { apps: { beszel: { 'compose.yaml': PINNED + HEALTHCHECK } } } };
  const { ctx, commands } = harness(tree, h);
  const result = await deploy(ctx, {
    host: 'deploy@h',

    app: 'beszel',
    image: '',
    retries: 3,
    dir: '/repo',
  });
  assert.equal(h.staged, PINNED + HEALTHCHECK);
  assert.ok(!commands.some((c) => c.includes('run --rm migrate')));
  assert.ok(!commands.some((c) => c.includes('cp -p compose.yaml')));
  assert.ok(commands.some((c) => c.includes('seq 1 3') && c.includes('.State.Health.Status')));
  assert.equal(result.compose, 'apps/beszel/compose.yaml');
  assert.equal(result.previous, undefined);
  assert.equal(result.live, 'ghcr.io/x/beszel:1.0');
  assert.equal(result.healthy, true);
});

test('an unhealthy app rolls back to the previous file and reports it', async () => {
  const h = host('ghcr.io/x/web:old');
  const { ctx, commands, err } = harness(checkout, h);
  const result = await deploy(ctx, {
    host: 'deploy@h',

    app: 'web',
    image: 'ghcr.io/x/web:bad',
    dir: '/repo',
  });
  const ups = commands.filter((c) => c.endsWith('docker compose up -d --remove-orphans')).length;
  assert.equal(ups, 2);
  assert.ok(commands.some((c) => c.includes('logs --no-color --tail 50 web')));
  assert.ok(commands.some((c) => c.includes('cp -p .incoming/compose.yaml.prev compose.yaml')));
  assert.equal(commands.at(-1), `rm -rf ${D}/.incoming`);
  assert.equal(result.healthy, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.live, 'ghcr.io/x/web:old');
  assert.match(err(), /✗ healthcheck failed/);
  assert.match(err(), / {4}boom/);
  assert.match(err(), /↩ rolling back to ghcr.io\/x\/web:old/);
  assert.match(err(), /✓ rolled back to ghcr.io\/x\/web:old/);
});

test('the rollback waits as long as the deploy: --retries looks for both, one look for "already live"', async () => {
  const h = host('ghcr.io/x/web:old');
  const { ctx, commands } = harness(checkout, h);
  const result = await deploy(ctx, {
    host: 'deploy@h',
    app: 'web',
    image: 'ghcr.io/x/web:bad',
    dir: '/repo',
    retries: 7,
  });
  assert.equal(result.rolledBack, true);
  const waits = commands.filter((c) => c.includes('.State.Health.Status')).map((c) => /seq 1 (\d+)/.exec(c)?.[1]);
  assert.deepEqual(waits, ['7', '7']);

  const same = harness(checkout, host('ghcr.io/x/web:same'));
  await deploy(same.ctx, { host: 'deploy@h', app: 'web', image: 'ghcr.io/x/web:same', dir: '/repo', retries: 7 });
  const looks = same.commands.filter((c) => c.includes('.State.Health.Status')).map((c) => /seq 1 (\d+)/.exec(c)?.[1]);
  assert.deepEqual(looks, ['1']);
});

test('a first deploy that is unhealthy has nothing to roll back to', async () => {
  const h = host(undefined);
  const { ctx, commands, err } = harness(checkout, h);
  const result = await deploy(ctx, {
    host: 'deploy@h',

    app: 'web',
    image: 'ghcr.io/x/web:bad',
    dir: '/repo',
  });
  assert.equal(commands.filter((c) => c.endsWith('docker compose up -d --remove-orphans')).length, 1);
  assert.equal(result.healthy, false);
  assert.equal(result.rolledBack, false);
  assert.match(err(), /✗ nothing to roll back to/);
});

test('a failing pull leaves the host as it was, cleans the staging dir and rethrows', async () => {
  const h = host('ghcr.io/x/web:old');
  const base = h.answer.bind(h);
  h.answer = (c, i) => (c.endsWith(' pull') ? undefined : base(c, i));
  const { ctx, commands } = harness(checkout, h);
  await assert.rejects(deploy(ctx, { host: 'deploy@h', app: 'web', image: 'ghcr.io/x/web:new', dir: '/repo' }));
  assert.ok(!commands.some((c) => c.includes('mv .incoming')));
  assert.ok(!commands.some((c) => c.endsWith('up -d --remove-orphans')));
  assert.equal(commands.at(-1), `rm -rf ${D}/.incoming`);
  assert.equal(h.live, 'ghcr.io/x/web:old');
});

/** Healthchecks that can never report healthy on their own: none, disabled in each form compose reads as true, no test of their own. */
const NEVER_HEALTHY = [
  '',
  '    healthcheck:\n      disable: true\n',
  ...['"true"', 'True', '"yes"', 'yes', 'on', '"Y"'].map(
    (v) => `    healthcheck:\n      test: [CMD, "true"]\n      disable: ${v}\n`,
  ),
  '    healthcheck: {}\n',
  '    healthcheck:\n      interval: 5s\n',
  '    healthcheck:\n      test: []\n',
  '    healthcheck:\n      test: ""\n',
  '    healthcheck:\n      test: [NONE]\n',
];

test('a healthcheck the app service inherits through a same-file `extends` counts', async () => {
  const text = `services:
  base:
    healthcheck: { test: [CMD, "true"], start_period: 60s, start_interval: 1s }
  web:
    extends: base
    image: \${PLEXUS_DEPLOYMENT_IMAGE}
`;
  const tree: Tree = { repo: { apps: { web: { docker: { 'compose.yaml': text } } } } };
  const { ctx } = harness(tree, host('ghcr.io/x/web:old'));
  await assert.doesNotReject(
    deploy(ctx, { host: 'deploy@h', app: 'web', image: 'ghcr.io/x/web:new', dir: '/repo' }).catch((e: Error) => {
      if (e instanceof UsageError) throw e;
    }),
  );
});

test('an app service without a healthcheck that can turn healthy is a usage error naming the requirement, before anything reaches the host', async () => {
  for (const stanza of NEVER_HEALTHY) {
    const tree: Tree = { repo: { apps: { web: { docker: { 'compose.yaml': COMPOSE + stanza } } } } };
    const { ctx, commands } = harness(tree, host('ghcr.io/x/web:old'));
    await assert.rejects(
      deploy(ctx, { host: 'deploy@h', app: 'web', image: 'ghcr.io/x/web:new', dir: '/repo' }),
      (e: Error) => {
        assert.ok(e instanceof UsageError, stanza);
        assert.match(e.message, /declares no healthcheck.*PLX-App\/Healthcheck/);
        // What the verb does not see, and the stanza that fixes the image-HEALTHCHECK case.
        assert.match(
          e.message,
          /the files an `include` names are not read, nor a service an `extends` takes from another file \(`file:`\)/,
        );
        assert.match(e.message, /an image's own HEALTHCHECK does not count/);
        assert.match(e.message, /\n {4}healthcheck: \{ test: \[CMD, .*\], start_period: 60s, start_interval: 1s \}$/);
        return true;
      },
    );
    assert.deepEqual(commands, [], stanza);
  }
});

test('a compose file that is not valid YAML is a usage error naming it, before anything reaches the host', async () => {
  const tree: Tree = {
    repo: { apps: { web: { docker: { 'compose.yaml': `${COMPOSE}${HEALTHCHECK}    image: x\n` } } } },
  };
  const { ctx, commands } = harness(tree, host('ghcr.io/x/web:old'));
  await assert.rejects(
    deploy(ctx, { host: 'deploy@h', app: 'web', image: 'ghcr.io/x/web:new', dir: '/repo' }),
    (e: Error) =>
      e instanceof UsageError &&
      /^apps\/web\/docker\/compose.yaml: not valid YAML: Map keys must be unique at line \d+, column \d+$/.test(
        e.message,
      ),
  );
  assert.deepEqual(commands, []);
});

test('declaresHealthcheck reads the app service, anchors and merge keys resolved; a test of its own, string or list, counts', () => {
  const declares = (text: string) => declaresHealthcheck(healthcheckOf(parseCompose(text, 'c')));
  assert.equal(declares(COMPOSE + HEALTHCHECK), true);
  assert.equal(declares(`${COMPOSE}    healthcheck:\n      test: curl -f localhost\n`), true);
  assert.equal(declares(`${COMPOSE}    healthcheck:\n      test: [CMD-SHELL, "true"]\n      disable: false\n`), true);
  assert.equal(declares(`${COMPOSE}    healthcheck:\n      test: [CMD, "true"]\n      disable: "no"\n`), true);
  for (const stanza of NEVER_HEALTHY) assert.equal(declares(COMPOSE + stanza), false, stanza);
  assert.equal(
    declares('services:\n  db:\n    healthcheck:\n      test: [CMD, "true"]\n  web:\n    image: x\n'),
    false,
  );
  assert.equal(
    declares('x-web: &web\n  healthcheck:\n    test: [CMD, "true"]\nservices:\n  web:\n    <<: *web\n    image: x\n'),
    true,
  );
});

/** The stanza apps generated before the template set start_interval carry. */
const OLD_STANZA = '    healthcheck:\n      test: [CMD, "true"]\n      interval: 30s\n      start_period: 10s\n';
/** The template's stanza: probed every second for the whole of the default wait. */
const TEMPLATE_STANZA = `${OLD_STANZA.replace('10s', '1m0s')}      start_interval: 1s\n`;

test('a healthcheck without start_interval, or with a start_period under the wait, warns in one line before the deploy, which proceeds', async () => {
  const cases: [string, number | undefined, RegExp | undefined][] = [
    [OLD_STANZA, undefined, /the web healthcheck sets no start_interval, /],
    [`${OLD_STANZA}      start_interval: 1s\n`, undefined, /has a start_period of 10s, under the deploy's 60s wait/],
    [`${OLD_STANZA}      start_interval: 1s\n`, 5, undefined],
    [TEMPLATE_STANZA, undefined, undefined],
  ];
  for (const dryRun of [false, true])
    for (const [stanza, retries, reason] of cases) {
      const tree: Tree = { repo: { apps: { web: { docker: { 'compose.yaml': COMPOSE + stanza } } } } };
      const { ctx, err } = harness(tree, host('ghcr.io/x/web:old'), { dryRun });
      const result = await deploy(ctx, {
        host: 'deploy@h',
        app: 'web',
        image: 'ghcr.io/x/web:new',
        dir: '/repo',
        retries,
      });
      assert.equal(result.healthy, true);
      const warnings = err()
        .split('\n')
        .filter((l) => l.startsWith('⚠'));
      if (!reason) {
        assert.deepEqual(warnings, [], stanza);
        continue;
      }
      assert.equal(warnings.length, 1, stanza);
      const warning = warnings.join('');
      assert.match(warning, /^⚠ apps\/web\/docker\/compose.yaml: the web healthcheck /);
      assert.match(warning, reason);
      assert.match(
        warning,
        /may probe it only every interval .* healthy late or rolls it back; set start_interval: 1s and start_period: 60s$/,
      );
      // Before the deploy: ahead of the first line that reaches the host.
      assert.ok(err().indexOf('⚠') < err().indexOf('previous:'));
    }
});

/** A compose variable the deploy does not interpolate, so the verb cannot read the duration. */
const VARIABLE = ['$', '{PERIOD:-60s}'].join('');

test('slowStart and seconds read compose durations; a value the verb cannot read is left to compose', () => {
  assert.equal(seconds('1m30s'), 90);
  assert.equal(seconds('1.5m'), 90);
  assert.equal(seconds('500ms'), 0.5);
  assert.equal(seconds('1h0m0s'), 3600);
  assert.equal(seconds('90'), undefined);
  assert.equal(seconds(VARIABLE), undefined);
  assert.equal(slowStart({ start_interval: '1s', start_period: '60s' }, 60), undefined);
  assert.equal(slowStart({ start_interval: '1s', start_period: VARIABLE }, 60), undefined);
  assert.equal(slowStart({ start_interval: '1s' }, 60), "has a start_period of 0s, under the deploy's 60s wait");
  assert.equal(slowStart({ start_period: '2m' }, 60), 'sets no start_interval');
});

test('no compose file under the source is a usage error before anything reaches the host', async () => {
  const { ctx, commands } = harness({ repo: { apps: {} } }, host(undefined));
  await assert.rejects(deploy(ctx, { host: 'deploy@h', app: 'web', image: 'i', dir: '/repo' }), UsageError);
  assert.deepEqual(commands, []);
});

test('a dry run reaches no host and prints every ssh line of the happy path, placeholders for what the host would say', async () => {
  const { ctx, commands, err } = harness(checkout, host('x'), { dryRun: true });
  const result = await deploy(ctx, {
    host: 'deploy@h',

    app: 'web',
    image: 'ghcr.io/x/web:new',
    dir: '/repo',
  });
  assert.deepEqual(commands, []);
  const lines = err();
  assert.match(lines, /previous: <read on host>/);
  assert.match(
    lines,
    /\[dry-run\] \$ ssh -o ControlMaster=auto -o ControlPath=\S+ -o ControlPersist=60 -o StrictHostKeyChecking=accept-new deploy@h -- 'cd '\\''\/opt\/stacks\/web'\\'' && docker compose up -d --remove-orphans'/,
  );
  assert.match(lines, /\(if compose.yaml declares a migrate service:\)/);
  assert.match(lines, /health: {2}the healthcheck of service web, as Docker reports it/);
  assert.match(
    lines,
    /\[dry-run\] \$ ssh deploy@h -- 'cd .* && for _ in \$\(seq 1 30\); do .*\.State\.Health\.Status.* = healthy \]/,
  );
  assert.match(lines, /on failure: restore the previous compose.yaml/);
  assert.match(lines, /\[dry-run\] \$ ssh -o ControlPath=\S+ -O exit deploy@h/);
  assert.equal(result.healthy, true);
  assert.equal(result.live, 'ghcr.io/x/web:new');
});

test('the same image from the same file, healthy: nothing pulled, nothing restarted', async () => {
  const h = host('ghcr.io/x/web:same');
  const { ctx, commands, err } = harness(checkout, h);
  const result = await deploy(ctx, {
    host: 'deploy@h',

    app: 'web',
    image: 'ghcr.io/x/web:same',
    dir: '/repo',
  });
  assert.ok(commands.some((c) => c.includes(`cmp -s compose.yaml .incoming/compose.yaml`)));
  assert.ok(commands.some((c) => c.includes('seq 1 1') && c.includes('.State.Health.Status')));
  assert.ok(!commands.some((c) => c.endsWith(' pull')));
  assert.ok(!commands.some((c) => c.endsWith('up -d --remove-orphans')));
  assert.ok(!commands.some((c) => c.includes('mv .incoming')));
  assert.equal(commands.at(-1), `rm -rf ${D}/.incoming`);
  assert.deepEqual(result, {
    host: 'deploy@h',
    appDir: '/opt/stacks/web',
    compose: 'apps/web/docker/compose.yaml',
    image: 'ghcr.io/x/web:same',
    previous: 'ghcr.io/x/web:same',
    live: 'ghcr.io/x/web:same',
    healthy: true,
    rolledBack: false,
    unchanged: true,
  });
  assert.match(err(), /✓ ghcr.io\/x\/web:same is already live and healthy; nothing to do/);
});

test('the same image from a changed file, or unhealthy, deploys in full', async () => {
  const h = host('ghcr.io/x/web:same');
  const base = h.answer.bind(h);
  h.answer = (c, i) => (c.includes('cmp -s compose.yaml .incoming/compose.yaml') ? undefined : base(c, i));
  const { ctx, commands } = harness(checkout, h);
  const result = await deploy(ctx, {
    host: 'deploy@h',

    app: 'web',
    image: 'ghcr.io/x/web:same',
    dir: '/repo',
  });
  assert.ok(commands.some((c) => c.endsWith(' pull')));
  assert.ok(commands.some((c) => c.endsWith('up -d --remove-orphans')));
  assert.equal(result.healthy, true);
  assert.equal(result.unchanged, undefined);
});

test('a new ref naming the image the host runs, from the same run shape: nothing pulled, nothing restarted', async () => {
  const serving = `services:\n  web:\n    image: ghcr.io/x/web:old\n${HEALTHCHECK}`;
  const h = host('ghcr.io/x/web:old', { sameImage: true, serving });
  const { ctx, commands, err } = harness(checkout, h);
  const result = await deploy(ctx, { host: 'deploy@h', app: 'web', image: 'ghcr.io/x/web:new', dir: '/repo' });
  assert.ok(
    commands.some(
      (c) =>
        c.includes("docker pull -q 'ghcr.io/x/web:new'") &&
        c.includes("docker image inspect --format '{{.Id}}' 'ghcr.io/x/web:new'") &&
        c.includes("docker inspect --format '{{.Image}}'"),
    ),
  );
  assert.ok(!commands.some((c) => c.endsWith(' pull')));
  assert.ok(!commands.some((c) => c.endsWith('up -d --remove-orphans')));
  assert.ok(!commands.some((c) => c.includes('mv .incoming')));
  assert.equal(result.unchanged, true);
  assert.equal(result.live, 'ghcr.io/x/web:old');
  assert.match(
    err(),
    /✓ ghcr.io\/x\/web:old \(the image ghcr.io\/x\/web:new names\) is already live and healthy; nothing to do/,
  );
});

test('a new ref naming the image the host runs, from a changed run shape, or naming another image, deploys in full', async () => {
  const changed = harness(checkout, host('ghcr.io/x/web:old', { sameImage: true, serving: 'services: {}\n' }));
  const full = await deploy(changed.ctx, { host: 'deploy@h', app: 'web', image: 'ghcr.io/x/web:new', dir: '/repo' });
  assert.equal(full.unchanged, undefined);
  assert.ok(changed.commands.some((c) => c.endsWith(' pull')));
  assert.equal(full.live, 'ghcr.io/x/web:new');

  const other = harness(checkout, host('ghcr.io/x/web:old'));
  const rebuilt = await deploy(other.ctx, { host: 'deploy@h', app: 'web', image: 'ghcr.io/x/web:new', dir: '/repo' });
  assert.equal(rebuilt.unchanged, undefined);
  assert.ok(!other.commands.some((c) => c.startsWith('cat ')));
  assert.ok(other.commands.some((c) => c.endsWith('up -d --remove-orphans')));
});

test('a third-party file the host already serves, running and healthy: nothing pulled, nothing restarted', async () => {
  const tree: Tree = { repo: { apps: { beszel: { 'compose.yaml': PINNED + HEALTHCHECK } } } };
  const same = harness(tree, host('ghcr.io/x/beszel:1.0'));
  const result = await deploy(same.ctx, { host: 'deploy@h', app: 'beszel', dir: '/repo' });
  assert.equal(result.unchanged, true);
  assert.equal(result.live, 'ghcr.io/x/beszel:1.0');
  assert.ok(!same.commands.some((c) => c.endsWith(' pull')));
  assert.ok(!same.commands.some((c) => c.endsWith('up -d --remove-orphans')));
  assert.match(same.err(), /✓ ghcr.io\/x\/beszel:1.0 is already live and healthy; nothing to do/);

  // A changed file (a new pin) deploys in full.
  const h = host('ghcr.io/x/beszel:0.9');
  const base = h.answer.bind(h);
  h.answer = (c, i) => (c.includes('cmp -s compose.yaml .incoming/compose.yaml') ? undefined : base(c, i));
  const changed = harness(tree, h);
  const full = await deploy(changed.ctx, { host: 'deploy@h', app: 'beszel', dir: '/repo' });
  assert.equal(full.unchanged, undefined);
  assert.ok(changed.commands.some((c) => c.endsWith(' pull')));
  assert.equal(full.live, 'ghcr.io/x/beszel:1.0');
});

test('the default app dir keys on the deployment slug: bare in production, suffixed elsewhere', () => {
  assert.equal(defaultAppDir('website'), '/opt/stacks/website');
  assert.equal(defaultAppDir('website', 'production'), '/opt/stacks/website');
  assert.equal(defaultAppDir('website', 'staging'), '/opt/stacks/website-staging');
});
