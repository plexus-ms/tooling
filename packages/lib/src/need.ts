// need: which version, if any, a repo takes now (§ 3 PLX-Updates). Cutting a
// version and a repo taking it are separate events. The step of the version
// number says how urgent it is:
//
//   patch  a hotfix: taken at once
//   minor  routine: taken once the oldest version the repo has not taken is as
//          old as its interval (7 days unless its root marker says
//          otherwise; zero takes every version)
//   major  a contract changed: taken only when asked, with the migration note
//
// Within the repo's major, any pending patch release is a hotfix: the newest
// one is taken at once, and since ship tags main it carries every version
// before it. The newest of the major is taken only once the interval is due.
// A newer major is named in one line and never taken unasked. Asking (`--now`,
// `--to`, a manual run of the workflow) takes the newest version whatever its
// step, and is decided by the caller; this file decides an unasked run.
//
// While nothing is taken the repo rests on the version it has, which its
// immutable pins make safe (§ 1.6 PLX). Pure: the caller reads the releases,
// the answers and the clock.
import { compareVersions, isPlexusVersion } from './version.ts';

/** The interval, in days, of a repo whose answers do not set one. */
export const DEFAULT_MAX_AGE = 7;
/** The answer of the repo templates that sets the interval, in days. */
export const MAX_AGE_ANSWER = 'update_max_age';

/** A version as the forge knows it: its number and when its release was published. */
export interface Release {
  version: string;
  /** ISO 8601, as the forge gives it. */
  published: string;
}

/** `held`, when set, names a version of a newer major that waits to be asked for. */
export type Need =
  /** Take `version`; `why` is a clause for the narration and the pull request. */
  | { take: true; version: string; why: string; held?: string }
  /** Rest on the version the repo has; `why` says what would end the rest. */
  | { take: false; why: string; held?: string };

export interface NeedInput {
  /** The version the repo records: its root marker's `version` (update.ts), one for all its sites. */
  recorded: (string | undefined)[];
  /** The template's releases, in any order. */
  releases: Release[];
  /** The interval in days. */
  maxAge: number;
  now: Date;
}

const DAY = 24 * 60 * 60 * 1000;
const days = (n: number): string => `${n} day${n === 1 ? '' : 's'}`;
const parts = (v: string): [number, number, number] => {
  const [major = 0, minor = 0, patch = 0] = v.split('.').map(Number);
  return [major, minor, patch];
};
const newest = (versions: string[]): string => versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));

export function needOf({ recorded, releases, maxAge, now }: NeedInput): Need {
  const versions = releases.map((r) => r.version).filter(isPlexusVersion);
  const known = recorded.filter((r): r is string => !!r && isPlexusVersion(r));
  const majorOf = (v: string) => parts(v)[0];
  const heldBeyond = (major: number) => {
    const beyond = versions.filter((v) => majorOf(v) > major);
    return beyond.length > 0 ? `${newest(beyond)} is a new major, taken only when asked` : undefined;
  };

  // A site that records no version (a commit, a branch) cannot be placed among
  // the releases: it is brought onto the newest version of the major the other
  // sites record, at once; with no site to say which major, nothing is taken.
  const odd = recorded.findIndex((r) => !r || !isPlexusVersion(r));
  if (recorded.length === 0 || odd >= 0) {
    const what = `a site records ${recorded[odd] ? `'${recorded[odd]}'` : 'no version'}, not a version`;
    if (known.length === 0) return { take: false, why: `${what}, and no site records one` };
    const major = majorOf(newest(known));
    const within = versions.filter((v) => majorOf(v) === major);
    const held = heldBeyond(major);
    if (within.length === 0) return { take: false, why: held ?? `${what}, and no version of its major is released` };
    return { take: true, version: newest(within), why: what, ...(held ? { held } : {}) };
  }

  // The repo is measured by the site furthest behind.
  const on = known.reduce((a, b) => (compareVersions(a, b) <= 0 ? a : b));
  const major = majorOf(on);
  const held = heldBeyond(major);
  // A date the forge gives that does not parse counts as old enough.
  const time = (r: Release) => {
    const t = Date.parse(r.published);
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
  };
  const within = releases
    .filter((r) => isPlexusVersion(r.version) && majorOf(r.version) === major && compareVersions(r.version, on) > 0)
    .sort((a, b) => time(a) - time(b));
  const oldest = within[0];
  // When the major is the only thing pending, it is the reason, said once.
  if (!oldest) return { take: false, why: held ?? `no version newer than ${on}` };
  const pending = within.map((r) => r.version);
  const target = newest(pending);
  const count = (upTo: string) => {
    const n = pending.filter((v) => compareVersions(v, upTo) <= 0).length;
    return `${n} newer version${n === 1 ? '' : 's'}`;
  };
  const also = held ? { held } : {};

  const age = Math.max(0, Math.floor((now.getTime() - time(oldest)) / DAY));
  if (maxAge === 0)
    return { take: true, version: target, why: `an interval of zero takes every version (${count(target)})`, ...also };
  if (time(oldest) === Number.NEGATIVE_INFINITY)
    return {
      take: true,
      version: target,
      why: `${oldest.version} has no readable release date ('${oldest.published}'), so it counts as old enough (${count(target)})`,
      ...also,
    };
  if (age >= maxAge)
    return {
      take: true,
      version: target,
      why: `${oldest.version}, the oldest version not taken, was cut ${days(age)} ago (interval: ${days(maxAge)}; ${count(target)})`,
      ...also,
    };

  const hotfixes = pending.filter((v) => parts(v)[2] > 0);
  if (hotfixes.length > 0) {
    const fix = newest(hotfixes);
    const rest = fix === target ? '' : `; ${target} waits for the interval`;
    return { take: true, version: fix, why: `${fix} is a hotfix, taken at once (${count(fix)})${rest}`, ...also };
  }
  return {
    take: false,
    why: `${count(target)}, the oldest (${oldest.version}) cut ${days(age)} ago; the interval is ${days(maxAge)}`,
    ...also,
  };
}

/** The interval a repo's answers set, or the default; a value that is not a whole number of days is refused. */
export function maxAgeOf(answers: Record<string, unknown>): number {
  const value = answers[MAX_AGE_ANSWER];
  if (value === undefined || value === null || value === '') return DEFAULT_MAX_AGE;
  return parseMaxAge(String(value), `the answer ${MAX_AGE_ANSWER}`);
}

export function parseMaxAge(value: string, what: string): number {
  if (!/^\d+$/.test(value.trim())) throw new Error(`${what} is '${value}', not a whole number of days`);
  return Number(value.trim());
}
