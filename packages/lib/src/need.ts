// need: which version, if any, a repo takes now (§ 3 PLX-Updates). Cutting a
// version and a repo taking it are separate events: that a newer version exists
// is not a reason to take it. The version number says how urgent it is:
//
//   patch  a hotfix: taken at once
//   minor  routine: taken at the repo's next scheduled pull, once the oldest
//          version the repo has not taken is as old as its interval (7 days
//          unless its answers say otherwise; zero takes every version)
//   major  a contract changed: taken only when asked, with the migration note
//
// Asking (`--now`, `--to`, a manual run of the workflow) takes the newest
// version whatever its step, and is decided by the caller; this file decides an
// unasked run. A version of a newer major is never taken unasked: it is named in
// one line, and the decision goes on over the versions of the repo's own major.
// A patch counts as a hotfix for the repo when it repairs the minor line the
// repo is on, or when it is the newest version of the major; a hotfix of a line
// the repo never had does not hurry it. Whatever is taken is the newest of the
// major, over every version in between.
//
// While nothing is taken the repo rests on the version it has, which its
// immutable pins make safe (§ 1.6 PLX). Pure: the caller reads the releases,
// the answers and the clock.
import { compareVersions } from './doctor.ts';
import { isPlexusVersion } from './version.ts';

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
  /** What each site of the repo records as its version (the answers' `_commit`). */
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
  // A site that records no version (a commit, a branch) cannot be placed among
  // the releases; it is brought onto the newest version rather than left there.
  const odd = recorded.findIndex((r) => !r || !isPlexusVersion(r));
  if (recorded.length === 0 || odd >= 0) {
    const why = `a site records ${recorded[odd] ? `'${recorded[odd]}'` : 'no version'}, not a version`;
    return versions.length > 0 ? { take: true, version: newest(versions), why } : { take: false, why };
  }

  // The repo is measured by the site furthest behind.
  const on = (recorded as string[]).reduce((a, b) => (compareVersions(a, b) <= 0 ? a : b));
  const [major, minor] = parts(on);
  const pending = releases.filter((r) => isPlexusVersion(r.version) && compareVersions(r.version, on) > 0);
  if (pending.length === 0) return { take: false, why: `no version newer than ${on}` };

  const beyond = pending.filter((r) => parts(r.version)[0] !== major).map((r) => r.version);
  const held = beyond.length > 0 ? `${newest(beyond)} is a new major, taken only when asked` : undefined;
  const within = pending
    .filter((r) => parts(r.version)[0] === major)
    .sort((a, b) => Date.parse(a.published) - Date.parse(b.published));
  const oldest = within[0];
  if (!oldest) return { take: false, why: held ?? `no version newer than ${on}` };
  const target = newest(within.map((r) => r.version));
  const count = `${within.length} newer version${within.length === 1 ? '' : 's'}`;
  const also = held ? { held } : {};

  const hotfixes = within
    .map((r) => r.version)
    .filter((v) => parts(v)[2] > 0 && (parts(v)[1] === minor || v === target));
  if (hotfixes.length > 0)
    return { take: true, version: target, why: `${newest(hotfixes)} is a hotfix, taken at once (${count})`, ...also };

  const age = Math.max(0, Math.floor((now.getTime() - Date.parse(oldest.published)) / DAY));
  if (maxAge === 0)
    return { take: true, version: target, why: `an interval of zero takes every version (${count})`, ...also };
  if (age >= maxAge)
    return {
      take: true,
      version: target,
      why: `${oldest.version}, the oldest version not taken, was cut ${days(age)} ago (interval: ${days(maxAge)}; ${count})`,
      ...also,
    };
  return {
    take: false,
    why: `${count}, the oldest (${oldest.version}) cut ${days(age)} ago; the interval is ${days(maxAge)}`,
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
