// The baseline: a repo's known violations of the lints (lints.ts), recorded
// when a lint lands on a tree that already breaks it, and burned down from
// there. One key per line (`<lint> <file>: <excerpt>`, a key repeated as often
// as it occurs), sorted; `plx requirements --write-baseline` writes it. The
// check fails on a violation the baseline does not hold, and on an entry that
// no longer occurs, so a fixed violation leaves the list in the same commit.
import { keyOf, type Violation } from './lints.ts';

export const BASELINE_FILE = 'plx-baseline.txt';

const HEADER = [
  '# Known violations of `plx requirements`: burn them down, never add to them.',
  '# One per line, as often as each occurs; `plx requirements --write-baseline` rewrites the file.',
];

/** The keys a baseline holds, comments and blank lines left out. */
export const parseBaseline = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l !== '' && !l.startsWith('#'));

export const renderBaseline = (violations: Violation[]): string =>
  `${[...HEADER, ...violations.map(keyOf).sort()].join('\n')}\n`;

export interface Compared {
  /** Violations the baseline does not hold. */
  fresh: Violation[];
  /** Baseline entries that no longer occur, once per missing occurrence. */
  stale: string[];
  /** Violations the baseline holds. */
  known: number;
}

/** The violations against the baseline, counted as multisets: a key baselined twice covers two occurrences. */
export function compareBaseline(violations: Violation[], baseline: string[]): Compared {
  const left = new Map<string, number>();
  for (const key of baseline) left.set(key, (left.get(key) ?? 0) + 1);
  const fresh: Violation[] = [];
  let known = 0;
  for (const v of violations) {
    const n = left.get(keyOf(v)) ?? 0;
    if (n > 0) {
      left.set(keyOf(v), n - 1);
      known++;
    } else fresh.push(v);
  }
  const stale = [...left].flatMap(([key, n]) => Array<string>(n).fill(key));
  return { fresh, stale: stale.sort(), known };
}
