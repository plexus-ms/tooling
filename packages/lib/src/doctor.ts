// doctor: the repo's checks (§ 13.4 PLX). Does this unit do what its
// contracts require?
//
// A unit is a repo or an app (model.ts, unitsOf): every repo is bound by
// PLX-Repo, every app by PLX-App with the profile its marker states, and an app
// under the operations repo's `apps/` is third-party, every other app built
// (§ 2 PLX-App). Each check is named after its requirement and lives in one
// small function; CHECKS maps the name to it. The list of names is the one
// the contract pages give below each requirements block ("`plx doctor`
// checks …", § 1.3 PLX), and a test holds the two equal.
//
// The checks are static: they read the marker, `docker/compose.yaml`, the
// task list as mise reports it, an app's `package.json`, and git's list of
// tracked files. They never reach a host or a running app, and need no
// compendium: the requirement names a deviation may list come from the index
// this plx carries (standardIndex.ts). A deviation the marker lists silences
// its check; a deviation without a reason in the marker's body, or naming no
// requirement, is a finding of its own. Findings are reported, never fixed.
//
//   plx doctor          # this repo and its apps
//   plx doctor ~/dev    # every unit with a marker beneath
import { realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  APP_SERVICE,
  type Compose,
  declaresHealthcheck,
  healthcheckOf,
  isMapping,
  labelsOf,
  type Mapping,
  parseCompose,
  truthy,
} from './compose.ts';
import type { Context } from './context.ts';
import { ExecError } from './io.ts';
import { REQUIREMENT_NAME } from './lints.ts';
import { type Declaration, MARKER_FILE, reasonGiven } from './marker.ts';
import { type Directory, type Kind, unitsOf } from './model.ts';
import { overview } from './overview.ts';
import { bundledIndex } from './standardIndex.ts';

export type Profile = 'stateless' | 'stateful';

/** The marker as read: its declaration, or why it cannot be read. */
export interface MarkerRead {
  declaration?: Declaration;
  problem?: string;
}

/** What doctor read of a repo. */
export interface RepoFacts {
  kind: 'repo' | 'operations';
  /** Relative to the directory doctor was run on. */
  path: string;
  /** Undefined when the repo carries no marker. */
  marker?: MarkerRead;
  /** The root mise tasks, or why mise could not list them. */
  tasks: { names: string[] } | { problem: string };
  /** The files git tracks, relative to the repo; undefined outside a git checkout. */
  tracked?: string[];
}

/** What doctor read of an app. */
export interface AppFacts {
  kind: 'app';
  path: string;
  /** The app's source repo. */
  repo: RepoFacts;
  thirdParty: boolean;
  marker: MarkerRead;
  /** `docker/compose.yaml`; neither field set when there is none. */
  compose?: Compose;
  composeProblem?: string;
  /** Whether `docker/Dockerfile` exists. */
  dockerfile: boolean;
  /** `package.json`; neither field set when there is none. */
  packageJson?: Mapping;
  packageJsonProblem?: string;
}

export type Facts = RepoFacts | AppFacts;

// --- the checks ---------------------------------------------------------------
//
// Each returns what is wrong, one line per problem; an empty list passes.

const ROOT_VERBS = ['dev', 'build', 'verify'];
const SUB_VERBS = ['lint', 'check', 'test', 'verify'];

function repoMarker(repo: RepoFacts): string[] {
  if (!repo.marker) return [`no ${MARKER_FILE} at the repo's root`];
  return repo.marker.problem ? [repo.marker.problem] : [];
}

const missingTasks = (repo: RepoFacts, wanted: string[]): string[] =>
  'names' in repo.tasks
    ? wanted
        .filter((t) => !(repo.tasks as { names: string[] }).names.includes(t))
        .map((t) => `no root mise task \`${t}\``)
    : [];

function verbs(repo: RepoFacts): string[] {
  if ('problem' in repo.tasks) return [`mise could not list the tasks: ${repo.tasks.problem}`];
  return missingTasks(repo, ROOT_VERBS);
}

/** Existence only: what `verify` runs, in which order, and what `check` includes is not read (see the report). */
const subVerbs = (repo: RepoFacts): string[] => missingTasks(repo, SUB_VERBS);

function appMarker(app: AppFacts): string[] {
  const { declaration, problem } = app.marker;
  if (problem || !declaration) return [problem ?? `no ${MARKER_FILE}`];
  if (declaration.profile === undefined) return ['the marker sets no `profile`: stateless or stateful'];
  if (!isProfile(declaration.profile)) return [`\`profile\` is \`${declaration.profile}\`, not stateless or stateful`];
  return [];
}

function composeFile(app: AppFacts): string[] {
  if (app.composeProblem) return [app.composeProblem];
  if (!app.compose) return ['no docker/compose.yaml'];
  if (!app.compose.services[APP_SERVICE])
    return [`docker/compose.yaml declares no \`${APP_SERVICE}\` service, the app service the deploy verb reads`];
  return [];
}

function tenantLabel(compose: Compose): string[] {
  return Object.entries(compose.services)
    .filter(([, service]) => (labelsOf(service)['plexus.tenant'] ?? '').trim() === '')
    .map(([name]) => `service \`${name}\` carries no \`plexus.tenant\` label`);
}

function envFileLoad(compose: Compose): string[] {
  const loaded = envFilesOf(compose.services[APP_SERVICE] ?? {});
  const problems: string[] = [];
  if (!loaded.has('.env')) problems.push(`the ${APP_SERVICE} service does not load .env via env_file`);
  const secret = loaded.get('.env.secret');
  if (secret === undefined) problems.push(`the ${APP_SERVICE} service does not load .env.secret via env_file`);
  else if (secret) problems.push('.env.secret is loaded, but not marked `required: false`');
  return problems;
}

/** The bare form and the recommended `:?message` form (§ 3 PLX-App). */
const IMAGE_REF = /^\$\{PLEXUS_DEPLOYMENT_IMAGE(:\?[^}]*)?\}$/;

function imageRef(compose: Compose): string[] {
  const image = compose.services[APP_SERVICE]?.image;
  if (typeof image === 'string' && IMAGE_REF.test(image)) return [];
  return [
    image === undefined
      ? `the ${APP_SERVICE} service names no image; a built app's is \${PLEXUS_DEPLOYMENT_IMAGE}`
      : `the ${APP_SERVICE} service's image is \`${String(image)}\`, not \${PLEXUS_DEPLOYMENT_IMAGE}`,
  ];
}

function noCommittedValues(app: AppFacts): string[] {
  return (app.repo.tracked ?? [])
    .filter((f) => /(^|\/)\.env(\.secret)?$/.test(f))
    .map((f) => `the source repo tracks \`${f}\``);
}

function singlePort(compose: Compose): string[] {
  const ports = portsOf(compose.services[APP_SERVICE] ?? {});
  if (ports.length === 1) return [];
  return [
    ports.length === 0
      ? `the ${APP_SERVICE} service publishes no port`
      : `the ${APP_SERVICE} service publishes ${ports.length} ports, not one`,
  ];
}

/** The platform's binding of the app's port (§ 4 PLX-App), as the compose file spells it. */
const LOOPBACK_PORT = `\${PLEXUS_LOOPBACK_PORT}`;
const LOOPBACK_FORM = `127.0.0.1:${LOOPBACK_PORT}:<container-port>`;

function loopbackPort(compose: Compose): string[] {
  const problems: string[] = [];
  const own = portsOf(compose.services[APP_SERVICE] ?? {});
  if (own.length === 0) problems.push(`the ${APP_SERVICE} service publishes no port as ${LOOPBACK_FORM}`);
  for (const port of own)
    if (!isLoopback(port))
      problems.push(`the ${APP_SERVICE} service publishes \`${renderPort(port)}\`, not ${LOOPBACK_FORM}`);
  for (const [name, service] of Object.entries(compose.services)) {
    if (name === APP_SERVICE) continue;
    for (const port of portsOf(service)) {
      const host = hostPortOf(port);
      if (host && host !== LOOPBACK_PORT)
        problems.push(`service \`${name}\` fixes host port \`${host}\` (\`${renderPort(port)}\`)`);
    }
  }
  return problems;
}

function healthcheck(compose: Compose): string[] {
  if (declaresHealthcheck(healthcheckOf(compose))) return [];
  return [`the ${APP_SERVICE} service declares no healthcheck with a test of its own`];
}

const dockerfile = (app: AppFacts): string[] => (app.dockerfile ? [] : ['no docker/Dockerfile']);

function noState(compose: Compose): string[] {
  const problems: string[] = [];
  if (compose.services.migrate) problems.push('a stateless app declares a `migrate` service');
  for (const [name, service] of Object.entries(compose.services))
    if ('plexus.backup' in labelsOf(service))
      problems.push(`service \`${name}\` of a stateless app carries a \`plexus.backup\` label`);
  return problems;
}

function migrateService(compose: Compose): string[] {
  const migrate = compose.services.migrate;
  if (!migrate) return ['declares no `migrate` service'];
  const problems: string[] = [];
  const profiles = Array.isArray(migrate.profiles) ? migrate.profiles.map(String) : [];
  if (!profiles.includes('migrate'))
    problems.push('the `migrate` service is not under `profiles: ["migrate"]`, so a plain `up` starts it');
  const own = compose.services[APP_SERVICE]?.image;
  if (own !== undefined && migrate.image !== own)
    problems.push(
      `the \`migrate\` service runs \`${String(migrate.image ?? 'no image')}\`, not the app's own image \`${String(own)}\``,
    );
  return problems;
}

function seed(app: AppFacts): string[] {
  if (app.packageJsonProblem) return [app.packageJsonProblem];
  const scripts = app.packageJson?.scripts;
  if (!app.packageJson || (isMapping(scripts) && typeof scripts.seed === 'string' && scripts.seed.trim() !== ''))
    return [];
  return ['package.json has no `seed` script'];
}

/** A compose check: runs once the file was read; PLX-App/Compose reports why it was not. */
const onCompose =
  (check: (compose: Compose) => string[]) =>
  (app: AppFacts): string[] =>
    app.compose ? check(app.compose) : [];

/** A check of the app service: runs once the file declares it; PLX-App/Compose reports why it does not. */
const onAppService =
  (check: (compose: Compose) => string[]) =>
  (app: AppFacts): string[] =>
    app.compose?.services[APP_SERVICE] ? check(app.compose) : [];

interface RepoCheck {
  binds: 'repo';
  check: (repo: RepoFacts) => string[];
}

interface AppCheck {
  binds: 'app';
  /** Only an app of this profile. */
  profile?: Profile;
  /** Only a built app, never a third-party one. */
  built?: true;
  check: (app: AppFacts) => string[];
}

/** Every requirement doctor checks, by name: what the contract pages list, in their order. */
export const CHECKS: Readonly<Record<string, RepoCheck | AppCheck>> = {
  'PLX-Repo/Marker': { binds: 'repo', check: repoMarker },
  'PLX-Repo/Verbs': { binds: 'repo', check: verbs },
  'PLX-Repo/SubVerbs': { binds: 'repo', check: subVerbs },
  'PLX-App/Marker': { binds: 'app', check: appMarker },
  'PLX-App/Compose': { binds: 'app', check: composeFile },
  'PLX-App/TenantLabel': { binds: 'app', check: onCompose(tenantLabel) },
  'PLX-App/EnvFileLoad': { binds: 'app', check: onAppService(envFileLoad) },
  'PLX-App/ImageRef': { binds: 'app', built: true, check: onAppService(imageRef) },
  'PLX-App/NoCommittedValues': { binds: 'app', check: noCommittedValues },
  'PLX-App/SinglePort': { binds: 'app', check: onAppService(singlePort) },
  'PLX-App/LoopbackPort': { binds: 'app', check: onAppService(loopbackPort) },
  'PLX-App/Healthcheck': { binds: 'app', check: onAppService(healthcheck) },
  'PLX-App/Dockerfile': { binds: 'app', built: true, check: dockerfile },
  'PLX-App/Stateless/NoState': { binds: 'app', profile: 'stateless', check: onCompose(noState) },
  'PLX-App/Stateful/MigrateService': { binds: 'app', profile: 'stateful', check: onAppService(migrateService) },
  'PLX-App/Stateful/Seed': { binds: 'app', profile: 'stateful', check: seed },
};

// --- the diagnosis --------------------------------------------------------------

export interface Finding {
  /** The requirement's name, e.g. `PLX-App/LoopbackPort`. */
  requirement: string;
  problem: string;
}

export interface UnitReport {
  path: string;
  kind: Kind;
  /** An app's profile, when its marker states a valid one. */
  profile?: Profile;
  /** The deviations its marker lists, whose checks were not run. */
  deviations: string[];
  findings: Finding[];
}

export interface Report {
  units: UnitReport[];
  /** Units with at least one finding. */
  failed: number;
}

const isProfile = (value: unknown): value is Profile => value === 'stateless' || value === 'stateful';

/** The requirement names the index this plx carries knows: what a deviation may name. */
export const knownRequirements = (): Set<string> =>
  new Set(bundledIndex().citable.filter((c) => new RegExp(`^${REQUIREMENT_NAME}$`).test(c)));

/** What was read, against the checks: pure, so a test compares reports. */
export function diagnose(facts: Facts[], known: Set<string> = knownRequirements()): Report {
  const units = facts.map((unit) => diagnoseUnit(unit, known));
  return { units, failed: units.filter((u) => u.findings.length > 0).length };
}

function diagnoseUnit(unit: Facts, known: Set<string>): UnitReport {
  const declaration = unit.marker?.declaration;
  const deviations = declaration?.deviations ?? [];
  const profile = unit.kind === 'app' && isProfile(declaration?.profile) ? declaration.profile : undefined;
  const findings: Finding[] = [];
  for (const name of deviations) {
    if (!known.has(name))
      findings.push({ requirement: name, problem: 'listed under `deviations`, but no requirement has this name' });
    else if (!reasonGiven(declaration?.body ?? '', name))
      findings.push({
        requirement: name,
        problem: "listed under `deviations`, but no bullet of the marker's body names it with a reason",
      });
  }
  for (const [name, c] of Object.entries(CHECKS)) {
    if (deviations.includes(name)) continue;
    for (const problem of run(c, unit, profile)) findings.push({ requirement: name, problem });
  }
  return { path: unit.path, kind: unit.kind, ...(profile ? { profile } : {}), deviations, findings };
}

/** A check's problems with a unit, or none where it does not bind the unit: another kind, profile, or a third-party app. */
function run(c: RepoCheck | AppCheck, unit: Facts, profile: Profile | undefined): string[] {
  if (c.binds === 'repo') return unit.kind === 'app' ? [] : c.check(unit);
  if (unit.kind !== 'app') return [];
  if (c.profile && c.profile !== profile) return [];
  if (c.built && unit.thirdParty) return [];
  return c.check(unit);
}

// --- the reads -------------------------------------------------------------------

/**
 * Read every unit under `root`: the repo `root` is, with its apps, or every
 * unit with a marker beneath it.
 */
export async function examine(ctx: Context, root: string): Promise<Facts[]> {
  const tree = await overview(ctx, root, { git: false });
  const rootIsRepo = (await ctx.readDir(root)).some((e) => e.name === '.git');
  const repos = new Map<Directory, RepoFacts>();
  const facts: Facts[] = [];
  for (const unit of unitsOf(tree, { rootIsRepo })) {
    const path = relative(tree.path, unit.dir.path) || '.';
    if (unit.kind === 'app' && unit.repo) {
      const repo = repos.get(unit.repo);
      if (!repo) throw new Error(`${path}: an app read before its repo`);
      facts.push(await readApp(ctx, unit.dir, path, repo));
    } else {
      const repo = await readRepo(ctx, unit.dir, path, unit.kind === 'operations' ? 'operations' : 'repo');
      repos.set(unit.dir, repo);
      facts.push(repo);
    }
  }
  return facts;
}

function markerOf(dir: Directory): MarkerRead | undefined {
  if (dir.declaration) return { declaration: dir.declaration };
  const problem = dir.problems?.find((p) => p.startsWith(`${MARKER_FILE}: `));
  return problem ? { problem } : undefined;
}

async function readRepo(ctx: Context, dir: Directory, path: string, kind: RepoFacts['kind']): Promise<RepoFacts> {
  const marker = markerOf(dir);
  const tracked = await ctx
    .read('git', ['ls-files', '-z'], { cwd: dir.path })
    .then((out) => out.split('\0').filter(Boolean))
    .catch((error) => {
      if (error instanceof ExecError) return undefined;
      throw error;
    });
  return { kind, path, ...(marker ? { marker } : {}), tasks: await rootTasks(ctx, dir.path), tracked };
}

/**
 * The repo's root mise tasks, hidden ones included, as mise lists them, so
 * that tasks from every file mise reads count. Tasks a parent directory's or
 * the global config contributes are not the repo's; mise names their files by
 * their canonical path, so the repo's is compared canonically.
 */
async function rootTasks(ctx: Context, repo: string): Promise<RepoFacts['tasks']> {
  let out: string;
  try {
    out = await ctx.read('mise', ['tasks', 'ls', '--json', '--hidden'], { cwd: repo });
  } catch (error) {
    if (!(error instanceof ExecError)) throw error;
    const lines = error.stderr
      .split('\n')
      .map((l) => l.replace(/^mise ERROR /, '').trim())
      .filter((l) => l && !/^(Version:|Run with )/.test(l));
    return { problem: lines.join(' ') || error.message };
  }
  const own = `${await realpath(repo).catch(() => repo)}/`;
  const tasks: unknown = JSON.parse(out);
  const names: string[] = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!isMapping(task) || typeof task.name !== 'string' || task.global === true) continue;
    if (typeof task.source !== 'string' || !task.source.startsWith(own)) continue;
    // A monorepo root names its own tasks `//:<task>`; `//<project>:<task>` is a sub-project's.
    if (task.name.startsWith('//:')) names.push(task.name.slice(3));
    else if (!task.name.startsWith('//')) names.push(task.name);
  }
  return { names };
}

async function readApp(ctx: Context, dir: Directory, path: string, repo: RepoFacts): Promise<AppFacts> {
  const app: AppFacts = {
    kind: 'app',
    path,
    repo,
    thirdParty: repo.kind === 'operations',
    marker: markerOf(dir) ?? {},
    dockerfile: (await ctx.readDir(join(dir.path, 'docker')).catch(() => [])).some(
      (e) => e.name === 'Dockerfile' && !e.directory,
    ),
  };
  const compose = await ctx.readFile(join(dir.path, 'docker/compose.yaml')).catch(() => undefined);
  if (compose !== undefined) {
    try {
      app.compose = parseCompose(compose, 'docker/compose.yaml');
    } catch (error) {
      app.composeProblem = (error as Error).message;
    }
  }
  const manifest = await ctx.readFile(join(dir.path, 'package.json')).catch(() => undefined);
  if (manifest !== undefined) {
    try {
      const data: unknown = JSON.parse(manifest);
      app.packageJson = isMapping(data) ? data : {};
    } catch {
      app.packageJsonProblem = 'package.json is not JSON';
    }
  }
  return app;
}

// --- compose's spellings -----------------------------------------------------------

/** The env files a service loads, by path, each with whether it is required (compose's default). */
function envFilesOf(service: Mapping): Map<string, boolean> {
  const { env_file: files } = service;
  const entries = files === undefined ? [] : Array.isArray(files) ? files : [files];
  const loaded = new Map<string, boolean>();
  for (const entry of entries) {
    const path = isMapping(entry) ? entry.path : entry;
    if (typeof path !== 'string') continue;
    const required = isMapping(entry) && entry.required != null ? truthy(entry.required) : true;
    loaded.set(path.replace(/^\.\//, ''), required);
  }
  return loaded;
}

const portsOf = (service: Mapping): unknown[] => (Array.isArray(service.ports) ? service.ports : []);

const renderPort = (port: unknown): string => (isMapping(port) ? JSON.stringify(port) : String(port));

/** A short port spec's parts, `[ip:][host:]container[/protocol]`, split where no `${…}` is open. */
function partsOf(spec: string): string[] {
  const parts = [''];
  let depth = 0;
  for (const ch of spec.replace(/\/(tcp|udp)$/, '')) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ':' && depth === 0) parts.push('');
    else parts[parts.length - 1] += ch;
  }
  return parts;
}

/** The host side of a published port: '' or undefined when compose picks one. */
function hostPortOf(port: unknown): string | undefined {
  if (isMapping(port)) return port.published == null ? undefined : String(port.published);
  const parts = partsOf(String(port));
  return parts.length >= 2 ? parts[parts.length - 2] : undefined;
}

function isLoopback(port: unknown): boolean {
  if (isMapping(port))
    return port.host_ip === '127.0.0.1' && port.published === LOOPBACK_PORT && /^\d+$/.test(String(port.target));
  const [ip, host, container, ...rest] = partsOf(String(port));
  return ip === '127.0.0.1' && host === LOOPBACK_PORT && /^\d+$/.test(container ?? '') && rest.length === 0;
}
