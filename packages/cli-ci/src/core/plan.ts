// The plan of a run (§ 8 PLX-Delivery): for every app, the build and the test
// hash from one Turbo dry run and a look-up in the registry, which leaves one
// leg per app that owes something: the build where its image is missing, the
// test where its test tag is, both on one machine, the test after the build
// (two build legs without cache in repro mode, which plans no test). Each leg
// names the runner its job asks for, from the strategy: the forge's, a large
// slot, or, under hybrid, the one label of an instance `hybrid
// create-instances` then creates for it. With a deploy asked for, the plan also says which
// environment the run releases into and where each app deploys there, from
// the platform repo's inventory. The plan decides and launches nothing: its
// result is the matrices the jobs fan out over.
import type { Context, EnvironmentTargets } from '@plexus-ms/lib';
import { UsageError } from '@plexus-ms/lib';
import { digestOf, findTag, imageName, layersOf, type Registry } from './registry.ts';
import { runnerOf, type Strategy } from './strategy.ts';

export type Mode = 'build' | 'force' | 'repro';

/** One app's hashes: of its build task, and of its test task when it has one. */
export interface Hash {
  app: string;
  hash: string;
  test?: string;
}

/** Turbo's marker for a task whose script the package does not define. */
const NONEXISTENT = '<NONEXISTENT>';

/** The build and test hashes from Turbo's dry run (`turbo run build test --dry-run=json`), per app, by its package's name. */
export function hashesOf(dryRun: string, packages: Record<string, string>): Hash[] {
  const data = JSON.parse(dryRun) as {
    tasks?: { taskId: string; package: string; hash: string; command?: string }[];
  };
  const tasks = (data.tasks ?? []).filter((t) => t.command !== NONEXISTENT);
  return Object.entries(packages).flatMap(([app, name]) => {
    const build = tasks.find((t) => t.package === name && t.taskId.endsWith('#build'));
    if (!build) return [];
    const test = tasks.find((t) => t.package === name && t.taskId.endsWith('#test'));
    return [{ app, hash: build.hash, ...(test ? { test: test.hash } : {}) }];
  });
}

/** The name of an app's package, `apps/<app>/package.json`: what Turbo calls it. */
export async function packageName(ctx: Context, dir: string, app: string): Promise<string> {
  const pkg = JSON.parse(await ctx.readFile(`${dir}/apps/${app}/package.json`)) as { name?: string };
  if (!pkg.name) throw new UsageError(`apps/${app}/package.json has no name`);
  return pkg.name;
}

/** Turbo at the version the repo's root pins. */
export async function turboOf(ctx: Context, dir: string): Promise<string> {
  const pkg = JSON.parse(await ctx.readFile(`${dir}/package.json`)) as { devDependencies?: Record<string, string> };
  return `turbo@${pkg.devDependencies?.turbo ?? 'latest'}`;
}

export async function readHashes(ctx: Context, dir: string, apps: string[]): Promise<Hash[]> {
  const packages: Record<string, string> = {};
  for (const app of apps) packages[app] = await packageName(ctx, dir, app);
  const out = await ctx.read('npx', ['--yes', await turboOf(ctx, dir), 'run', 'build', 'test', '--dry-run=json'], {
    cwd: dir,
  });
  return hashesOf(out, packages);
}

/** The run a plan is for; names the instances under hybrid. */
export interface Run {
  runId: string;
  attempt: string;
}

/**
 * A large job: one app, the runner it asks for, and what it owes there. `hash`
 * is the build hash, the candidate's tag, whether or not the leg builds it.
 */
export interface Leg {
  app: string;
  hash: string;
  runner: string;
  n: number;
  /** The image is to be built. */
  build: boolean;
  /** The test hash where the candidate is to be tested, else empty. */
  test: string;
}

/** A deploy job: one app, where it deploys in the run's environment, and the image the release publishes. */
export interface DeployLeg {
  app: string;
  host: string;
  image: string;
}

/** The verbs a leg mounts, as its job is named: `build`, `test`, or `build, test`. */
export const verbsOf = (leg: Pick<Leg, 'build' | 'test'>): string =>
  [leg.build ? 'build' : '', leg.test ? 'test' : ''].filter((v) => v !== '').join(', ');

/** The legs a mode asks for, one per app (two in repro mode), before the registry is consulted and the tests are added. */
export function legsOf(apps: string[], hashes: Hash[], mode: Mode, strategy: Strategy, run: Run): Leg[] {
  return apps.flatMap((app) => {
    const hash = hashes.find((h) => h.app === app)?.hash;
    if (!hash) throw new UsageError(`no build hash for ${app}; is it an app package of the workspace?`);
    const copies = mode === 'repro' ? 2 : 1;
    return Array.from({ length: copies }, (_, i) => {
      const n = i + 1;
      const base = `exo-large-${run.runId}-${app}-${run.attempt}`;
      const runner = runnerOf(strategy, 'large', mode === 'repro' ? `${base}-${n}` : base);
      return { app, hash, runner, n, build: true, test: '' };
    });
  });
}

/**
 * The environment a run releases into (§ 3 PLX-Delivery): `given` when the
 * caller stands in for an environment branch, else main is production and
 * develop is staging, on a push or a run by hand; anything else, a pull
 * request among it, releases nowhere.
 */
export function environmentOf(event: string, ref: string, given = ''): string {
  if (given) return given;
  if (event !== 'push' && event !== 'workflow_dispatch') return '';
  return ref === 'main' ? 'production' : ref === 'develop' ? 'staging' : '';
}

/** The deploy legs: one per planned app with a target in the environment; the rest have no deployment there. */
export function deployLegsOf(
  apps: string[],
  targets: EnvironmentTargets,
  prefix: string,
  sha: string,
): { legs: DeployLeg[]; without: string[] } {
  const legs: DeployLeg[] = [];
  const without: string[] = [];
  for (const app of apps) {
    const host = targets[app];
    if (host === undefined) without.push(app);
    else legs.push({ app, host, image: `${imageName(prefix, app)}:${sha}` });
  }
  return { legs, without };
}

export interface Plan {
  /** The large jobs to run: per app, the build, the test, or both. */
  legs: Leg[];
  /** Every app planned, with its hashes: what the publish fans out over. */
  apps: Hash[];
  /** The environment the run releases into, empty for none. */
  environment: string;
  /** The deploys of the release, empty without an environment. */
  deploys: DeployLeg[];
  skipped: { app: string; hash: string; ref: string }[];
  skippedTests: { app: string; hash: string; ref: string }[];
}

export interface PlanOptions {
  apps: string[];
  mode: Mode;
  /** Plan tests too; off for the build measurements. */
  tests?: boolean;
  hashes: Hash[];
  strategy: Strategy;
  registry: Registry;
  run: Run;
  /** With a deploy asked for: the environment, its targets, and what names the published image. */
  deploy?: { environment: string; targets: EnvironmentTargets; prefix: string; sha: string };
}

export async function plan(ctx: Context, options: PlanOptions): Promise<Plan> {
  const { apps, hashes, mode, strategy, registry, run } = options;
  const result: Plan = {
    legs: [],
    apps: apps.map((app) => {
      const h = hashes.find((x) => x.app === app);
      if (!h) throw new UsageError(`no build hash for ${app}; is it an app package of the workspace?`);
      return h;
    }),
    environment: options.deploy?.environment ?? '',
    deploys: [],
    skipped: [],
    skippedTests: [],
  };
  for (const leg of legsOf(apps, hashes, mode, strategy, run)) {
    let build = true;
    if (mode === 'build') {
      const ref = await findTag(ctx, registry, leg.app, `build-${leg.hash}`);
      if (ref !== undefined) {
        ctx.say(`${leg.app}: ${ref} exists, nothing to build`);
        result.skipped.push({ app: leg.app, hash: leg.hash, ref });
        build = false;
      }
    }
    // The test of an app with a test task, on the machine that builds it or,
    // the build being there already, on one that only tests.
    let test = (options.tests && mode !== 'repro' && hashes.find((h) => h.app === leg.app)?.test) || '';
    if (test && mode === 'build') {
      const ref = await findTag(ctx, registry, leg.app, `test-${test}`);
      if (ref !== undefined) {
        ctx.say(`${leg.app}: ${ref} exists, nothing to test`);
        result.skippedTests.push({ app: leg.app, hash: test, ref });
        test = '';
      }
    }
    if (build || test) result.legs.push({ ...leg, build, test });
  }
  if (options.deploy?.environment) {
    const { environment, targets, prefix, sha } = options.deploy;
    const { legs, without } = deployLegsOf(apps, targets, prefix, sha);
    result.deploys = legs;
    for (const app of without) ctx.say(`${app} has no deployment in ${environment}; nothing to deploy`);
  }
  return result;
}

export interface Comparison {
  app: string;
  hash: string;
  digest?: string;
  /** In repro mode: the two builds' digests and the layers that differ. */
  repro?: { one?: string; two?: string; identical: boolean; layers: number; same: number; differing: string[] };
}

/** What the registry holds after a run: every app's digest, and in repro mode the two builds compared layer by layer. */
export async function report(
  ctx: Context,
  registry: Registry,
  legs: Leg[],
  mode: Mode,
  runId: string,
): Promise<Comparison[]> {
  const apps = [...new Set(legs.map((l) => l.app))].sort();
  const out: Comparison[] = [];
  for (const app of apps) {
    const hash = legs.find((l) => l.app === app)?.hash ?? '';
    const c: Comparison = { app, hash, digest: await digestOf(ctx, registry, app, `build-${hash}`) };
    ctx.say(`${app} build-${hash}: ${c.digest ?? 'missing'}`);
    if (mode === 'repro') {
      const [one, two] = await Promise.all([
        digestOf(ctx, registry, app, `repro-${runId}-1`),
        digestOf(ctx, registry, app, `repro-${runId}-2`),
      ]);
      const identical = one !== undefined && one === two;
      const [l1, l2] = identical
        ? [[], []]
        : await Promise.all([
            layersOf(ctx, registry, app, `repro-${runId}-1`),
            layersOf(ctx, registry, app, `repro-${runId}-2`),
          ]);
      const differing: string[] = [];
      const a = l1 ?? [];
      const b = l2 ?? [];
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i]?.digest !== b[i]?.digest)
          differing.push(
            `layer ${i + 1}: ${a[i]?.digest ?? '-'} (${a[i]?.size ?? '-'}) vs ${b[i]?.digest ?? '-'} (${b[i]?.size ?? '-'})`,
          );
      }
      c.repro = { one, two, identical, layers: a.length, same: a.length - differing.length, differing };
      if (identical) ctx.say(`  reproducible: both builds are ${one}`);
      else {
        ctx.say(
          `  not identical: ${one ?? '-'} vs ${two ?? '-'}; layers: ${a.length} in each, ${a.length - differing.length} identical`,
        );
        for (const d of differing) ctx.say(`  ${d}`);
      }
    }
    out.push(c);
  }
  return out;
}
