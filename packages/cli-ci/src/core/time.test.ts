import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deadline, iso, month, registryBuckets, turboBucket } from './time.ts';

const now = new Date('2026-11-04T10:40:27.123Z');

test('iso drops the milliseconds and keeps the Z', () => {
  assert.equal(iso(now), '2026-11-04T10:40:27Z');
});

test('a deadline is minutes from now, in UTC', () => {
  assert.equal(deadline(now, 5), '2026-11-04T10:45:27Z');
  assert.equal(deadline(now, 30), '2026-11-04T11:10:27Z');
});

test('months roll over the year', () => {
  assert.equal(month(now), '2026-11');
  assert.equal(month(now, -1), '2026-10');
  assert.equal(month(new Date('2026-01-15T00:00:00Z'), -1), '2025-12');
  assert.equal(month(new Date('2026-01-15T00:00:00Z'), -2), '2025-11');
});

test('the bucket names follow the convention', () => {
  assert.deepEqual(registryBuckets('acme', now), {
    current: 'acme-ci-registry-2026-11',
    previous: 'acme-ci-registry-2026-10',
    expired: 'acme-ci-registry-2026-09',
  });
  assert.equal(turboBucket('acme'), 'acme-ci-turbo');
});
