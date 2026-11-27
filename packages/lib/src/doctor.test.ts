import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Compose, type Mapping, parseCompose } from './compose.ts';
import { Context } from './context.ts';
import { type AppFacts, CHECKS, diagnose, examine, type Facts, type RepoFacts } from './doctor.ts';
import { REQUIREMENT_NAME } from './lints.ts';
import type { MarkerConfig } from './marker.ts';
import { unitsOf } from './model.ts';
import { overview } from './overview.ts';
import type { MarkerSite } from './sites.ts';
import { type FakeExec, fakeIo, link, type Tree, UNREADABLE } from './testing/fakeIo.ts';
import { UsageError } from './version.ts';

// --- the list of checks is the compendium's ------------------------------------

/** The requirement names the "`plx doctor` checks …" sentences of a text name. */
function namesChecked(text: string): string[] {
  const name = new RegExp(`\`(${REQUIREMENT_NAME})\``, 'g');
  return text
    .split('\n')
    .filter((line) => line.startsWith('`plx doctor` checks'))
    .flatMap((line) => [...line.matchAll(name)].map((m) => m[1] ?? ''));
}

test('the checks are exactly the requirements the contract pages say doctor checks', () => {
  // Hermetic by default: a verbatim copy of the sentences. PLX_COMPENDIUM=<checkout> reads the pages.
  const compendium = process.env.PLX_COMPENDIUM;
  const text = compendium
    ? ['contracts/repo.md', 'contracts/app.md'].map((p) => readFileSync(join(compendium, p), 'utf8')).join('\n')
    : readFileSync(new URL('./testing/doctor-checks.md', import.meta.url), 'utf8');
  assert.deepEqual(Object.keys(CHECKS), namesChecked(text));
});

// --- fixtures: a repo and its apps that pass every check -------------------------

const reasoned = (names: string[]) => names.map((n) => `- \`${n}\`: the reason.`).join('\n');

const repo = (over: Partial<RepoFacts> = {}): RepoFacts => ({
  kind: 'repo',
  path: 'r',
  marker: { declaration: { deviations: [], body: '' } },
  tasks: { names: ['dev', 'build', 'verify', 'lint', 'check', 'test', 'install'] },
  tracked: ['mise.toml', 'apps/a/docker/compose.yaml'],
  apps: ['apps/a'],
  ...over,
});

const IMAGE = '${PLEXUS_DEPLOYMENT_IMAGE:?rendered by the deploy verb}';
const tenant = { 'plexus.tenant': 't' };
const web = (over: Mapping = {}): Mapping => ({
  image: IMAGE,
  env_file: [
    { path: '.env', required: false },
    { path: '.env.secret', required: false },
  ],
  ports: ['127.0.0.1:${PLEXUS_LOOPBACK_PORT:?set}:3000'],
  labels: tenant,
  healthcheck: { test: ['CMD', 'true'] },
  ...over,
});
const STATELESS: Compose = { services: { web: web() } };
const STATEFUL: Compose = {
  services: {
    web: web(),
    migrate: { image: IMAGE, profiles: ['migrate'], command: 'migrate', labels: tenant },
    db: { image: 'postgres:18', labels: { ...tenant, 'plexus.backup': 'postgres' } },
  },
};

const app = (profile: string | undefined, over: Partial<AppFacts> = {}, deviations: string[] = []): AppFacts => ({
  kind: 'app',
  path: 'r/apps/a',
  repo: repo(),
  dir: 'apps/a',
  thirdParty: false,
  marker: { declaration: { ...(profile ? { profile } : {}), deviations, body: reasoned(deviations) } },
  compose: profile === 'stateful' ? STATEFUL : STATELESS,
  dockerfile: true,
  packageJson: { scripts: { seed: 'tsx seed.ts' } },
  ...over,
});

const findings = (unit: Facts) => diagnose([unit]).units[0]?.findings ?? [];
const named = (unit: Facts, name: string) => findings(unit).filter((f) => f.requirement === name);

test('a repo and an app of either profile that meet their contracts pass', () => {
  for (const unit of [repo(), app('stateless'), app('stateful')]) assert.deepEqual(findings(unit), [], unit.kind);
});

// --- one failing unit per check ---------------------------------------------------

const without = (services: Compose['services'], name: string) => ({
  services: Object.fromEntries(Object.entries(services).filter(([n]) => n !== name)),
});

/** For every check: a unit that fails it and nothing else, and what it says. */
const FAILING: Record<string, { unit: (deviations?: string[]) => Facts; problem: RegExp }> = {
  'PLX-Repo/Marker': {
    unit: () => repo({ marker: { problem: 'PLEXUS.md: no frontmatter: expected a `---` block at the top' } }),
    problem: /^PLEXUS\.md: no frontmatter/,
  },
  'PLX-Repo/Verbs': {
    unit: (deviations = []) =>
      repo({
        tasks: { names: ['dev', 'verify', 'lint', 'check', 'test'] },
        marker: { declaration: { deviations, body: reasoned(deviations) } },
      }),
    problem: /^no root mise task `build`$/,
  },
  'PLX-Repo/SubVerbs': {
    unit: (deviations = []) =>
      repo({
        tasks: { names: ['dev', 'build', 'verify', 'check', 'test'] },
        marker: { declaration: { deviations, body: reasoned(deviations) } },
      }),
    problem: /^no root mise task `lint`$/,
  },
  'PLX-App/Marker': {
    unit: (d) => app(undefined, {}, d),
    problem: /sets no `profile`/,
  },
  'PLX-App/Compose': {
    unit: (d) => app('stateless', { compose: undefined }, d),
    problem: /^no docker\/compose\.yaml$/,
  },
  'PLX-App/TenantLabel': {
    unit: (d) => app('stateless', { compose: { services: { web: web({ labels: {} }) } } }, d),
    problem: /^service `web` carries no `plexus.tenant` label$/,
  },
  'PLX-App/EnvFileLoad': {
    unit: (d) => app('stateless', { compose: { services: { web: web({ env_file: ['.env', '.env.secret'] }) } } }, d),
    problem: /^\.env\.secret is loaded, but not marked `required: false`$/,
  },
  'PLX-App/ImageRef': {
    unit: (d) => app('stateless', { compose: { services: { web: web({ image: 'ghcr.io/t/a:1' }) } } }, d),
    problem: /image is `ghcr.io\/t\/a:1`, not/,
  },
  'PLX-App/NoCommittedValues': {
    unit: (d) => app('stateless', { repo: repo({ tracked: ['apps/a/docker/.env.secret'] }) }, d),
    problem: /^the source repo tracks `apps\/a\/docker\/\.env\.secret`$/,
  },
  'PLX-App/SinglePort': {
    unit: (d) =>
      app(
        'stateless',
        {
          compose: {
            services: {
              web: web({
                ports: ['127.0.0.1:${PLEXUS_LOOPBACK_PORT:?set}:3000', '127.0.0.1:${PLEXUS_LOOPBACK_PORT:?set}:9229'],
              }),
            },
          },
        },
        d,
      ),
    problem: /publishes 2 ports, not one/,
  },
  'PLX-App/LoopbackPort': {
    unit: (d) => app('stateless', { compose: { services: { web: web({ ports: ['3000:3000'] }) } } }, d),
    problem: /publishes `3000:3000`, not 127\.0\.0\.1/,
  },
  'PLX-App/Healthcheck': {
    unit: (d) => app('stateless', { compose: { services: { web: web({ healthcheck: { test: ['NONE'] } }) } } }, d),
    problem: /declares no healthcheck with a test of its own/,
  },
  'PLX-App/Dockerfile': {
    unit: (d) => app('stateless', { dockerfile: false }, d),
    problem: /^no docker\/Dockerfile$/,
  },
  'PLX-App/Stateless/NoState': {
    unit: (d) => app('stateless', { compose: STATEFUL }, d),
    problem: /declares a `migrate` service|carries a `plexus.backup` label/,
  },
  'PLX-App/Stateful/MigrateService': {
    unit: (d) => app('stateful', { compose: without(STATEFUL.services, 'migrate') }, d),
    problem: /^declares no `migrate` service$/,
  },
  'PLX-App/Stateful/Seed': {
    unit: (d) => app('stateful', { packageJson: { scripts: { dev: 'next dev' } } }, d),
    problem: /^package\.json has no `seed` script$/,
  },
};

test('every check has a failing unit here', () => {
  assert.deepEqual(Object.keys(FAILING), Object.keys(CHECKS));
});

for (const [name, { unit, problem }] of Object.entries(FAILING)) {
  test(`${name}: a failing unit fails it and nothing else`, () => {
    const found = findings(unit());
    assert.ok(found.length > 0, 'a finding');
    for (const f of found) {
      assert.equal(f.requirement, name);
      assert.match(f.problem, problem);
    }
  });

  // A marker that cannot be read lists no deviation.
  if (name === 'PLX-Repo/Marker') continue;

  test(`${name}: a listed deviation with a reason silences it`, () => {
    const report = diagnose([unit([name])]).units[0];
    assert.deepEqual(report?.findings, []);
    assert.deepEqual(report?.deviations, [name]);
  });

  test(`${name}: a listed deviation without a reason fails`, () => {
    const u = unit([name]);
    if (u.marker?.declaration) u.marker.declaration.body = 'Prose that gives no reason.\n';
    assert.deepEqual(findings(u), [
      {
        requirement: name,
        problem: "listed under `deviations`, but no bullet of the marker's body names it with a reason",
      },
    ]);
  });
}

test('a deviation that names no requirement fails, whether a reason is given or not', () => {
  // Joined at run time: written out, plx requirements would read them as citations of nothing.
  const [noName, noModule] = [['PLX-App', 'Nope'].join('/'), ['PLX-Nope', 'X'].join('/')];
  for (const unit of [
    app('stateless', {}, [noName]),
    repo({ marker: { declaration: { deviations: [noModule], body: '' } } }),
  ])
    assert.deepEqual(findings(unit), [
      {
        requirement: unit.marker?.declaration?.deviations[0] ?? '',
        problem: 'listed under `deviations`, but no requirement has this name',
      },
    ]);
  assert.deepEqual(
    findings(app('stateless', {}, ['PLX-App/Stateful/MigrateIdempotent'])),
    [],
    'a requirement without a check',
  );
});

// --- what follows from the unit ------------------------------------------------------

test('a third-party app is not held to the image ref and the Dockerfile; a built one is', () => {
  const pinned = {
    compose: { services: { web: web({ image: 'ghcr.io/pocket-id/pocket-id:v2' }) } },
    dockerfile: false,
  };
  assert.deepEqual(findings(app('stateless', { ...pinned, thirdParty: true })), []);
  assert.deepEqual(
    findings(app('stateless', pinned)).map((f) => f.requirement),
    ['PLX-App/ImageRef', 'PLX-App/Dockerfile'],
  );
});

test("each profile's checks bind only its own apps", () => {
  assert.deepEqual(findings(app('stateful')), [], 'a stateful app may migrate and back up');
  assert.deepEqual(findings(app('stateless', { packageJson: {} })), [], 'a stateless app needs no seed');
  assert.deepEqual(
    findings(app('stateful', { compose: STATELESS, packageJson: {} })).map((f) => f.requirement),
    ['PLX-App/Stateful/MigrateService', 'PLX-App/Stateful/Seed'],
  );
  const unknown = findings(app('stateful-app', { compose: STATEFUL }));
  assert.deepEqual(
    unknown.map((f) => f.problem),
    ['`profile` is `stateful-app`, not stateless or stateful'],
    'no profile check runs while the profile is unknown',
  );
});

test('a repo check never binds an app, nor an app check a repo', () => {
  assert.deepEqual(findings(app('stateless', { repo: repo({ tasks: { names: [] } }) })), []);
  assert.deepEqual(findings(repo({ kind: 'operations' })), []);
});

test('the compose checks wait for the file and the app service, which PLX-App/Compose reports', () => {
  const broken = app('stateless', { compose: undefined, composeProblem: 'docker/compose.yaml: not valid YAML: x' });
  assert.deepEqual(findings(broken), [
    { requirement: 'PLX-App/Compose', problem: 'docker/compose.yaml: not valid YAML: x' },
  ]);
  const noWeb = app('stateless', { compose: { services: { api: { labels: tenant } } } });
  assert.deepEqual(
    findings(noWeb).map((f) => f.requirement),
    ['PLX-App/Compose'],
  );
});

test('mise could not list the tasks: PLX-Repo/Verbs says why, once', () => {
  assert.deepEqual(findings(repo({ tasks: { problem: 'Config files in /r/mise.toml are not trusted.' } })), [
    {
      requirement: 'PLX-Repo/Verbs',
      problem: 'mise could not list the tasks: Config files in /r/mise.toml are not trusted.',
    },
  ]);
});

// --- compose's spellings -----------------------------------------------------------

const appOf = (text: string, profile = 'stateless') => app(profile, { compose: parseCompose(text, 'c') });

test('the compose checks read either spelling compose accepts', () => {
  const longForm = `services:
  web:
    image: \${PLEXUS_DEPLOYMENT_IMAGE}
    env_file: [{ path: ./.env }, { path: .env.secret, required: "false" }]
    ports:
      - { target: 3000, host_ip: 127.0.0.1, published: "\${PLEXUS_LOOPBACK_PORT:?set}" }
    labels: [plexus.tenant=t]
    healthcheck: { test: curl -f localhost:3000 }
`;
  assert.deepEqual(findings(appOf(longForm)), []);
});

test('PLX-App/LoopbackPort: a data service publishes only on 127.0.0.1 and fixes no host port, the app service only the loopback binding', () => {
  const text = `services:
  web:
    image: \${PLEXUS_DEPLOYMENT_IMAGE}
    env_file: [{ path: .env, required: false }, { path: .env.secret, required: false }]
    ports: ["127.0.0.1:\${PLEXUS_LOOPBACK_PORT:-3000}:3000"]
    labels: { plexus.tenant: t }
    healthcheck: { test: [CMD, "true"] }
  cache:
    image: valkey
    labels: { plexus.tenant: t }
    ports:
      - "127.0.0.1:6379:6379"
      - "6380"
      - "127.0.0.1::6381"
      - "0.0.0.0::6382"
      - "\${PLEXUS_LOOPBACK_PORT}:6383"
      - "127.0.0.1:\${PLEXUS_LOOPBACK_PORT?set}:6384"
      - { target: 6385 }
      - { target: 6386, host_ip: 127.0.0.1 }
`;
  assert.deepEqual(
    named(appOf(text), 'PLX-App/LoopbackPort').map((f) => f.problem),
    [
      'the web service publishes `127.0.0.1:${PLEXUS_LOOPBACK_PORT:-3000}:3000`, not 127.0.0.1:${PLEXUS_LOOPBACK_PORT:?<message>}:<container-port>',
      'service `cache` fixes host port `6379` (`127.0.0.1:6379:6379`)',
      'service `cache` publishes `6380` beyond 127.0.0.1',
      'service `cache` publishes `0.0.0.0::6382` beyond 127.0.0.1',
      'service `cache` publishes `${PLEXUS_LOOPBACK_PORT}:6383` beyond 127.0.0.1',
      'service `cache` publishes `{"target":6385}` beyond 127.0.0.1',
    ],
  );
});

test("PLX-App/LoopbackPort: no service runs in the host's network; another container's is fine", () => {
  const text = `services:
  web:
    image: \${PLEXUS_DEPLOYMENT_IMAGE}
    env_file: [{ path: .env, required: false }, { path: .env.secret, required: false }]
    ports: ["127.0.0.1:\${PLEXUS_LOOPBACK_PORT:?set}:3000"]
    network_mode: host
    labels: { plexus.tenant: t }
    healthcheck: { test: [CMD, "true"] }
  agent:
    image: agent
    labels: { plexus.tenant: t }
    network_mode: host
  sidecar:
    image: sidecar
    labels: { plexus.tenant: t }
    network_mode: service:web
`;
  assert.deepEqual(
    named(appOf(text), 'PLX-App/LoopbackPort').map((f) => f.problem),
    [
      "service `web` runs in the host's network (`network_mode: host`), reachable beyond loopback",
      "service `agent` runs in the host's network (`network_mode: host`), reachable beyond loopback",
    ],
  );
});

test('PLX-App/LoopbackPort takes only the :? spelling of the variable, over TCP; without it an unset port is random, a default fixes one', () => {
  const ported = (ports: unknown[]) =>
    named(app('stateless', { compose: { services: { web: web({ ports }) } } }), 'PLX-App/LoopbackPort').length;
  for (const spec of [
    '127.0.0.1:${PLEXUS_LOOPBACK_PORT:?set}:3000',
    '127.0.0.1:${PLEXUS_LOOPBACK_PORT:?set by the platform playbook}:3000',
    '127.0.0.1:${PLEXUS_LOOPBACK_PORT:?}:3000',
    '127.0.0.1:${PLEXUS_LOOPBACK_PORT:?set}:3000/tcp',
  ])
    assert.equal(ported([spec]), 0, spec);
  assert.equal(ported([{ target: 3000, host_ip: '127.0.0.1', published: '${PLEXUS_LOOPBACK_PORT:?x}' }]), 0);
  for (const spec of [
    '127.0.0.1:${PLEXUS_LOOPBACK_PORT}:3000',
    '127.0.0.1:$PLEXUS_LOOPBACK_PORT:3000',
    '127.0.0.1:${PLEXUS_LOOPBACK_PORT?set}:3000',
    '127.0.0.1:${PLEXUS_LOOPBACK_PORT:-3000}:3000',
    '127.0.0.1:${PLEXUS_LOOPBACK_PORT:?set}:3000/udp',
    '127.0.0.1:${PLEXUS_LOOPBACK_PORTX:?set}:3000',
  ])
    assert.equal(ported([spec]), 1, spec);
  for (const published of ['${PLEXUS_LOOPBACK_PORT}', '$PLEXUS_LOOPBACK_PORT'])
    assert.equal(ported([{ target: 3000, host_ip: '127.0.0.1', published }]), 1, published);
  assert.equal(
    ported([{ target: 3000, host_ip: '127.0.0.1', published: '${PLEXUS_LOOPBACK_PORT:?set}', protocol: 'udp' }]),
    1,
  );
});

test('PLX-App/Stateful/MigrateService: the image placeholder in another spelling is the same image', () => {
  const services = {
    ...STATEFUL.services,
    migrate: { ...STATEFUL.services.migrate, image: '${PLEXUS_DEPLOYMENT_IMAGE}' },
  };
  assert.deepEqual(named(app('stateful', { compose: { services } }), 'PLX-App/Stateful/MigrateService'), []);
});

test('a service that extends another of the same file is judged merged with it', () => {
  const based = parseCompose(
    `services:
  base:
    image: \${PLEXUS_DEPLOYMENT_IMAGE:?rendered by the deploy verb}
    env_file: [{ path: .env, required: false }]
    labels: [plexus.tenant=t]
  web:
    extends: base
    env_file: [{ path: .env.secret, required: false }]
    ports: ["127.0.0.1:\${PLEXUS_LOOPBACK_PORT:?set}:3000"]
    labels: { team: x }
    healthcheck: { test: [CMD, "true"] }
`,
    'c',
  );
  assert.deepEqual(based.services.web?.labels, { 'plexus.tenant': 't', team: 'x' }, 'labels merged across spellings');
  assert.equal((based.services.web?.env_file as unknown[] | undefined)?.length, 2, 'env files concatenated');
  assert.deepEqual(findings(app('stateless', { compose: { services: { web: based.services.web ?? {} } } })), []);

  const migrating = parseCompose(
    `services:
  web: { image: "\${PLEXUS_DEPLOYMENT_IMAGE}", labels: { plexus.tenant: t }, command: serve }
  migrate:
    extends: { service: web }
    profiles: [migrate]
    command: migrate
`,
    'c',
  );
  assert.deepEqual(migrating.services.migrate, {
    image: '${PLEXUS_DEPLOYMENT_IMAGE}',
    labels: { 'plexus.tenant': 't' },
    command: 'migrate',
    profiles: ['migrate'],
  });
});

// The next two cases are the ones compared with `docker compose config --no-interpolate` (see the report).
test('a chain of extends within the file is merged all the way, as compose merges it', () => {
  const compose = parseCompose(
    `services:
  base:
    image: base
    labels: { a: "1" }
    ports: ["127.0.0.1:\${PLEXUS_LOOPBACK_PORT:?set}:3000"]
    healthcheck: { test: [CMD, "true"], interval: 5s }
  middle:
    extends: base
    labels: { b: "2" }
    env_file: [.env]
  web:
    extends: { service: middle }
    labels: { c: "3" }
    environment: { X: "1" }
`,
    'c',
  );
  assert.deepEqual(compose.services.web, {
    image: 'base',
    labels: { a: '1', b: '2', c: '3' },
    ports: ['127.0.0.1:${PLEXUS_LOOPBACK_PORT:?set}:3000'],
    healthcheck: { test: ['CMD', 'true'], interval: '5s' },
    env_file: ['.env'],
    environment: { X: '1' },
  });
  // A chain that reaches a service of another file stops there; that service is read as written.
  const stopped = parseCompose(
    'services:\n  a: { extends: { file: other.yaml, service: x }, image: a }\n  b: { extends: a, labels: [k=v] }\n',
    'c',
  );
  assert.deepEqual(stopped.services.b, { image: 'a', labels: ['k=v'] });
});

test('lists both sides of an extends give are concatenated without duplicates, as compose does', () => {
  const compose = parseCompose(
    `services:
  base:
    image: base
    ports: ["127.0.0.1:\${PLEXUS_LOOPBACK_PORT:?set}:3000", "9000:9000"]
    expose: ["3000"]
    dns: [1.1.1.1]
    env_file: [.env, { path: .env.secret, required: false }]
    volumes: [data:/data]
  web:
    extends: base
    ports: ["127.0.0.1:\${PLEXUS_LOOPBACK_PORT:?set}:3000"]
    expose: ["3000", "4000"]
    dns: [1.1.1.1, 8.8.8.8]
    env_file: [.env, { path: .env.secret, required: false }]
    volumes: [data:/data, other:/other]
`,
    'c',
  );
  const web = compose.services.web ?? {};
  assert.deepEqual(web.ports, ['127.0.0.1:${PLEXUS_LOOPBACK_PORT:?set}:3000', '9000:9000']);
  assert.deepEqual(web.expose, ['3000', '4000']);
  assert.deepEqual(web.dns, ['1.1.1.1', '8.8.8.8']);
  assert.deepEqual(web.env_file, ['.env', { path: '.env.secret', required: false }]);
  assert.deepEqual(web.volumes, ['data:/data', 'other:/other']);
  // A port spelled as a number and as a string is one port, to compose as here.
  const spelled = parseCompose('services:\n  a: { ports: ["3000"] }\n  web: { extends: a, ports: [3000] }\n', 'c');
  assert.deepEqual(spelled.services.web?.ports, ['3000']);
});

test('services that extend each other in a cycle are an error naming them', () => {
  assert.throws(
    () =>
      parseCompose(
        'services:\n  a: { extends: b, image: x }\n  b: { extends: c }\n  c: { extends: a }\n  web: { image: y }\n',
        'docker/compose.yaml',
      ),
    (e: Error) => {
      assert.ok(e instanceof UsageError);
      assert.equal(e.message, 'docker/compose.yaml: services extend each other in a cycle: a → b → c → a');
      return true;
    },
  );
  assert.throws(() => parseCompose('services:\n  web: { extends: web }\n', 'c'), /cycle: web → web$/);
});

test('an extends naming another file is not followed; the service is read as written', () => {
  const compose = parseCompose(
    'services:\n  web:\n    extends: { file: base.yaml, service: web }\n    image: x\n',
    'c',
  );
  assert.deepEqual(compose.services.web, { extends: { file: 'base.yaml', service: 'web' }, image: 'x' });
});

test('a compose file that uses include passes PLX-App/Compose, gets a hint, and is judged on what it declares itself', () => {
  const text = `include: [db.yaml]
services:
  web:
    image: nginx
`;
  const report = diagnose([appOf(text)]).units[0];
  assert.ok(report);
  assert.deepEqual(named(appOf(text), 'PLX-App/Compose'), [], 'the file exists and declares the app service');
  assert.deepEqual(report.hints, [
    'docker/compose.yaml uses `include`: the compose checks read what the file itself declares, not the files it includes',
  ]);
  // The other compose checks run on the file's own services.
  assert.deepEqual(
    [...new Set(report.findings.map((f) => f.requirement))],
    [
      'PLX-App/TenantLabel',
      'PLX-App/EnvFileLoad',
      'PLX-App/ImageRef',
      'PLX-App/SinglePort',
      'PLX-App/LoopbackPort',
      'PLX-App/Healthcheck',
    ],
  );
  // Without the app service in the file itself, PLX-App/Compose says the included files were not read.
  assert.deepEqual(named(appOf('include: [web.yaml]\n'), 'PLX-App/Compose'), [
    {
      requirement: 'PLX-App/Compose',
      problem:
        'docker/compose.yaml declares no `web` service itself (the files it includes are not read), the app service the deploy verb reads',
    },
  ]);
});

test('PLX-App/ImageRef takes the bare form and the :? form, nothing else', () => {
  const imaged = (image: string) => app('stateless', { compose: { services: { web: web({ image }) } } });
  assert.deepEqual(named(imaged('${PLEXUS_DEPLOYMENT_IMAGE}'), 'PLX-App/ImageRef'), []);
  assert.deepEqual(named(imaged('${PLEXUS_DEPLOYMENT_IMAGE:?unrendered}'), 'PLX-App/ImageRef'), []);
  assert.equal(named(imaged('${PLEXUS_DEPLOYMENT_IMAGE:-nginx}'), 'PLX-App/ImageRef').length, 1);
});

test('PLX-App/Stateful/MigrateService: under its profile, on the app service image', () => {
  const migrate = (m: Mapping) =>
    named(
      app('stateful', { compose: { services: { ...STATEFUL.services, migrate: m } } }),
      'PLX-App/Stateful/MigrateService',
    ).map((f) => f.problem);
  assert.deepEqual(migrate({ image: IMAGE, labels: tenant }), [
    'the `migrate` service is not under `profiles: ["migrate"]`, so a plain `up` starts it',
  ]);
  assert.deepEqual(migrate({ image: 'node:24', profiles: ['migrate'], labels: tenant }), [
    `the \`migrate\` service runs \`node:24\`, not the app's own image \`${IMAGE}\``,
  ]);
});

test('PLX-App/Stateful/Seed: an app without a package.json has no finding', () => {
  assert.deepEqual(findings(app('stateful', { packageJson: undefined })), []);
  assert.deepEqual(
    findings(app('stateful', { packageJson: undefined, packageJsonProblem: 'package.json is not JSON' })).map(
      (f) => f.problem,
    ),
    ['package.json is not JSON'],
  );
});

// --- the reads ---------------------------------------------------------------------------

const MARKER = '---\n---\n\n- A repo.\n';
const COMPOSE = `services:
  web:
    image: \${PLEXUS_DEPLOYMENT_IMAGE:?rendered by the deploy verb}
    env_file: [{ path: .env, required: false }, { path: .env.secret, required: false }]
    ports: ["127.0.0.1:\${PLEXUS_LOOPBACK_PORT:?set}:3000"]
    labels: { plexus.tenant: t }
    healthcheck: { test: [CMD, "true"] }
`;
const OPS_ANSWERS = '_commit: 0.1.0\n_src_path: gh:plexus-ms/template-repo-operations\n';

/** `mise tasks ls --json --hidden` in a repo: its own tasks, a parent's, a sub-project's. */
const miseTasks =
  (own: Record<string, string[]>) =>
  (cwd: string): string | undefined => {
    const names = own[cwd];
    if (!names) return undefined;
    return JSON.stringify([
      ...names.map((n) => ({ name: `//:${n}`, source: `${cwd}/mise.toml`, global: false })),
      { name: 'pull', source: '/ws/mise.toml', global: false },
      { name: 'fmt', source: '/home/.config/mise/config.toml', global: true },
    ]);
  };

const ws = (): Tree => ({
  'mise.toml': '',
  web: {
    '.git': {},
    'PLEXUS.md': MARKER,
    'mise.toml': '',
    apps: {
      site: {
        'PLEXUS.md': '---\nprofile: stateless\n---\n',
        docker: { 'compose.yaml': COMPOSE, Dockerfile: 'FROM node' },
        'package.json': '{"scripts":{}}',
      },
      kept: { '.gitkeep': '' },
    },
  },
  ops: {
    '.git': {},
    'PLEXUS.md':
      '---\ndeviations: [PLX-Repo/SubVerbs]\n---\n\n- `PLX-Repo/SubVerbs`: the playbooks are checked by `check`.\n',
    '.copier-answers.yml': OPS_ANSWERS,
    apps: {
      id: {
        'PLEXUS.md': '---\nprofile: stateful\n---\n',
        docker: {
          'compose.yaml': COMPOSE.replace('${PLEXUS_DEPLOYMENT_IMAGE:?rendered by the deploy verb}', 'ghcr.io/x/id:2'),
        },
      },
    },
  },
});

const VERBS = ['dev', 'build', 'verify', 'lint', 'check', 'test'];

async function doctorOver(
  tree: Tree,
  root: string,
  webTasks: string[] = VERBS,
  tracked: Record<string, string[]> = {},
  around: Tree = {},
) {
  const files: Record<string, string[]> = { '/ws/web': ['PLEXUS.md', 'apps/site/docker/compose.yaml'], ...tracked };
  const git = (cwd: string, args: string[]) =>
    args[0] === 'ls-files' && files[cwd] ? files[cwd].map((f) => `${f}\0`).join('') : undefined;
  const mise = miseTasks({ '/ws/web': webTasks, '/ws/ops': ['dev', 'build', 'verify', 'check', 'test'] });
  const ctx = new Context({}, fakeIo({ ...around, ws: tree }, git, { mise: (cwd) => mise(cwd) }));
  const { facts, ...examined } = await examine(ctx, root);
  return { ...examined, ...diagnose(facts) };
}

const requirements = (report: Awaited<ReturnType<typeof doctorOver>>) =>
  report.units.map((u) => [u.path, u.kind, u.findings.map((f) => f.requirement)]);

test('doctor in a repo fails on a missing build task and passes once it exists', async () => {
  const verbs = ['dev', 'verify', 'lint', 'check', 'test'];
  const before = await doctorOver(ws(), '/ws/web', verbs);
  assert.deepEqual(
    before.units.map((u) => [u.path, u.kind, u.findings]),
    [
      ['.', 'repo', [{ requirement: 'PLX-Repo/Verbs', problem: 'no root mise task `build`' }]],
      ['apps/site', 'app', []],
    ],
  );
  const after = await doctorOver(ws(), '/ws/web', [...verbs, 'build']);
  assert.equal(after.failed, 0);
});

test('doctor over a workspace checks every Plexus repo beneath, apps by their repo', async () => {
  const report = await doctorOver(ws(), '/ws');
  assert.deepEqual(
    report.units.map((u) => [u.path, u.kind, u.profile, u.deviations, u.findings]),
    [
      ['ops', 'operations', undefined, ['PLX-Repo/SubVerbs'], []],
      [
        'ops/apps/id',
        'app',
        'stateful',
        [],
        [{ requirement: 'PLX-App/Stateful/MigrateService', problem: 'declares no `migrate` service' }],
      ],
      ['web', 'repo', undefined, [], []],
      ['web/apps/site', 'app', 'stateless', [], []],
    ],
  );
});

test('a repo without a marker, run in, fails PLX-Repo/Marker and still has its apps checked', async () => {
  const tree = ws();
  delete (tree.web as Tree)['PLEXUS.md'];
  const report = await doctorOver(tree, '/ws/web');
  assert.deepEqual(
    report.units.map((u) => [u.path, u.findings.map((f) => f.requirement)]),
    [
      ['.', ['PLX-Repo/Marker']],
      ['apps/site', []],
    ],
  );
});

// --- what a unit is: git roots, not markers ---------------------------------------------

const webOf = (tree: Tree) => tree.web as Tree;

test('(a) a checkout nested in a repo is not part of it: run on the repo, doctor reads neither it nor its apps', async () => {
  const tree = ws();
  webOf(tree)['.claude'] = {
    worktrees: {
      x: {
        '.git': 'gitdir: /ws/web/.git/worktrees/x\n',
        'PLEXUS.md': MARKER,
        apps: { other: { 'PLEXUS.md': '---\nprofile: stateless\n---\n' } },
      },
    },
  };
  assert.deepEqual(requirements(await doctorOver(tree, '/ws/web')), [
    ['.', 'repo', []],
    ['apps/site', 'app', []],
  ]);
  // From inside it, the nested checkout is the repo; a linked worktree's `.git` is a file.
  const inside = await doctorOver(tree, '/ws/web/.claude/worktrees/x/apps/other');
  assert.equal(inside.root, '/ws/web/.claude/worktrees/x');
  assert.deepEqual(
    inside.units.map((u) => u.path),
    ['.', 'apps/other'],
  );
});

test('(b) in a workspace, a repo without a marker is still the repo, its apps still apps', async () => {
  const tree = ws();
  delete webOf(tree)['PLEXUS.md'];
  const report = await doctorOver(tree, '/ws');
  assert.deepEqual(
    requirements(report).filter(([path]) => String(path).startsWith('web')),
    [
      ['web', 'repo', ['PLX-Repo/Marker']],
      ['web/apps/site', 'app', []],
    ],
  );
});

test('(c) an app directory without a marker fails PLX-App/Marker; one holding only dotfiles is no app', async () => {
  const tree = ws();
  const apps = webOf(tree).apps as Tree;
  apps.shop = { docker: { 'compose.yaml': COMPOSE, Dockerfile: 'FROM node' }, 'package.json': '{}' };
  const report = await doctorOver(tree, '/ws/web');
  assert.deepEqual(
    report.units.map((u) => u.path),
    ['.', 'apps/shop', 'apps/site'],
    'apps/kept holds only .gitkeep',
  );
  assert.deepEqual(report.units[1]?.findings, [{ requirement: 'PLX-App/Marker', problem: 'no PLEXUS.md' }]);
});

test('(d) run from inside an app, doctor checks the repo the app is in, from its root', async () => {
  const report = await doctorOver(ws(), '/ws/web/apps/site');
  assert.equal(report.root, '/ws/web');
  assert.equal(report.inRepo, true);
  assert.deepEqual(requirements(report), [
    ['.', 'repo', []],
    ['apps/site', 'app', []],
  ]);
});

test('a workspace scan names the git roots it did not check because they are not Plexus repos', async () => {
  const tree = ws();
  tree.compendium = { '.git': {}, 'README.md': 'prose' };
  tree.empty = { '.git': {}, apps: { kept: { '.gitkeep': '' } } };
  tree.loose = { 'PLEXUS.md': MARKER };
  const report = await doctorOver(tree, '/ws');
  assert.deepEqual(report.skipped, ['compendium', 'empty']);
  assert.equal(report.inRepo, false);
  assert.ok(!report.units.some((u) => u.path === 'loose'), 'a marker outside any git root is no unit');
});

test('(e) git roots beneath make a workspace, whatever lies above; with none beneath, the nearest git root above is the repo', async () => {
  // A git repo at the top, as a home directory under version control (dotfiles) is.
  const around: Tree = { '.git': {} };
  const tree = ws();
  tree.notes = { 'todo.md': '- write it down\n' };
  const workspace = await doctorOver(tree, '/ws', VERBS, {}, around);
  assert.equal(workspace.inRepo, false);
  assert.equal(workspace.root, '/ws');
  assert.deepEqual(
    workspace.units.map((u) => u.path),
    ['ops', 'ops/apps/id', 'web', 'web/apps/site'],
  );
  const inside = await doctorOver(tree, '/ws/notes', VERBS, {}, around);
  assert.equal(inside.inRepo, true, 'nothing beneath: the directory is part of the repo above');
  assert.equal(inside.root, '/');
});

/** The apps overview and doctor each find, as paths under the workspace. */
async function appsBoth(tree: Tree): Promise<{ overview: string[]; doctor: string[] }> {
  const ctx = new Context(
    {},
    fakeIo({ ws: tree }, () => '', { mise: () => '[]' }),
  );
  const units = unitsOf(await overview(ctx, '/ws', { git: false }));
  return {
    overview: units.filter((u) => u.kind === 'app').map((u) => u.dir.path.replace('/ws/', '')),
    doctor: (await examine(ctx, '/ws')).facts.filter((f) => f.kind === 'app').map((f) => f.path),
  };
}

test('(f) overview and doctor find the same apps: one named like a pruned directory, one without a marker or other facet', async () => {
  const tree = ws();
  const apps = webOf(tree).apps as Tree;
  apps.build = { 'PLEXUS.md': '---\nprofile: stateless\n---\n' };
  apps.plain = { 'README.md': 'an app without a marker\n' };
  const found = await appsBoth(tree);
  assert.deepEqual(found.doctor, ['ops/apps/id', 'web/apps/build', 'web/apps/plain', 'web/apps/site']);
  assert.deepEqual(found.overview, found.doctor);
});

test('(g) a directory that cannot be read is named with why, in both verbs, and does not abort either', async () => {
  const tree = ws();
  tree.locked = UNREADABLE;
  (webOf(tree).apps as Tree).secret = UNREADABLE;
  const workspace = await doctorOver(tree, '/ws');
  assert.deepEqual(workspace.unreadable, [
    { path: 'locked', why: 'EACCES' },
    { path: 'web/apps/secret', why: 'EACCES' },
  ]);
  assert.deepEqual(
    workspace.units.map((u) => u.path),
    ['ops', 'ops/apps/id', 'web', 'web/apps/site'],
  );
  const repo = await doctorOver(tree, '/ws/web');
  assert.deepEqual(repo.unreadable, [{ path: 'apps/secret', why: 'EACCES' }]);
  const ctx = new Context({}, fakeIo({ ws: tree }));
  const map = await overview(ctx, '/ws', { git: false });
  assert.equal(map.children.find((c) => c.name === 'locked')?.unreadable, 'EACCES');
  const unreadableRoot = await overview(new Context({}, fakeIo({ ws: UNREADABLE })), '/ws', { git: false });
  assert.equal(unreadableRoot.unreadable, 'EACCES');
});

test('(h) a symlinked directory in apps/ and a symlinked repo are not followed, and are named as not checked', async () => {
  const around: Tree = {
    elsewhere: {
      repo: { '.git': {}, 'PLEXUS.md': MARKER },
      app: { 'PLEXUS.md': '---\nprofile: stateless\n---\n' },
      plain: { 'notes.md': 'x' },
      'file.txt': 'x',
    },
  };
  const tree = ws();
  tree.mirror = link('/elsewhere/repo');
  tree.docs = link('/elsewhere/plain');
  const apps = webOf(tree).apps as Tree;
  apps.shared = link('/elsewhere/app');
  apps['notes.txt'] = link('/elsewhere/file.txt');
  const workspace = await doctorOver(tree, '/ws', VERBS, {}, around);
  assert.deepEqual(workspace.links, ['mirror', 'web/apps/shared'], 'a link to a plain directory or a file is no unit');
  assert.ok(!workspace.units.some((u) => u.path.startsWith('mirror') || u.path === 'web/apps/shared'));
  const repo = await doctorOver(tree, '/ws/web', VERBS, {}, around);
  assert.deepEqual(repo.links, ['apps/shared']);
});

test('a marker that still carries plexus or modules gets a hint, not a finding', () => {
  const report = diagnose([
    repo({ marker: { declaration: { deviations: [], body: '', obsolete: ['plexus', 'modules'] } } }),
    app('stateless', {
      marker: { declaration: { profile: 'stateless', deviations: [], body: '', obsolete: ['modules'] } },
    }),
  ]);
  assert.equal(report.failed, 0);
  assert.deepEqual(
    report.units.map((u) => u.hints),
    [
      ["the marker's `plexus` and `modules` are no longer read and can go"],
      ["the marker's `modules` is no longer read and can go"],
    ],
  );
});

// --- mise's task list ------------------------------------------------------------------

/** doctor in /ws/web, with `mise tasks ls` answered by `mise`. */
async function withMise(mise: FakeExec) {
  const git = (cwd: string, args: string[]) => (args[0] === 'ls-files' && cwd === '/ws/web' ? '' : undefined);
  const ctx = new Context({}, fakeIo({ ws: ws() }, git, { mise }));
  return diagnose((await examine(ctx, '/ws/web')).facts);
}

test('mise not on PATH is one PLX-Repo/Verbs finding, and every other check still runs', async () => {
  const report = await withMise(() => {
    throw Object.assign(new Error('spawn mise ENOENT'), { code: 'ENOENT' });
  });
  assert.deepEqual(
    report.units.map((u) => [u.path, u.findings]),
    [
      ['.', [{ requirement: 'PLX-Repo/Verbs', problem: 'mise could not list the tasks: mise is not on PATH' }]],
      ['apps/site', []],
    ],
  );
});

test("a task's alias counts as the task, as `mise run` finds it", async () => {
  const task = (name: string, aliases: string[] = []) => ({
    name,
    aliases,
    source: '/ws/web/mise.toml',
    global: false,
  });
  const report = await withMise(() =>
    JSON.stringify([
      task('//:dev'),
      task('//:build'),
      task('//:verify'),
      task('//:test'),
      task('//:static', ['//:check']),
      task('biome', ['lint']),
    ]),
  );
  assert.deepEqual(report.units[0]?.findings, []);
});

test("a task from a file the repo includes from outside counts by its `dir`; a parent config's task still does not", async () => {
  // As mise lists them (see the report): an included file is named by its own
  // path, absolute or as written, and its tasks run in the repo; a parent
  // config's tasks run in the parent.
  const task = (name: string, source: string, dir: string) => ({ name, source, dir, global: false });
  const report = await withMise(() =>
    JSON.stringify([
      task('dev', '/ws/web/mise.toml', '/ws/web'),
      task('build', '/shared/tasks.toml', '/ws/web'),
      task('verify', '/ws/web/../shared/more.toml', '/ws/web'),
      task('lint', '/ws/web/mise/tasks.toml', '/elsewhere'),
      task('check', '/ws/mise.toml', '/ws'),
      task('test', '/ws/web/../mise.toml', '/ws'),
    ]),
  );
  assert.deepEqual(report.units[0]?.findings, [
    { requirement: 'PLX-Repo/SubVerbs', problem: 'no root mise task `check`' },
    { requirement: 'PLX-Repo/SubVerbs', problem: 'no root mise task `test`' },
  ]);
});

test('a task list without `source` fails with one clear message, not every task missing', async () => {
  const report = await withMise(() => JSON.stringify(VERBS.map((name) => ({ name, global: false }))));
  assert.deepEqual(report.units[0]?.findings, [
    {
      requirement: 'PLX-Repo/Verbs',
      problem:
        "mise could not list the tasks: `mise tasks ls --json` gives no task's `source`, which tells the repo's own tasks apart",
    },
  ]);
});

test('PLX-App/NoCommittedValues: a tracked .env is one finding, on the app that holds it, else on the repo', () => {
  const tracked = ['.env', 'apps/a/.env.secret', 'apps/b/docker/.env', 'apps/bb/.env.example', 'docs/.envrc'];
  const source = repo({ tracked, apps: ['apps/a', 'apps/b'] });
  const report = diagnose([
    source,
    app('stateless', { repo: source }),
    app('stateless', { repo: source, path: 'r/apps/b', dir: 'apps/b' }),
  ]);
  assert.deepEqual(
    report.units.map((u) => [u.path, u.findings.map((f) => `${f.requirement}: ${f.problem}`)]),
    [
      ['r', ['PLX-App/NoCommittedValues: the source repo tracks `.env`']],
      ['r/apps/a', ['PLX-App/NoCommittedValues: the source repo tracks `apps/a/.env.secret`']],
      ['r/apps/b', ['PLX-App/NoCommittedValues: the source repo tracks `apps/b/docker/.env`']],
    ],
  );
  assert.deepEqual(findings(repo({ tracked: ['.env'], apps: [] })), [], 'a repo with no app is no source repo');
});

// --- the marker as configuration -----------------------------------------------------------

const config = (over: Partial<MarkerConfig> = {}): MarkerConfig => ({ deviations: [], answers: {}, ...over });
const site = (dir: string, over: Partial<MarkerConfig> = {}): MarkerSite => ({ dir, config: config(over) });

/** A repo that has crossed over: its root marker lists `templates` and states the version, the pin names it. */
const crossed = (sites: MarkerSite[], over: Partial<RepoFacts> = {}): RepoFacts =>
  repo({ pin: '0.131.0', sites, ...over });

const ROOT = site('.', { version: '0.131.0', templates: ['repo-turbo'] });

test('a repo whose root marker states the version its plx pin names passes', () => {
  assert.deepEqual(findings(crossed([ROOT])), []);
});

test('the root marker names a version other than the plx pin: a finding of no requirement, no deviation silences', () => {
  const stale = crossed([site('.', { version: '0.130.0', templates: ['repo-turbo'] })]);
  const expected = [
    {
      problem: '`version` in PLEXUS.md is 0.130.0, but mise.toml pins plx 0.131.0; only `plx update` moves it',
    },
  ];
  assert.deepEqual(findings(stale), expected);
  const deviating = {
    ...stale,
    marker: { declaration: { deviations: ['PLX-Repo/Verbs'], body: reasoned(['PLX-Repo/Verbs']) } },
  };
  assert.deepEqual(findings(deviating), expected);
  assert.equal(diagnose([stale]).failed, 1);
  assert.deepEqual(findings(app('stateless', { repo: stale })), [], 'reported once, on the repo');
});

test('a repo with a version but no plx pin, or with templates but no version, fails', () => {
  assert.deepEqual(findings(crossed([ROOT], { pin: undefined })), [
    { problem: '`version` in PLEXUS.md is 0.131.0, but mise.toml pins no plx' },
  ]);
  assert.deepEqual(findings(crossed([site('.', { templates: ['repo-turbo'] })])), [
    { problem: 'PLEXUS.md lists `templates` but sets no `version`; `plx update` writes it' },
  ]);
  assert.deepEqual(findings(crossed([site('.', { templates: [] })])), [
    { problem: 'PLEXUS.md lists `templates` but sets no `version`; `plx update` writes it' },
  ]);
});

test('a repo whose markers list no templates needs no version', () => {
  assert.deepEqual(findings(crossed([site('.')], { pin: undefined })), []);
  assert.deepEqual(findings(crossed([site('.'), site('apps/a')], { pin: '0.131.0' })), []);
});

test('a nested marker that carries `version` is a finding of the repo, once per marker', () => {
  const nested = (dir: string): MarkerSite => ({ dir, problem: "`version` belongs in the repo's root marker only" });
  assert.deepEqual(findings(crossed([ROOT, nested('apps/a'), nested('packages/x')])), [
    { problem: "apps/a/PLEXUS.md: `version` belongs in the repo's root marker only" },
    { problem: "packages/x/PLEXUS.md: `version` belongs in the repo's root marker only" },
  ]);
});

test('a marker that cannot be read as configuration is named, unless the repo contract reports it already', () => {
  const broken: MarkerSite[] = [
    { dir: '.', problem: 'marker: `templates` must be a list of template names' },
    { dir: 'apps/a', problem: 'marker: `templates` must be a list of template names' },
  ];
  assert.deepEqual(findings(crossed(broken)), [
    { problem: 'PLEXUS.md: marker: `templates` must be a list of template names' },
    { problem: 'apps/a/PLEXUS.md: marker: `templates` must be a list of template names' },
  ]);
  const reported = crossed(broken, { marker: { problem: 'PLEXUS.md: no frontmatter' } });
  assert.deepEqual(
    findings(reported).filter((f) => f.requirement === undefined),
    [{ problem: 'apps/a/PLEXUS.md: marker: `templates` must be a list of template names' }],
  );
});

test('a key set in both the root marker and a nested one is a finding naming the keys', () => {
  const sites = [
    site('.', { version: '0.131.0', templates: ['repo-turbo'], answers: { tenant: 'plexus', ci: 'github' } }),
    site('apps/a', { templates: ['app-nextjs'], answers: { tenant: 'other', ci: 'x', profile: 'stateless' } }),
    site('apps/b', { answers: { profile: 'stateless' } }),
  ];
  assert.deepEqual(findings(crossed(sites)), [
    { problem: 'apps/a/PLEXUS.md: `tenant`, `ci` are answered in the root marker already' },
  ]);
});

test('the marker checks are skipped in a repo that still tracks a copier answers file, at any depth', () => {
  const failing = [
    site('.', { version: '0.130.0', templates: ['repo-turbo'], answers: { tenant: 'a' } }),
    { dir: 'apps/a', problem: "`version` belongs in the repo's root marker only" },
    site('apps/b', { answers: { tenant: 'b' } }),
  ];
  assert.equal(findings(crossed(failing)).length, 3, 'the same sites fail once the repo has crossed over');
  for (const answers of ['.copier-answers.yml', 'apps/a/.copier-answers.yml'])
    assert.deepEqual(findings(crossed(failing, { tracked: ['mise.toml', answers] })), [], answers);
  assert.equal(findings(crossed(failing, { tracked: ['docs/.copier-answers.yml.md'] })).length, 3);
});

test('a tracked file holding a conflict marker is a finding of the repo, of no requirement, that no deviation silences', () => {
  const marked = repo({ conflicted: ['apps/a/page.tsx', 'mise.toml'] });
  assert.deepEqual(findings(marked), [
    { problem: '`apps/a/page.tsx` holds a conflict marker' },
    { problem: '`mise.toml` holds a conflict marker' },
  ]);
  const deviating = repo({
    conflicted: ['mise.toml'],
    marker: { declaration: { deviations: ['PLX-Repo/Verbs'], body: reasoned(['PLX-Repo/Verbs']) } },
  });
  assert.deepEqual(findings(deviating), [{ problem: '`mise.toml` holds a conflict marker' }]);
  assert.deepEqual(findings(app('stateless', { repo: marked })), [], 'reported once, on the repo');
  assert.equal(diagnose([marked]).failed, 1);
});

test('doctor reads which tracked files hold a conflict marker, and fails the repo for each', async () => {
  const open = '<'.repeat(7);
  const tree = ws();
  const web = tree.web as Tree;
  web['mise.toml'] = `${open} ours\n[tools]\n`;
  web['README.md'] = `Title\n${'='.repeat(7)}\n`;
  const git = (cwd: string, args: string[]) => {
    if (cwd !== '/ws/web') return undefined;
    if (args[0] === 'ls-files') return 'PLEXUS.md\0mise.toml\0README.md\0apps/site/docker/compose.yaml\0';
    if (args[0] === 'grep') return 'mise.toml\0';
    return undefined;
  };
  const mise = miseTasks({ '/ws/web': VERBS });
  const ctx = new Context({}, fakeIo({ ws: tree }, git, { mise: (cwd) => mise(cwd) }));
  const { facts } = await examine(ctx, '/ws/web');
  const report = diagnose(facts);
  assert.deepEqual(
    report.units.map((u) => [u.path, u.findings]),
    [
      ['.', [{ problem: '`mise.toml` holds a conflict marker' }]],
      ['apps/site', []],
    ],
  );
});
