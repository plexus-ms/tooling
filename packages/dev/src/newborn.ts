// newborn: a version ships only when every template passes as a newborn repo.
// The templates are where the approaches are verified, so ship's last
// preflight, before phase one, renders each template being cut as a new repo
// would get it and judges the result twice: the template's own newborn test
// (`mise run verify` in its checkout, which renders it in every shape and runs
// the newborn's `check` or `lint`), and the doctor over every rendered newborn.
//
// The doctor is the one being cut: plx-dev runs from the source of the tooling
// checkout it cuts, so `examine` and `diagnose` are that source's, and the
// requirement names a deviation may list are read from the compendium being
// cut, not the index this build carries (which lags it until ship writes it).
//
// The newborns are got at through what each template's test already offers:
// under `KEEP=1` it leaves the rendered repos in place and prints `kept: <dir>`,
// either one repo (the app template's, with the apps inside) or a directory
// of repos, one per shape. The test runs with TMPDIR pointing into a scratch
// directory this run makes and owns, and every template makes its own under
// TMPDIR, so whatever it leaves goes with that directory. Nothing outside
// the scratch is examined or deleted: a `kept:` path elsewhere, or one that
// is not an existing directory, leaves the template unexamined and named, and
// whatever is there is left alone. The scratch goes on every way out: a
// normal end, an error, and SIGINT or SIGTERM. The test may run for
// VERIFY_LIMIT; a test still running then is killed with everything it
// started, and the template refused with the last lines of its log. The app
// template renders around the Turborepo template: `TURBO_TEMPLATE` names the
// checkout being cut, at HEAD, so the two are tested together.
//
// Like the consumers' preview, the work goes through `Context.stage`: it runs
// under a dry run too, since nothing the operator owns changes, and the dry run
// is meant to show everything that would stop the real one. It needs what the
// templates' tests need, the network among it (a newborn installs its
// packages); offline, ship has already stopped at its first fetch from origin.
import { rmSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
  COMPENDIUM,
  type Context,
  diagnose,
  ExecError,
  examine,
  type Finding,
  knownRequirements,
  onInterrupt,
  REQUIREMENT_NAME,
  readCitable,
  run,
  TEMPLATES,
  TimeoutError,
} from '@plexus-ms/lib';
import type { Versioned, VersionedRepo } from './version.ts';

/** The template whose newborn the app template is rendered into. */
const TURBO = 'template-repo-turbo';
/** The template rendered into a newborn of the Turborepo template. */
const APP = 'template-app-nextjs';

/** How many lines of a failing test's output the refusal quotes. */
const QUOTED = 12;

/**
 * How long a template's newborn test may run, in milliseconds. Generous, well
 * beyond what a working test takes: one still running then has hung (a
 * prompt nobody answers, a server that never exits), and ship would hang
 * silently with it.
 */
export const VERIFY_LIMIT = 10 * 60 * 1000;

/** What the newborn test's output says: where it stopped, why, and where it left the newborns. */
export interface VerifyLog {
  /** The last step it announced (`→ <shape>: <step>`), the one a failure stopped in. */
  step?: { shape: string; what: string };
  /** The directory `kept: <dir>` named. */
  kept?: string;
  /**
   * The lines that say why it failed: those after the last announced step that
   * name an error or a failure, without mise's chain of `[task] ERROR task
   * failed`; the last lines of the output when none does.
   */
  cause: string[];
  /** The time limit it ran past, in milliseconds, when it was killed for it; `cause` is then the log's last lines. */
  killedAfter?: number;
}

const ERROR = /\berror\b|\bfail(ed|s)?\b|✗|couldn't|cannot|refus/i;
const TASK_CHAIN = /^\[[^\]]*\] ERROR task failed$/;

export function parseVerifyLog(text: string): VerifyLog {
  const lines = text.split('\n').map((l) => l.trimEnd());
  let step: VerifyLog['step'];
  let from = 0;
  let kept: string | undefined;
  lines.forEach((line, i) => {
    const announced = /^→ (\S+): (.+)$/.exec(line);
    if (announced) {
      step = { shape: announced[1] ?? '', what: announced[2] ?? '' };
      from = i + 1;
    }
    const left = /^kept: (.+)$/.exec(line);
    if (left) kept = left[1];
  });
  const named = lines.slice(from).filter((l) => ERROR.test(l) && !TASK_CHAIN.test(l) && !/^kept: /.test(l));
  const cause = (named.length > 0 ? named : lines.filter(Boolean)).slice(-QUOTED);
  return { ...(step ? { step } : {}), ...(kept ? { kept } : {}), cause };
}

/** A newborn that fails the doctor: the shape as its path under where the test left it, and what fails. */
export interface NewbornFinding {
  newborn: string;
  findings: Finding[];
}

/** One template's outcome. */
export interface TemplateOutcome {
  template: string;
  /** The test's own failure, when it failed. */
  verify?: VerifyLog;
  /** The newborns the doctor examined, by name. */
  examined: string[];
  /** Those that fail a doctor check. */
  doctor: NewbornFinding[];
  /** Why the doctor could not examine the newborns, when it could not. */
  unexamined?: string;
  /** The command that reproduces the test, in the template's checkout. */
  reproduce: string;
}

const failed = (o: TemplateOutcome): boolean => o.verify !== undefined || o.doctor.length > 0 || !!o.unexamined;

/**
 * Every template being cut passes its newborn test, and every newborn it
 * renders passes the doctor; else the version is refused before anything is
 * written, naming the template, the shape and what fails. A template already
 * tagged with the version is no longer being cut (a re-run) and is skipped.
 */
export async function preflightNewborns(
  ctx: Context,
  versioned: Versioned,
  next: string,
  limit = VERIFY_LIMIT,
): Promise<void> {
  const templates = versioned.repos.filter((r) => TEMPLATES.includes(r.name) && r.latest !== next);
  if (templates.length === 0) return;
  const known = await requirementsBeingCut(ctx, versioned);
  const turbo = versioned.repos.find((r) => r.name === TURBO);
  ctx.say(`→ the templates as newborns: ${templates.map((t) => t.name).join(', ')}`);
  const outcomes: TemplateOutcome[] = [];
  for (const template of templates) outcomes.push(await newborns(ctx, template, turbo, known, limit));
  const failing = outcomes.filter(failed);
  if (failing.length === 0) return;
  throw new Error(
    [
      `${count(failing.length, 'template')} ${failing.length === 1 ? 'fails' : 'fail'} as a newborn repo:`,
      ...failing.flatMap(renderOutcome),
      'a version ships only when every template passes as a newborn: fix the template and commit, then cut the version',
    ].join('\n'),
  );
}

/** The requirement names a deviation may list: the compendium being cut's, else this build's index. */
async function requirementsBeingCut(ctx: Context, versioned: Versioned): Promise<Set<string>> {
  const compendium = versioned.repos.find((r) => r.name === COMPENDIUM);
  if (!compendium) return knownRequirements();
  const name = new RegExp(`^${REQUIREMENT_NAME}$`);
  return new Set((await readCitable(ctx, compendium.path)).filter((c) => name.test(c)));
}

async function newborns(
  ctx: Context,
  template: VersionedRepo,
  turbo: VersionedRepo | undefined,
  known: Set<string>,
  limit: number,
): Promise<TemplateOutcome> {
  const env: NodeJS.ProcessEnv = { KEEP: '1' };
  if (template.name === APP && turbo) Object.assign(env, { TURBO_TEMPLATE: turbo.path, TURBO_REF: 'HEAD' });
  const reproduce = `(cd ${template.path} && ${Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')} mise run verify)`;
  const outcome: TemplateOutcome = { template: template.name, examined: [], doctor: [], reproduce };
  const scratch = await makeScratch(ctx);
  const release = onInterrupt(() => rmSync(scratch, { recursive: true, force: true }));
  try {
    const log = join(scratch, 'verify.log');
    ctx.say(
      `  ${template.name}: mise run verify${env.TURBO_TEMPLATE ? ` (around ${TURBO} at ${env.TURBO_TEMPLATE})` : ''}`,
    );
    ctx.say(`    its output, while it runs: ${log}`);
    // The output goes to a file whatever the verbosity: it is read for where
    // the newborns were left, and quoted when the test fails.
    let passed = true;
    let killed = false;
    try {
      await ctx.stage(
        run('sh', ['-c', 'mise run verify >"$0" 2>&1', log], {
          cwd: template.path,
          env: { ...env, TMPDIR: scratch },
          timeout: limit,
        }),
      );
    } catch (error) {
      if (!(error instanceof ExecError)) throw error;
      passed = false;
      killed = error instanceof TimeoutError;
    }
    const text = await ctx.readFile(log).catch(() => '');
    const read = parseVerifyLog(text);
    if (killed)
      outcome.verify = { ...read, cause: text.split('\n').filter(Boolean).slice(-QUOTED), killedAfter: limit };
    else if (!passed) outcome.verify = read;
    const kept = read.kept === undefined ? undefined : resolve(template.path, read.kept);
    const unusable = kept === undefined ? undefined : await outsideOrMissing(ctx, kept, scratch);
    if (kept === undefined) {
      outcome.unexamined = passed
        ? 'the newborn test passed but named no directory it left them in (`kept: <dir>` under KEEP=1)'
        : 'the newborn test stopped before it named where it left them';
    } else if (unusable) {
      outcome.unexamined = unusable;
    } else {
      try {
        await examineNewborns(ctx, kept, known, outcome);
      } catch (error) {
        outcome.unexamined = `plx doctor could not examine ${kept}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (!failed(outcome)) ctx.say(`  ✓ ${template.name}: ${outcome.examined.join(', ')}`);
    return outcome;
  } finally {
    await ctx.stage(run('rm', ['-rf', scratch]));
    release();
  }
}

/** A scratch directory of this run's own; refuses to go on without one, since its path is where the test writes. */
async function makeScratch(ctx: Context): Promise<string> {
  const made = (await ctx.stage(run('mktemp', ['-d'])))?.trim() ?? '';
  const exists =
    isAbsolute(made) &&
    (await ctx.readDir(made).then(
      () => true,
      () => false,
    ));
  if (!exists)
    throw new Error(
      `mktemp -d gave ${made ? `\`${made}\`, not an existing directory` : 'no path'}; the newborn test is not run without a scratch directory of its own`,
    );
  return made;
}

/**
 * Why the newborns cannot be examined where the test said it left them, if
 * they cannot: only an existing directory inside this run's scratch is read.
 * Whatever is elsewhere was not made by this run, and is left alone.
 */
async function outsideOrMissing(ctx: Context, kept: string, scratch: string): Promise<string | undefined> {
  const real = async (path: string) => realpath(path).catch(() => path);
  if (!isWithin(kept, scratch) && !isWithin(await real(kept), await real(scratch)))
    return `the newborn test left them outside its scratch directory, in ${kept}, which is left alone`;
  const readable = await ctx.readDir(kept).then(
    () => true,
    () => false,
  );
  return readable ? undefined : `the newborn test named ${kept}, which is not a directory that can be read`;
}

/** The doctor over what the test left: one repo with its apps, or a directory of repos, one per shape. */
async function examineNewborns(ctx: Context, kept: string, known: Set<string>, outcome: TemplateOutcome) {
  const { root, inRepo, facts } = await examine(ctx, kept);
  const report = diagnose(facts, known);
  if (report.units.length === 0) {
    outcome.unexamined = `no Plexus repo where the newborn test left them (${kept})`;
    return;
  }
  const name = (path: string): string =>
    inRepo ? (path === '.' ? basename(root) : `${basename(root)}/${path}`) : path;
  for (const unit of report.units) {
    outcome.examined.push(name(unit.path));
    if (unit.findings.length > 0) outcome.doctor.push({ newborn: name(unit.path), findings: unit.findings });
  }
}

const isWithin = (path: string, dir: string): boolean => {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

function renderOutcome(o: TemplateOutcome): string[] {
  const lines = [`  ${o.template}:`];
  if (o.verify) {
    const at = o.verify.step ? ` at ${o.verify.step.shape}: ${o.verify.step.what}` : '';
    const what =
      o.verify.killedAfter === undefined
        ? `fails${at}`
        : `did not finish within ${minutes(o.verify.killedAfter)} and was killed${at}; the last lines of its output:`;
    lines.push(`    ✗ its newborn test ${what}`, ...o.verify.cause.map((l) => `      │ ${l}`));
  }
  for (const n of o.doctor) {
    lines.push(`    ✗ newborn ${n.newborn} fails plx doctor: ${count(n.findings.length, 'finding')}`);
    lines.push(...n.findings.map((f) => `      ✗ ${f.requirement}: ${f.problem}`));
  }
  const passing = o.examined.filter((n) => !o.doctor.some((d) => d.newborn === n));
  if (passing.length > 0) lines.push(`    ✓ plx doctor passes ${passing.join(', ')}`);
  if (o.unexamined) lines.push(`    ${o.verify ? '•' : '✗'} plx doctor examined no newborn: ${o.unexamined}`);
  lines.push(`    to reproduce: ${o.reproduce}`);
  return lines;
}

const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? '' : 's'}`;

const minutes = (ms: number): string =>
  ms >= 60_000 && ms % 60_000 === 0 ? count(ms / 60_000, 'minute') : `${ms / 1000} seconds`;
