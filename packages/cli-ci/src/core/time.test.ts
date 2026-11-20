import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deadline, iso, registryBuckets, turboBucket, week } from './time.ts';

const now = new Date('2026-11-04T10:40:27.123Z');

test('iso drops the milliseconds and keeps the Z', () => {
  assert.equal(iso(now), '2026-11-04T10:40:27Z');
});

test('a deadline is minutes from now, in UTC', () => {
  assert.equal(deadline(now, 5), '2026-11-04T10:45:27Z');
  assert.equal(deadline(now, 30), '2026-11-04T11:10:27Z');
});

test('weeks are ISO weeks in UTC and roll over the year', () => {
  assert.equal(week(now), '2026-w45');
  assert.equal(week(now, -1), '2026-w44');
  // Monday starts a week, Sunday ends it.
  assert.equal(week(new Date('2026-11-08T23:59:59Z')), '2026-w45');
  assert.equal(week(new Date('2026-11-09T00:00:00Z')), '2026-w46');
  // A week belongs to the year of its Thursday: 2026 has 53 weeks, 2025 ends in the first week of 2026.
  assert.equal(week(new Date('2027-01-03T12:00:00Z')), '2026-w53');
  assert.equal(week(new Date('2027-01-04T12:00:00Z')), '2027-w01');
  assert.equal(week(new Date('2027-01-04T12:00:00Z'), -1), '2026-w53');
  assert.equal(week(new Date('2027-01-04T12:00:00Z'), -2), '2026-w52');
  assert.equal(week(new Date('2025-12-29T00:00:00Z')), '2026-w01');
  assert.equal(week(new Date('2026-01-01T00:00:00Z'), -1), '2025-w52');
});

test('the bucket names follow the convention', () => {
  assert.deepEqual(registryBuckets('acme', now), {
    current: 'acme-ci-registry-2026-w45',
    previous: 'acme-ci-registry-2026-w44',
    expired: 'acme-ci-registry-2026-w43',
  });
  assert.equal(turboBucket('acme'), 'acme-ci-turbo');
});
