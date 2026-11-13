
import {
  describe,
  expect,
  test,
} from 'bun:test';

import {
  MAX_PENDING_REFERENCE_ATTEMPTS,
  PENDING_REFERENCE_TTL_MS,
  nextPendingReferenceRetryAt,
  pendingReferenceRetryDelayMs,
  shouldRejectPendingReference,
} from '../../src/modules/wagering/application/pending-reference-policy';

describe('Pending Reference Retry Policy', () => {
  test('uses exponential backoff', () => {
    expect(pendingReferenceRetryDelayMs(1)).toBe(5_000);
    expect(pendingReferenceRetryDelayMs(2)).toBe(10_000);
    expect(pendingReferenceRetryDelayMs(3)).toBe(20_000);
    expect(pendingReferenceRetryDelayMs(4)).toBe(40_000);
    expect(pendingReferenceRetryDelayMs(5)).toBe(80_000);
    expect(pendingReferenceRetryDelayMs(6)).toBe(160_000);
  });

  test('rejects invalid attempt numbers', () => {
    expect(() =>
      pendingReferenceRetryDelayMs(0),
    ).toThrow();

    expect(() =>
      pendingReferenceRetryDelayMs(-1),
    ).toThrow();
  });

  test('calculates the next retry date', () => {
    const now = new Date('2026-11-13T12:00:00Z');

    const next = nextPendingReferenceRetryAt(2, now);

    expect(next.toISOString()).toBe(
      '2026-11-13T12:00:10.000Z',
    );
  });

  test('allows retry before attempt limit', () => {
    const createdAt = new Date(
      '2026-11-13T12:00:00Z',
    );

    const now = new Date(
      '2026-11-13T12:05:00Z',
    );

    expect(
      shouldRejectPendingReference(
        2,
        createdAt,
        now,
      ),
    ).toBe(false);
  });

  test('rejects after maximum attempts', () => {
    const now = new Date();

    expect(
      shouldRejectPendingReference(
        MAX_PENDING_REFERENCE_ATTEMPTS,
        now,
        now,
      ),
    ).toBe(true);
  });

  test('rejects after TTL expires', () => {
    const now = new Date();

    const createdAt = new Date(
      now.getTime() -
        PENDING_REFERENCE_TTL_MS -
        1,
    );

    expect(
      shouldRejectPendingReference(
        1,
        createdAt,
        now,
      ),
    ).toBe(true);
  });
});
