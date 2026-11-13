
export const MAX_PENDING_REFERENCE_ATTEMPTS = 6;

export const PENDING_REFERENCE_TTL_MS =
  30 * 60 * 1000;

const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 5 * 60 * 1000;

/**
 * Returns the delay after a failed attempt.
 *
 * Attempt 1: 5 seconds
 * Attempt 2: 10 seconds
 * Attempt 3: 20 seconds
 * Attempt 4: 40 seconds
 * Attempt 5: 80 seconds
 * Attempt 6: 160 seconds
 */
export function pendingReferenceRetryDelayMs(
  attempts: number,
): number {
  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 1
  ) {
    throw new Error(
      'Retry attempts must be a positive integer',
    );
  }

  return Math.min(
    BASE_DELAY_MS * 2 ** (attempts - 1),
    MAX_DELAY_MS,
  );
}

/**
 * Defines when an unresolved reference
 * must stop being retried.
 */
export function shouldRejectPendingReference(
  attempts: number,
  createdAt: Date,
  now: Date,
): boolean {
  const expired =
    now.getTime() - createdAt.getTime() >=
    PENDING_REFERENCE_TTL_MS;

  return (
    attempts >= MAX_PENDING_REFERENCE_ATTEMPTS ||
    expired
  );
}

/**
 * Calculates the next scheduled retry.
 */
export function nextPendingReferenceRetryAt(
  attempts: number,
  now: Date,
): Date {
  return new Date(
    now.getTime() +
      pendingReferenceRetryDelayMs(attempts),
  );
}
