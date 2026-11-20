// The clock, in one place: deadlines as absolute UTC times (what the instance
// labels and the sweep compare), and the registry's week names (§ 8
// PLX-Delivery: writes to this week's bucket, reads this and the previous,
// the one before is deleted whole). Pure, so that the tests pin the arithmetic.

/** `2026-11-04T10:40:27Z`, the shape every label and log line uses. */
export function iso(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The absolute time `minutes` from `now`. */
export function deadline(now: Date, minutes: number): string {
  return iso(new Date(now.getTime() + minutes * 60_000));
}

/**
 * `YYYY-wWW`, the ISO week `offset` weeks from `now`'s (0 this week, -1 the
 * previous), in UTC: weeks start on Monday, and a week belongs to the year
 * its Thursday is in, as `date +%G-w%V` prints it.
 */
export function week(now: Date, offset = 0): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset * 7));
  // To the Thursday of the week, whose year is the week's.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const days = (d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000;
  return `${d.getUTCFullYear()}-w${String(Math.floor(days / 7) + 1).padStart(2, '0')}`;
}

/** The registry bucket names of one owner: by convention `<owner>-ci-registry-<YYYY-wWW>`. */
export function registryBuckets(owner: string, now: Date): { current: string; previous: string; expired: string } {
  const name = (offset: number) => `${owner}-ci-registry-${week(now, offset)}`;
  return { current: name(0), previous: name(-1), expired: name(-2) };
}

/** The Turbo cache bucket of one owner, `<owner>-ci-turbo`. */
export const turboBucket = (owner: string): string => `${owner}-ci-turbo`;
