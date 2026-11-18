// deploy: launch a released artifact into an execution environment (§ 6
// PLX-Delivery). A stateless procedure, not a system:
//
//   render compose.yaml from the invoking checkout, pinning the image ref (§§ 2 and 3 PLX-App)
//   → stage it on the host → docker compose pull → compose run --rm migrate (if declared),
//     both against the staged file → swap the file into place → docker compose up -d --remove-orphans
//     → wait for web's healthcheck → on failure: restore the previous file, up -d --remove-orphans (no pull), fail
//
// Run from a checkout of the app's SOURCE repo (§ 2 PLX-App): an app repo's
// CI, or the operations repo for third-party software the tenant merely
// operates. The run shape, apps/<app>/docker/compose.yaml (or
// apps/<app>/compose.yaml), is read from there, rendered with the concrete
// image ref in place of ${PLEXUS_DEPLOYMENT_IMAGE}, staged on the host, and
// swapped into place only once pull and migrate have succeeded, so the compose
// file on the host always names the image it serves, and a failed deploy
// leaves the host exactly as it was. Three files in the app dir, one writer
// each (PLX-Secrets): the configure playbook owns .env and .env.secret, this
// verb owns compose.yaml. Compose reads .env implicitly, so every command here
// and by a human is a bare `docker compose …` in the app dir.
//
// Every command sent to the host is one line of shell over ssh, carried in
// the plan and printed verbatim by the dry run, so a stranded operator copies
// the lines; the host needs bash and docker and nothing else. The ssh
// calls share one connection (ControlMaster), opened by the first and closed
// at the end. Reality is the source of truth: the previous image is read from
// the running container, never from a file this verb owns.
//
// Migrations are an artifact capability, not a host toolchain: an app that
// has them declares a one-shot `migrate` service (same image, migrate command,
// `profiles: ["migrate"]` so plain `up` never starts it). The `web` service is
// the app service by convention; it is the one the live image and the
// health status are read from, and the one that must declare a healthcheck
// (PLX-App/Healthcheck); every other service rides along with pull and up.
// A third-party app pins its image inside compose.yaml and passes no image
// ref; the file is then placed as is. Where the host already serves the same
// file with `web` running and healthy, with or without a ref, the verb ends
// there: nothing is pulled, migrated or restarted.
//
//   plx deploy deploy@1.2.3.4 website --image ghcr.io/org/website:<sha>
//   plx deploy deploy@1.2.3.4 website --environment staging --image …   # into /opt/stacks/website-staging
//   plx -n deploy deploy@host beszel          # the ssh lines it would run
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { declaresHealthcheck, healthcheckOf, IMAGE_PLACEHOLDER, type Mapping, parseCompose } from './compose.ts';
import type { Context } from './context.ts';
import { DEFAULT_ENVIRONMENT, deploymentSlug } from './deployTargets.ts';
import { run } from './effects.ts';
import { orAbsent } from './io.ts';
import { UsageError } from './version.ts';

export interface DeployOptions {
  /** ssh target, `deploy@host`. */
  host: string;
  app: string;
  /** The image ref to pin; empty or absent for a third-party app whose file pins its own. */
  image?: string;
  /** Looks at the app container's health status, two seconds apart. */
  retries?: number;
  /** The environment deployed into; default production. Decides the app dir's slug (§ 3 PLX-Platform). */
  environment?: string;
  /** The app dir on the host; default /opt/stacks/<slug>, the platform playbook's layout. */
  appDir?: string;
  /** The app's dir in the checkout; default apps/<app>. */
  source?: string;
  /** The checkout; default the cwd. */
  dir?: string;
}

export interface Deploy {
  host: string;
  appDir: string;
  /** The compose file read, relative to the checkout. */
  compose: string;
  image?: string;
  /** The image that was live before, from the running container. */
  previous?: string;
  /** The image live at the end, healthy or rolled back to. */
  live?: string;
  healthy: boolean;
  rolledBack: boolean;
  /** The host already served this image (or, without a ref, this file) from this run shape, healthy; nothing was pulled or restarted. */
  unchanged?: boolean;
}

const INCOMING = '.incoming';

/**
 * Pin the image ref in place of the ${PLEXUS_DEPLOYMENT_IMAGE} placeholder
 * (§ 3 PLX-App), with or without a `:?message` suffix: one literal
 * substitution, nothing else touched. A first-party file without the
 * placeholder would silently ignore the ref, and a third-party file with one
 * would ship an empty image; both are errors here, never on the host.
 */
export function renderCompose(text: string, image: string | undefined, path: string): string {
  const has = IMAGE_PLACEHOLDER.test(text);
  IMAGE_PLACEHOLDER.lastIndex = 0;
  if (image) {
    if (!has)
      throw new UsageError(
        `${path} does not reference \${PLEXUS_DEPLOYMENT_IMAGE}; an image ref was given but nothing would use it (§ 3 PLX-App)`,
      );
    return text.replace(IMAGE_PLACEHOLDER, image);
  }
  if (has) throw new UsageError(`${path} references \${PLEXUS_DEPLOYMENT_IMAGE} but no image ref was given`);
  return text;
}

/** The app dir the platform playbook lays out: the deploy root and the deployment's slug (§ 3 PLX-Platform). */
export function defaultAppDir(app: string, environment: string = DEFAULT_ENVIRONMENT): string {
  return `/opt/stacks/${deploymentSlug(app, environment)}`;
}

/** Single-quote a word for a remote shell. */
export const q = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

/** The ssh calls of one deploy, sharing a connection; each command is one line of shell. */
class Remote {
  private readonly socket = join(tmpdir(), `plx-deploy-${randomBytes(4).toString('hex')}.sock`);

  private readonly ctx: Context;
  readonly host: string;

  constructor(ctx: Context, host: string) {
    this.ctx = ctx;
    this.host = host;
  }

  private args(command: string): string[] {
    return [
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${this.socket}`,
      '-o',
      'ControlPersist=60',
      '-o',
      'StrictHostKeyChecking=accept-new',
      this.host,
      '--',
      command,
    ];
  }

  /** An effect on the host: narrated, performed unless --dry-run. */
  exec(command: string, input?: string): Promise<void> {
    return this.ctx.apply([run('ssh', this.args(command), input === undefined ? {} : { input })]);
  }

  /**
   * A read from the host: its output, or undefined under --dry-run, where no
   * host is reached. A read that is a step of the procedure (`show`) is
   * printed by the dry run like an effect, so the operator copies it too.
   */
  async read(command: string, show = false): Promise<string | undefined> {
    if (this.ctx.dryRun) {
      this.ctx.say(`${show ? '[dry-run] $' : '?'} ssh ${this.host} -- ${q(command)}`, show ? 0 : 1);
      return undefined;
    }
    return (await this.ctx.read('ssh', this.args(command))).trimEnd();
  }

  /** A check on the host: whether the command succeeds, or undefined under --dry-run. */
  async test(command: string, show = false): Promise<boolean | undefined> {
    if (this.ctx.dryRun) return this.read(command, show).then(() => undefined);
    return (await orAbsent(this.read(command, show))) !== undefined;
  }

  /** Close the shared connection; nothing to close when no call was made. */
  close(): Promise<void> {
    return this.ctx.apply([run('ssh', ['-o', `ControlPath=${this.socket}`, '-O', 'exit', this.host])]);
  }
}

/** A compose duration (Go's syntax: `1m30s`, `500ms`) in seconds, or undefined when it is not one. */
export function seconds(duration: unknown): number | undefined {
  if (typeof duration !== 'string' || !/^((\d+\.?\d*|\.\d+)(ns|us|µs|ms|s|m|h))+$/.test(duration)) return undefined;
  const unit: Record<string, number> = { ns: 1e-9, us: 1e-6, µs: 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600 };
  let total = 0;
  for (const [, n, u] of duration.matchAll(/(\d+\.?\d*|\.\d+)(ns|us|µs|ms|s|m|h)/g))
    total += Number(n) * (unit[u as string] ?? 0);
  return total;
}

/**
 * Why the healthcheck would be seen healthy late, or not at all within a
 * wait of `budget` seconds: without `start_interval`, or once a short
 * `start_period` is over, Docker probes only every `interval`. Undefined when
 * the timing keys cover the wait; a value the verb cannot read is left to compose.
 */
export function slowStart(check: Mapping, budget: number): string | undefined {
  if (check.start_interval == null) return 'sets no start_interval';
  const period = check.start_period == null ? 0 : seconds(check.start_period);
  if (period !== undefined && period < budget)
    return `has a start_period of ${period}s, under the deploy's ${budget}s wait`;
  return undefined;
}

/** What every host-side step works with: one connection, the app dir's commands, and the result filled in as they go. */
interface Session {
  ctx: Context;
  remote: Remote;
  /** The app dir, quoted for the remote shell. */
  D: string;
  /** compose in the app dir, against the file it serves. */
  dc: string;
  /** compose in the app dir, against the staged file. */
  dci: string;
  /** The running `web` container's image, or nothing. */
  liveImage: string;
  image?: string;
  result: Deploy;
}

/** Deploy from the checkout at `dir`: read, render, then the host-side steps in order. */
export async function deploy(ctx: Context, options: DeployOptions): Promise<Deploy> {
  const { host, app } = options;
  const dir = options.dir ?? '.';
  const image = options.image || undefined;
  const environment = options.environment || DEFAULT_ENVIRONMENT;
  const appDir = options.appDir || defaultAppDir(app, environment);
  const source = options.source || `apps/${app}`;
  const retries = options.retries ?? 30;

  // The run shape, from the invoking checkout (§ 2 PLX-App).
  let compose: string | undefined;
  let text = '';
  for (const candidate of [`${source}/docker/compose.yaml`, `${source}/compose.yaml`]) {
    try {
      text = await ctx.readFile(join(dir, candidate));
      compose = candidate;
      break;
    } catch {}
  }
  if (compose === undefined)
    throw new UsageError(`no compose.yaml under ${source}; run from the app's source repo (§ 2 PLX-App)`);
  const rendered = renderCompose(text, image, compose);
  // The wait's budget: `retries` looks, two seconds apart.
  const budget = retries * 2;
  const check = healthcheckOf(parseCompose(rendered, compose));
  if (!declaresHealthcheck(check))
    throw new UsageError(
      `${compose}: the web service declares no healthcheck with a test of its own, and the deploy waits for it to turn healthy (PLX-App/Healthcheck); ` +
        `\`include\` and \`extends\` of another file are not followed, and an image's own HEALTHCHECK does not count; to use it, declare it here:\n` +
        `    healthcheck: { test: [CMD, <the image's check command>], start_period: ${budget}s, start_interval: 1s }`,
    );
  const slow = slowStart(check, budget);

  ctx.say(`→ deploying ${image ?? '<image pinned in compose.yaml>'}`);
  ctx.say(`  host:    ${host}`);
  ctx.say(`  dir:     ${appDir}`);
  ctx.say(`  compose: ${compose}`);
  ctx.say('  health:  the healthcheck of service web, as Docker reports it');
  if (slow)
    ctx.say(
      `⚠ ${compose}: the web healthcheck ${slow}, so Docker may probe it only every interval while the deploy waits, which then sees it healthy late or rolls it back; set start_interval: 1s and start_period: ${budget}s`,
    );

  const D = q(appDir);
  // The staged compose file, read in place: --project-directory keeps .env and
  // relative paths resolving against the app dir, so pull and migrate run
  // against the new run shape while the host keeps serving from the old one.
  const dc = `cd ${D} && docker compose`;
  const s: Session = {
    ctx,
    remote: new Remote(ctx, host),
    D,
    dc,
    dci: `${dc} --project-directory . -f ${INCOMING}/compose.yaml`,
    // One `web` container is assumed, hence `head -1`: the app contract binds
    // one fixed loopback port (§ 4 PLX-App), which a second replica could not.
    liveImage: `${dc} ps -q web 2>/dev/null | head -1 | xargs -r docker inspect --format '{{.Config.Image}}' 2>/dev/null || true`,
    image,
    result: { host, appDir, compose, image, healthy: false, rolledBack: false },
  };
  const { result } = s;
  let staged = false;
  try {
    await stage(s, rendered);
    staged = true;
    result.previous = (await s.remote.read(s.liveImage)) || undefined;
    ctx.say(`  previous: ${result.previous ?? (ctx.dryRun ? '<read on host>' : '<none>')}`);
    if (await alreadyServing(s)) return result;
    await pullAndMigrate(s);
    const hadPrev = await swapAndUp(s);

    const started = Date.now();
    if ((await awaitHealthy(s, retries, true)) !== false) {
      result.live = (await s.remote.read(s.liveImage)) || image;
      result.healthy = true;
      if (ctx.dryRun) ctx.say('  (on failure: restore the previous compose.yaml, up -d --remove-orphans, wait again)');
      else ctx.done(`${result.live ?? 'the app'} is live and healthy`);
      return result;
    }
    ctx.say(`✗ healthcheck failed after ${Math.round((Date.now() - started) / 1000)}s; last lines from the app:`);
    const logs = await s.remote.read(`${dc} logs --no-color --tail 50 web 2>&1 || true`);
    if (logs) ctx.say(logs.replace(/^/gm, '    '));
    await rollback(s, hadPrev, retries);
    return result;
  } finally {
    // The staged run shape and the rollback copy are gone on exit, whatever
    // happened; the shared connection with them.
    if (staged) await s.remote.exec(`rm -rf ${D}/${INCOMING}`).catch(() => undefined);
    await s.remote.close().catch(() => undefined);
  }
}

/**
 * Stage the rendered file into a verb-owned dir inside the app dir; only the
 * file is written, never the dir's own mode, which the playbook set. Nothing
 * the host runs from is touched until pull and migrate have passed.
 */
async function stage(s: Session, rendered: string): Promise<void> {
  const { D } = s;
  await s.remote.exec(
    `rm -rf ${D}/${INCOMING} && mkdir -p ${D}/${INCOMING} && cat > ${D}/${INCOMING}/compose.yaml`,
    rendered,
  );
}

/**
 * The same image from the same run shape, healthy: nothing to do, and a
 * promotion that changed another app leaves this one running. Decided from
 * the host (the live container, the file it serves), never from a record.
 */
async function alreadyServing(s: Session): Promise<boolean> {
  const { ctx, result } = s;
  if (ctx.dryRun) {
    ctx.say('  (nothing more runs when the host already serves this image from this file, healthy)');
    return false;
  }
  // A third-party app passes no ref: its file pins the image, so the same
  // file with `web` running is the same deployment, and a platform repo can
  // deploy every app on every push without restarting any.
  if (!(s.image ? result.previous === s.image : result.previous !== undefined)) return false;
  if (!(await s.remote.test(`cd ${s.D} && cmp -s compose.yaml ${INCOMING}/compose.yaml`))) return false;
  if (!(await awaitHealthy(s, 1))) return false;
  result.live = result.previous;
  result.healthy = true;
  result.unchanged = true;
  ctx.done(`${result.previous} is already live and healthy; nothing to do`);
  return true;
}

/**
 * Pull → migrate (idempotent; runs only if compose.yaml declares it), both
 * against the STAGED run shape: a failure here leaves the host exactly as it
 * was. Every non-profiled service is pulled, not just `web`.
 */
async function pullAndMigrate(s: Session): Promise<void> {
  await s.remote.exec(`${s.dci} pull`);
  // `compose run` targets the service regardless of its profile; the --profile
  // flag is only needed for the existence check, since `config --services`
  // hides profiled services by default. stdin from /dev/null: `compose run`
  // is interactive by default and would wait on a terminal that is not there.
  const migrate = await s.remote.test(`${s.dci} --profile migrate config --services 2>/dev/null | grep -qx migrate`);
  if (migrate === undefined) s.ctx.say('  (if compose.yaml declares a migrate service:)');
  if (migrate !== false) await s.remote.exec(`${s.dci} run --rm migrate </dev/null`);
}

/**
 * Swap the run shape into place, keeping the previous one for rollback until
 * this run ends, and bring it up. Whether there was a previous file (undefined
 * under --dry-run).
 */
async function swapAndUp(s: Session): Promise<boolean | undefined> {
  const { D } = s;
  const hadPrev = await s.remote.test(`test -f ${D}/compose.yaml`);
  if (hadPrev !== false) await s.remote.exec(`cd ${D} && cp -p compose.yaml ${INCOMING}/compose.yaml.prev`);
  await s.remote.exec(`cd ${D} && mv ${INCOMING}/compose.yaml compose.yaml`);
  // No pull here: the new image was pulled above, the previous one is in the
  // host's cache; a rollback must never depend on the registry answering.
  // --remove-orphans: a service the new shape dropped goes with it, and a
  // rollback drops the containers a failed shape started (a dependency the
  // migrate step brought up), which would otherwise keep a stale network
  // and break the next attempt.
  await s.remote.exec(`${s.dc} up -d --remove-orphans`);
  return hadPrev;
}

/**
 * Wait for the `web` container to turn healthy, as Docker reports it from the
 * healthcheck the compose file declares (PLX-App/Healthcheck): reality, read
 * from the running container, two seconds between looks. Whether it did
 * (undefined under --dry-run, where `show` prints the line).
 */
function awaitHealthy(s: Session, attempts: number, show = false): Promise<boolean | undefined> {
  // One `web` container is assumed, hence `head -1`: the app contract binds
  // one fixed loopback port (§ 4 PLX-App), which a second replica could not.
  const status = `docker compose ps -q web 2>/dev/null | head -1 | xargs -r docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null`;
  return s.remote.test(
    `cd ${s.D} && for _ in $(seq 1 ${attempts}); do [ "$(${status})" = healthy ] && exit 0; sleep 2; done; exit 1`,
    show,
  );
}

/**
 * Rollback: the previous compose file, image pinned, so it is the combination
 * that was actually serving. There is something to go back to when the file
 * changed with a container running; a first deploy, or a re-deploy of the
 * very same run shape, has no previous state and fails loudly instead.
 */
async function rollback(s: Session, hadPrev: boolean | undefined, retries: number): Promise<void> {
  const { ctx, D, result } = s;
  const differs = hadPrev && (await s.remote.test(`cd ${D} && ! cmp -s compose.yaml ${INCOMING}/compose.yaml.prev`));
  if (!differs) {
    ctx.done(
      'nothing to roll back to (first deploy, or the same run shape re-deployed); manual intervention needed',
      false,
    );
    return;
  }
  await s.remote.exec(`cd ${D} && cp -p ${INCOMING}/compose.yaml.prev compose.yaml`);
  ctx.say(`↩ rolling back to ${result.previous ?? 'the previous compose.yaml'}`);
  await s.remote.exec(`${s.dc} up -d --remove-orphans`);
  result.rolledBack = true;
  if (await awaitHealthy(s, retries)) {
    result.live = result.previous;
    ctx.done(`rolled back to ${result.previous ?? 'the previous compose.yaml'}`);
  } else {
    ctx.done('rollback also unhealthy; manual intervention needed', false);
  }
}
