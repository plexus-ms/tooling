import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Compose, type Mapping, parseCompose } from './compose.ts';
import { Context } from './context.ts';
import { type AppFacts, CHECKS, diagnose, examine, type Facts, type RepoFacts } from './doctor.ts';
import { REQUIREMENT_NAME } from './lints.ts';
import { fakeIo, type Tree } from './testing/fakeIo.ts';

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
  ports: ['127.0.0.1:${PLEXUS_LOOPBACK_PORT}:3000'],
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
              web: web({ ports: ['127.0.0.1:${PLEXUS_LOOPBACK_PORT}:3000', '127.0.0.1:${PLEXUS_LOOPBACK_PORT}:9229'] }),
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
      - { target: 3000, host_ip: 127.0.0.1, published: "\${PLEXUS_LOOPBACK_PORT}" }
    labels: [plexus.tenant=t]
    healthcheck: { test: curl -f localhost:3000 }
`;
  assert.deepEqual(findings(appOf(longForm)), []);
});

test('PLX-App/LoopbackPort: a data service may publish no fixed host port, the app service only the loopback binding', () => {
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
    ports: ["127.0.0.1:6379:6379", "6380", "127.0.0.1::6381"]
`;
  assert.deepEqual(
    named(appOf(text), 'PLX-App/LoopbackPort').map((f) => f.problem),
    [
      'the web service publishes `127.0.0.1:${PLEXUS_LOOPBACK_PORT:-3000}:3000`, not 127.0.0.1:${PLEXUS_LOOPBACK_PORT}:<container-port>',
      'service `cache` fixes host port `6379` (`127.0.0.1:6379:6379`)',
    ],
  );
});

test('PLX-App/LoopbackPort takes the bare, the :? and the $ spellings of the variable, over TCP; a default fixes a port', () => {
  const ported = (ports: unknown[]) =>
    named(app('stateless', { compose: { services: { web: web({ ports }) } } }), 'PLX-App/LoopbackPort').length;
  for (const spec of [
    '127.0.0.1:${PLEXUS_LOOPBACK_PORT}:3000',
    '127.0.0.1:${PLEXUS_LOOPBACK_PORT:?set by the platform}:3000',
    '127.0.0.1:$PLEXUS_LOOPBACK_PORT:3000',
    '127.0.0.1:${PLEXUS_LOOPBACK_PORT}:3000/tcp',
  ])
    assert.equal(ported([spec]), 0, spec);
  assert.equal(ported([{ target: 3000, host_ip: '127.0.0.1', published: '${PLEXUS_LOOPBACK_PORT:?x}' }]), 0);
  for (const spec of [
    '127.0.0.1:${PLEXUS_LOOPBACK_PORT:-3000}:3000',
    '127.0.0.1:${PLEXUS_LOOPBACK_PORT}:3000/udp',
    '127.0.0.1:${PLEXUS_LOOPBACK_PORTX}:3000',
  ])
    assert.equal(ported([spec]), 1, spec);
  assert.equal(
    ported([{ target: 3000, host_ip: '127.0.0.1', published: '${PLEXUS_LOOPBACK_PORT}', protocol: 'udp' }]),
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
    ports: ["127.0.0.1:\${PLEXUS_LOOPBACK_PORT}:3000"]
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

test('one level of extends is merged: a base that extends another is read as written', () => {
  const compose = parseCompose(
    'services:\n  a: { labels: { plexus.tenant: t } }\n  b: { extends: a }\n  c: { extends: b, image: x }\n',
    'c',
  );
  assert.deepEqual(compose.services.b, { labels: { 'plexus.tenant': 't' } });
  assert.deepEqual(compose.services.c, { image: 'x' });
});

test('an extends naming another file is not followed; the service is read as written', () => {
  const compose = parseCompose(
    'services:\n  web:\n    extends: { file: base.yaml, service: web }\n    image: x\n',
    'c',
  );
  assert.deepEqual(compose.services.web, { extends: { file: 'base.yaml', service: 'web' }, image: 'x' });
});

test('a compose file that uses include is one PLX-App/Compose problem, and no other compose check judges it', () => {
  const text = `include: [db.yaml]
services:
  web:
    image: nginx
`;
  assert.deepEqual(findings(appOf(text)), [
    {
      requirement: 'PLX-App/Compose',
      problem: 'docker/compose.yaml uses `include`, which the checks do not read; no compose check judges the file',
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
    ports: ["127.0.0.1:\${PLEXUS_LOOPBACK_PORT}:3000"]
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
) {
  const files: Record<string, string[]> = { '/ws/web': ['PLEXUS.md', 'apps/site/docker/compose.yaml'], ...tracked };
  const git = (cwd: string, args: string[]) =>
    args[0] === 'ls-files' && files[cwd] ? files[cwd].map((f) => `${f}\0`).join('') : undefined;
  const mise = miseTasks({ '/ws/web': webTasks, '/ws/ops': ['dev', 'build', 'verify', 'check', 'test'] });
  const ctx = new Context({}, fakeIo({ ws: tree }, git, { mise: (cwd) => mise(cwd) }));
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
