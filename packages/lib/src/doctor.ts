// doctor: the repo's checks (§ 13.4 PLX). Does this unit do what its
// contracts require?
//
// A unit is a repo or an app (§ 1.2 PLX; `examine` below): every repo is bound by
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
// Beside the checks, and part of none of them: a tracked file of a repo that
// holds a conflict marker (conflicts.ts) is a failing finding of the repo,
// one per file, whatever the marker lists; it names no requirement, and
// nothing excludes a file from it.
//
// Also of no requirement, and no deviation silences them: the checks of the
// markers as configuration (sites.ts, `markerConfig` below). The root marker's
// `version` equals the repo's `plx` pin (and is set where any marker lists
// `templates`), no nested marker carries `version`, no key is answered in two
// markers, and a marker that cannot be read as configuration is named. They
// bind a repo that has crossed over from copier: one in which git tracks no
// `.copier-answers.yml` at any depth (`crossedOver`), as the crossover deletes
// every answers file. Until then they are skipped, so that this can ship
// before the cutover. A repo that lists no `templates` needs no `version`.
//
//   plx doctor          # this repo and its apps, from anywhere inside it
//   plx doctor ~/dev    # every Plexus repo beneath, and its apps
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  APP_SERVICE,
  type Compose,
  declaresHealthcheck,
  healthcheckOf,
  isMapping,
  labelsOf,
  type Mapping,
  normalImage,
  parseCompose,
  truthy,
} from './compose.ts';
import { filesWithConflictMarkers } from './conflicts.ts';
import type { Context } from './context.ts';
import { ANSWERS_FILE } from './copier.ts';
import { ExecError } from './io.ts';
import { REQUIREMENT_NAME } from './lints.ts';
import { type Declaration, MARKER_FILE, reasonGiven } from './marker.ts';
import { type Directory, hasMarker, isOperations, type Kind } from './model.ts';
import { appsOf, directoryAt, overview } from './overview.ts';
import { findSites, type MarkerSite, siteAnswers } from './sites.ts';
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
  /** The tracked files that hold a conflict marker, relative to the repo. */
  conflicted?: string[];
  /** Its apps' directories, relative to the repo (`apps/<name>`). */
  apps: string[];
  /** The `plx` pin of its `mise.toml`: the Plexus version it is on. */
  pin?: string;
  /** Every tracked marker read as configuration, the root first; undefined outside a git checkout. */
  sites?: MarkerSite[];
}

/** What doctor read of an app. */
export interface AppFacts {
  kind: 'app';
  path: string;
  /** The app's source repo. */
  repo: RepoFacts;
  /** The app's directory, relative to the repo (`apps/<name>`). */
  dir: string;
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

/** What the contract page says doctor checks of it: the file exists and declares the app service. */
function composeFile(app: AppFacts): string[] {
  if (app.composeProblem) return [app.composeProblem];
  if (!app.compose) return ['no docker/compose.yaml'];
  if (!app.compose.services[APP_SERVICE])
    return [
      `docker/compose.yaml declares no \`${APP_SERVICE}\` service${app.compose.includes ? ' itself (the files it includes are not read)' : ''}, the app service the deploy verb reads`,
    ];
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

/**
 * A tracked `.env` or `.env.secret` is reported once, on the unit that holds
 * it: the app whose directory it is in, else the repo, when the repo is the
 * source repo of any app.
 */
function noCommittedValues(unit: Facts): string[] {
  const repo = unit.kind === 'app' ? unit.repo : unit;
  if (repo.apps.length === 0) return [];
  const within = (file: string, dir: string) => file.startsWith(`${dir}/`);
  const held = (file: string) =>
    unit.kind === 'app' ? within(file, unit.dir) : !repo.apps.some((dir) => within(file, dir));
  return (repo.tracked ?? [])
    .filter((f) => /(^|\/)\.env(\.secret)?$/.test(f) && held(f))
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
const LOOPBACK_PORT = `\${PLEXUS_LOOPBACK_PORT:?<message>}`;
const LOOPBACK_FORM = `127.0.0.1:${LOOPBACK_PORT}:<container-port>`;

/**
 * The app service's host port: `${PLEXUS_LOOPBACK_PORT:?message}`, which fails
 * when the variable is unset or empty. Without the `:?` compose publishes on a
 * random port instead, and with a default (`:-3000`) on a fixed one.
 */
const isLoopbackVar = (host: string): boolean => /^\$\{PLEXUS_LOOPBACK_PORT:\?[^}]*\}$/.test(host);

/** Any spelling of the platform's port without a default: not a host port a service fixes of its own. */
const namesLoopbackVar = (host: string): boolean =>
  /^(?:\$\{PLEXUS_LOOPBACK_PORT(?::?\?[^}]*)?\}|\$PLEXUS_LOOPBACK_PORT)$/.test(host);

function loopbackPort(compose: Compose): string[] {
  const problems: string[] = [];
  const own = portsOf(compose.services[APP_SERVICE] ?? {});
  if (own.length === 0) problems.push(`the ${APP_SERVICE} service publishes no port as ${LOOPBACK_FORM}`);
  for (const port of own)
    if (!isLoopback(port))
      problems.push(`the ${APP_SERVICE} service publishes \`${renderPort(port)}\`, not ${LOOPBACK_FORM}`);
  for (const [name, service] of Object.entries(compose.services)) {
    if (service.network_mode === 'host')
      problems.push(
        `service \`${name}\` runs in the host's network (\`network_mode: host\`), reachable beyond loopback`,
      );
    if (name === APP_SERVICE) continue;
    for (const port of portsOf(service)) {
      if (hostIpOf(port) !== '127.0.0.1')
        problems.push(`service \`${name}\` publishes \`${renderPort(port)}\` beyond 127.0.0.1`);
      const host = hostPortOf(port);
      if (host && !namesLoopbackVar(host))
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
  const same =
    typeof own === 'string' && typeof migrate.image === 'string' && normalImage(migrate.image) === normalImage(own);
  if (own !== undefined && !same)
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

/**
 * A compose check: runs once the file was read, on what the file itself
 * declares (an `include`d file is not read; the unit gets a hint saying so);
 * PLX-App/Compose reports why it was not read.
 */
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

/** A check of whichever unit holds what it finds, a repo or an app. */
interface UnitCheck {
  binds: 'unit';
  check: (unit: Facts) => string[];
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
export const CHECKS: Readonly<Record<string, RepoCheck | AppCheck | UnitCheck>> = {
  'PLX-Repo/Marker': { binds: 'repo', check: repoMarker },
  'PLX-Repo/Verbs': { binds: 'repo', check: verbs },
  'PLX-Repo/SubVerbs': { binds: 'repo', check: subVerbs },
  'PLX-App/Marker': { binds: 'app', check: appMarker },
  'PLX-App/Compose': { binds: 'app', check: composeFile },
  'PLX-App/TenantLabel': { binds: 'app', check: onCompose(tenantLabel) },
  'PLX-App/EnvFileLoad': { binds: 'app', check: onAppService(envFileLoad) },
  'PLX-App/ImageRef': { binds: 'app', built: true, check: onAppService(imageRef) },
  'PLX-App/NoCommittedValues': { binds: 'unit', check: noCommittedValues },
  'PLX-App/SinglePort': { binds: 'app', check: onAppService(singlePort) },
  'PLX-App/LoopbackPort': { binds: 'app', check: onAppService(loopbackPort) },
  'PLX-App/Healthcheck': { binds: 'app', check: onAppService(healthcheck) },
  'PLX-App/Dockerfile': { binds: 'app', built: true, check: dockerfile },
  'PLX-App/Stateless/NoState': { binds: 'app', profile: 'stateless', check: onCompose(noState) },
  'PLX-App/Stateful/MigrateService': { binds: 'app', profile: 'stateful', check: onAppService(migrateService) },
  'PLX-App/Stateful/Seed': { binds: 'app', profile: 'stateful', check: seed },
};

/** Whether a repo has left copier behind: git tracks no answers file in it, at any depth. */
const crossedOver = (repo: RepoFacts): boolean => !(repo.tracked ?? []).some((path) => basename(path) === ANSWERS_FILE);

/**
 * What the markers as configuration must meet (sites.ts): the root's `version`
 * is the `plx` pin's, no other marker has one, and no key is answered in two
 * markers. A marker that cannot be read as configuration is named, except the
 * root one when PLX-Repo/Marker reports it already. Each line is a finding of
 * no requirement.
 */
function markerConfig(repo: RepoFacts): string[] {
  if (!crossedOver(repo)) return [];
  const sites = repo.sites ?? [];
  const problems = sites
    .filter((s) => s.problem !== undefined && !(s.dir === '.' && repo.marker?.problem))
    .map((s) => `${join(s.dir, MARKER_FILE)}: ${s.problem}`);
  const rootRead = sites.some((s) => s.dir === '.' && s.config);
  for (const { dir, config } of sites)
    if (rootRead && dir !== '.' && config)
      try {
        siteAnswers(sites, dir);
      } catch (error) {
        problems.push((error as Error).message);
      }
  return [...versionOfRoot(repo), ...problems];
}

function versionOfRoot(repo: RepoFacts): string[] {
  const sites = repo.sites ?? [];
  const root = sites.find((s) => s.dir === '.')?.config;
  if (!root) return [];
  if (root.version === undefined) {
    const listing = sites.filter((s) => s.config?.templates !== undefined).map((s) => join(s.dir, MARKER_FILE));
    if (listing.length === 0) return [];
    const where =
      listing.length === 1 && listing[0] === MARKER_FILE
        ? 'it lists'
        : `${listing.join(', ')} ${listing.length === 1 ? 'lists' : 'list'}`;
    const set = repo.pin
      ? `set \`version: ${repo.pin}\` in the root marker, the version mise.toml pins plx at`
      : 'set `version` in the root marker to the Plexus version the repo is on, and pin plx at it in mise.toml';
    return [`${MARKER_FILE} sets no \`version\`, though ${where} \`templates\`; ${set}`];
  }
  const at = `\`version\` in ${MARKER_FILE} is ${root.version}, but mise.toml pins`;
  if (repo.pin === undefined) return [`${at} no plx; pin plx at ${root.version}, as \`plx update\` does`];
  return repo.pin === root.version
    ? []
    : [`${at} plx ${repo.pin}; \`plx update\` moves both together, so undo whichever was edited by hand`];
}

// --- the diagnosis --------------------------------------------------------------

export interface Finding {
  /** The requirement's name, e.g. `PLX-App/LoopbackPort`; none for a conflict marker, which belongs to no requirement. */
  requirement?: string;
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
  /** What is worth doing and fails no check, such as deleting keys nothing reads any more. */
  hints?: string[];
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
  if (unit.kind !== 'app') {
    for (const file of unit.conflicted ?? []) findings.push({ problem: `\`${file}\` holds a conflict marker` });
    for (const problem of markerConfig(unit)) findings.push({ problem });
  }
  const obsolete = (declaration?.obsolete ?? []).map((k) => `\`${k}\``).join(' and ');
  const hints: string[] = [];
  if (obsolete)
    hints.push(`the marker's ${obsolete} ${obsolete.includes(' and ') ? 'are' : 'is'} no longer read and can go`);
  if (unit.kind === 'app' && unit.compose?.includes)
    hints.push(
      'docker/compose.yaml uses `include`: the compose checks read what the file itself declares, not the files it includes',
    );
  return {
    path: unit.path,
    kind: unit.kind,
    ...(profile ? { profile } : {}),
    deviations,
    findings,
    ...(hints.length > 0 ? { hints } : {}),
  };
}

/** A check's problems with a unit, or none where it does not bind the unit: another kind, profile, or a third-party app. */
function run(c: RepoCheck | AppCheck | UnitCheck, unit: Facts, profile: Profile | undefined): string[] {
  if (c.binds === 'unit') return c.check(unit);
  if (c.binds === 'repo') return unit.kind === 'app' ? [] : c.check(unit);
  if (unit.kind !== 'app') return [];
  if (c.profile && c.profile !== profile) return [];
  if (c.built && unit.thirdParty) return [];
  return c.check(unit);
}

// --- the reads -------------------------------------------------------------------

/** What doctor read under the directory it was given. */
export interface Examination {
  /** What the unit paths are relative to: the repo's root when the directory is in a repo, else the directory. */
  root: string;
  /** Whether the directory is in a repo; then `root` is that repo's root, and only that repo is read. */
  inRepo: boolean;
  /** Each repo, then its apps. */
  facts: Facts[];
  /** In a workspace, the git roots that are not Plexus repos and were not checked, relative to `root`. */
  skipped: string[];
  /** Symbolic links not followed, so not checked: a directory in a repo's `apps/`, or a repo in a workspace; relative to `root`. */
  links: string[];
  /** Directories that could not be read, so nothing beneath them was checked, with why; relative to `root`. */
  unreadable: { path: string; why: string }[];
}

/**
 * Read the units (§ 1.2 PLX) under `dir`. A repo is a git root; its apps are
 * what `appsOf` finds in its `apps/` (overview.ts; overview reads them by it
 * too), with a marker or without. `dir` is a workspace when git roots lie
 * beneath it, whatever lies above: every git root beneath it is read that is
 * a Plexus repo, which carries a marker or has an app, and the others are
 * named. Otherwise `dir` is in a repo, the nearest git root at or above it,
 * and that repo is read from its root, with no git root nested in it: that
 * is another repo, and none of its files are this repo's. A directory that
 * cannot be read, and a symbolic link to an app or a repo, are named, never
 * fatal.
 */
export async function examine(ctx: Context, dir: string): Promise<Examination> {
  const given = resolve(dir);
  const own = await ctx.readDir(given).catch(() => []);
  let top = own.some((e) => e.name === '.git') ? given : undefined;
  const tree = top ? undefined : await overview(ctx, given, { git: false });
  if (tree && !holdsGitRoot(tree)) top = await enclosingGitRoot(ctx, dirname(given));
  if (top) {
    const repo = await directoryAt(ctx, top);
    const found = await appsOf(ctx, top);
    const rel = (path: string) => relative(top, path);
    return {
      root: top,
      inRepo: true,
      facts: await readUnits(ctx, repo, found.apps, top),
      skipped: [],
      links: found.links.map(rel),
      unreadable: found.unreadable.map(({ path, why }) => ({ path: rel(path), why })),
    };
  }
  const examination: Examination = { root: given, inRepo: false, facts: [], skipped: [], links: [], unreadable: [] };
  const rel = (path: string) => relative(given, path) || '.';
  const visit = async (d: Directory) => {
    if (d.unreadable) examination.unreadable.push({ path: rel(d.path), why: d.unreadable });
    if (d.symlink) examination.links.push(rel(d.path));
    if (d.gitRoot) {
      const apps = d.apps ?? [];
      if (hasMarker(d) || apps.length > 0) examination.facts.push(...(await readUnits(ctx, d, apps, given)));
      else examination.skipped.push(rel(d.path));
    }
    for (const child of d.children) await visit(child);
  };
  if (tree) await visit(tree);
  return examination;
}

/** Whether a git root lies anywhere in the walked tree, the directory itself included. */
const holdsGitRoot = (d: Directory): boolean => Boolean(d.gitRoot) || d.children.some(holdsGitRoot);

/** The nearest directory at or above `dir` that holds `.git`, if any. */
async function enclosingGitRoot(ctx: Context, dir: string): Promise<string | undefined> {
  for (let at = resolve(dir); ; at = dirname(at)) {
    const entries = await ctx.readDir(at).catch(() => []);
    if (entries.some((e) => e.name === '.git')) return at;
    if (dirname(at) === at) return undefined;
  }
}

/** A repo and its apps, with paths relative to `base`. */
async function readUnits(ctx: Context, dir: Directory, apps: string[], base: string): Promise<Facts[]> {
  const repo = await readRepo(ctx, dir, relative(base, dir.path) || '.', isOperations(dir) ? 'operations' : 'repo');
  repo.apps = apps.map((path) => relative(dir.path, path));
  const facts: Facts[] = [repo];
  for (const path of apps)
    facts.push(await readApp(ctx, await directoryAt(ctx, path), relative(base, path), relative(dir.path, path), repo));
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
  const conflicted = tracked === undefined ? undefined : await filesWithConflictMarkers(ctx, dir.path);
  return {
    kind,
    path,
    ...(marker ? { marker } : {}),
    tasks: await rootTasks(ctx, dir.path),
    tracked,
    ...(conflicted?.length ? { conflicted } : {}),
    apps: [],
    ...(dir.pin ? { pin: dir.pin } : {}),
    ...(tracked === undefined ? {} : { sites: await findSites(ctx, dir.path) }),
  };
}

/**
 * The repo's root mise tasks, hidden ones included, as mise lists them, so
 * that tasks from every file mise reads count; a task counts under its name
 * and each of its aliases, as `mise run` finds it by either. A task is the
 * repo's when it is not global and either its `source` is under the repo or
 * its `dir` is the repo's root: a file the repo includes from outside it
 * (`[task_config] includes`) is named by its own path, outside, but its tasks
 * run in the repo, while a parent directory's config gives its tasks the
 * parent as their `dir`. mise names files and dirs by their canonical path,
 * and an include as written (`<repo>/../shared/tasks.toml`), so the repo is
 * compared canonically and the source once normalized. Whatever keeps the
 * list from being read (no mise on PATH, an untrusted config, output without
 * the `source` that tells the repo's tasks apart) is one problem, which
 * PLX-Repo/Verbs reports.
 */
async function rootTasks(ctx: Context, repo: string): Promise<RepoFacts['tasks']> {
  let out: string;
  try {
    out = await ctx.read('mise', ['tasks', 'ls', '--json', '--hidden'], { cwd: repo });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { problem: 'mise is not on PATH' };
    if (!(error instanceof ExecError)) return { problem: (error as Error).message };
    const lines = error.stderr
      .split('\n')
      .map((l) => l.replace(/^mise ERROR /, '').trim())
      .filter((l) => l && !/^(Version:|Run with )/.test(l));
    return { problem: lines.join(' ') || error.message };
  }
  let tasks: unknown;
  try {
    tasks = JSON.parse(out);
  } catch {
    return { problem: '`mise tasks ls --json` printed no JSON' };
  }
  if (!Array.isArray(tasks)) return { problem: '`mise tasks ls --json` printed no list' };
  const listed = tasks.filter((t) => isMapping(t) && typeof t.name === 'string');
  if (listed.some((t) => typeof t.source !== 'string'))
    return { problem: "`mise tasks ls --json` gives no task's `source`, which tells the repo's own tasks apart" };
  const roots = new Set([resolve(repo), await realpath(repo).catch(() => resolve(repo))]);
  const under = (path: string) => [...roots].some((root) => path.startsWith(`${root}/`));
  const isOwn = (task: Mapping) =>
    task.global !== true &&
    (under(resolve(String(task.source))) || (typeof task.dir === 'string' && roots.has(resolve(task.dir))));
  const names: string[] = [];
  for (const task of listed) {
    if (!isOwn(task)) continue;
    const aliases = Array.isArray(task.aliases)
      ? task.aliases.filter((a: unknown): a is string => typeof a === 'string')
      : [];
    for (const name of [task.name as string, ...aliases]) {
      // A monorepo root names its own tasks `//:<task>`; `//<project>:<task>` is a sub-project's.
      if (name.startsWith('//:')) names.push(name.slice(3));
      else if (!name.startsWith('//')) names.push(name);
    }
  }
  return { names };
}

async function readApp(ctx: Context, dir: Directory, path: string, inRepo: string, repo: RepoFacts): Promise<AppFacts> {
  const app: AppFacts = {
    kind: 'app',
    path,
    repo,
    dir: inRepo,
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

/** The address a port is published on: undefined for every interface. */
function hostIpOf(port: unknown): string | undefined {
  if (isMapping(port)) return port.host_ip == null ? undefined : String(port.host_ip);
  const parts = partsOf(String(port));
  return parts.length >= 3 ? parts[0] : undefined;
}

/** The host side of a published port: '' or undefined when compose picks one. */
function hostPortOf(port: unknown): string | undefined {
  if (isMapping(port)) return port.published == null ? undefined : String(port.published);
  const parts = partsOf(String(port));
  return parts.length >= 2 ? parts[parts.length - 2] : undefined;
}

/** The app service's port as the platform binds it: the loopback address, its host port, one container port, over TCP (HTTP). */
function isLoopback(port: unknown): boolean {
  if (isMapping(port))
    return (
      port.host_ip === '127.0.0.1' &&
      isLoopbackVar(String(port.published ?? '')) &&
      /^\d+$/.test(String(port.target)) &&
      (port.protocol == null || port.protocol === 'tcp')
    );
  const spec = String(port);
  const [ip, host, container, ...rest] = partsOf(spec);
  return (
    ip === '127.0.0.1' &&
    isLoopbackVar(host ?? '') &&
    /^\d+$/.test(container ?? '') &&
    rest.length === 0 &&
    !spec.endsWith('/udp')
  );
}
