
import { randomUUID } from 'node:crypto';

import {
  EntityManager,
  MikroORM,
} from '@mikro-orm/postgresql';

import { OutboxMessageRecord } from
  '../../../infrastructure/database/entities/outbox-message-record.entity';

import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../domain/wager-transaction';

import { ProcessReversalUseCase } from
  './process-reversal.use-case';

import {
  MAX_PENDING_REFERENCE_ATTEMPTS,
  PENDING_REFERENCE_TTL_MS,
  nextPendingReferenceRetryAt,
  shouldRejectPendingReference,
} from './pending-reference-policy';

interface Candidate {
  id: string;
  walletId: string;
}

interface PendingRow {
  id: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string;
  retryAttempts: number;
  createdAt: Date;
}

export type PendingReferenceResult =
  | 'processed'
  | 'rejected'
  | 'retry_scheduled'
  | 'expired'
  | 'skipped';

export interface PendingReferenceStats {
  processed: number;
  rejected: number;
  retryScheduled: number;
  expired: number;
  skipped: number;
}

async function expirePending(
  tx: EntityManager,
  row: PendingRow,
  attempts: number,
  now: Date,
): Promise<void> {
  const reason =
    attempts >= MAX_PENDING_REFERENCE_ATTEMPTS
      ? 'MAX_ATTEMPTS'
      : 'TTL_EXPIRED';

  await tx.execute(
    `UPDATE wager_transactions
     SET status = ?,
         failure_code = ?,
         processed_at = ?,
         retry_attempts = ?,
         last_retry_at = ?,
         next_retry_at = NULL
     WHERE id = ?
       AND status = ?`,
    [
      Status.Rejected,
      FailureCode.InvalidReference,
      now,
      attempts,
      now,
      row.id,
      Status.PendingReference,
    ],
  );

  const eventId = randomUUID();

  tx.persist(
    tx.create(OutboxMessageRecord, {
      id: eventId,
      aggregateId: row.walletId,
      eventType: 'WagerTransactionRejected',
      payload: {
        eventId,
        eventType: 'WagerTransactionRejected',
        aggregateId: row.walletId,
        correlationId: row.id,
        occurredAt: now.toISOString(),
        version: 1,
        data: {
          transactionId: row.id,
          kind: row.kind,
          status: Status.Rejected,
          failureCode: FailureCode.InvalidReference,
          reason,
          retryAttempts: attempts,
        },
      },
      occurredAt: now,
      attempts: 0,
    }),
  );

  await tx.flush();
}

/**
 * Processes one pending transaction.
 *
 * Lock order:
 * 1. Wallet
 * 2. Pending transaction
 *
 * All financial changes, retry metadata, and events
 * remain inside the same PostgreSQL transaction.
 */
export async function processPendingReferenceById(
  orm: MikroORM,
  id: string,
): Promise<PendingReferenceResult> {
  const expiresBefore = new Date(
    Date.now() - PENDING_REFERENCE_TTL_MS,
  );

  return orm.em.fork().transactional(
    async (tx): Promise<PendingReferenceResult> => {
      // Discover the wallet without locking the wager.
      const candidates = await tx.execute<Candidate[]>(
        `SELECT
           id,
           wallet_id AS "walletId"
         FROM wager_transactions
         WHERE id = ?
           AND status = ?`,
        [id, Status.PendingReference],
      );

      const candidate = candidates[0];

      if (!candidate) {
        return 'skipped';
      }

      // Lock wallet first, matching the financial use cases.
      const wallets = await tx.execute<
        Array<{ id: string }>
      >(
        `SELECT id
         FROM wallets
         WHERE id = ?
         FOR UPDATE`,
        [candidate.walletId],
      );

      if (wallets.length === 0) {
        throw new Error(
          `Pending reference wallet not found: ${id}`,
        );
      }

      // Lock and recheck the wager after acquiring
      // the wallet lock. Another worker may have
      // already completed this operation.
      const rows = await tx.execute<PendingRow[]>(
        `SELECT
           id,
           wallet_id AS "walletId",
           provider_id AS "providerId",
           external_transaction_id AS "externalTransactionId",
           idempotency_key AS "idempotencyKey",
           player_id AS "playerId",
           round_id AS "roundId",
           game_id AS "gameId",
           kind,
           amount,
           currency,
           reference_external_transaction_id
             AS "referenceExternalTransactionId",
           retry_attempts AS "retryAttempts",
           created_at AS "createdAt"
         FROM wager_transactions
         WHERE id = ?
           AND status = ?
           AND (
             next_retry_at IS NULL
             OR next_retry_at <= NOW()
             OR created_at <= ?
           )
         FOR UPDATE SKIP LOCKED`,
        [id, Status.PendingReference, expiresBefore],
      );

      const row = rows[0];

      if (!row) {
        return 'skipped';
      }

      if (
        row.kind !== Kind.Refund &&
        row.kind !== Kind.Rollback
      ) {
        throw new Error(
          `Unexpected pending transaction kind: ${row.kind}`,
        );
      }

      const kind = row.kind;

      const now = new Date();
      const createdAt = new Date(row.createdAt);

      // If already expired, do not perform
      // another financial attempt.
      if (
        shouldRejectPendingReference(
          row.retryAttempts,
          createdAt,
          now,
        )
      ) {
        await expirePending(
          tx,
          row,
          row.retryAttempts,
          now,
        );

        return 'expired';
      }

      // Reuse the existing domain and financial logic.
      // This must resume the original transaction,
      // never insert a replacement transaction.
      const result = await new ProcessReversalUseCase(
        tx,
      ).execute({
        providerId: row.providerId,
        externalTransactionId:
          row.externalTransactionId,
        idempotencyKey: row.idempotencyKey,
        playerId: row.playerId,
        walletId: row.walletId,
        roundId: row.roundId,
        gameId: row.gameId,
        kind,
        money: {
          amount: row.amount,
          currency: row.currency,
        },
        referenceExternalTransactionId:
          row.referenceExternalTransactionId,
      });

      // The financial use case has already
      // created its own Outbox events.
      if (result.status === Status.Processed) {
        await tx.execute(
          `UPDATE wager_transactions
           SET next_retry_at = NULL,
               last_retry_at = ?
           WHERE id = ?`,
          [now, id],
        );

        return 'processed';
      }

      if (
        result.status === Status.Rejected ||
        result.status === Status.Failed
      ) {
        await tx.execute(
          `UPDATE wager_transactions
           SET next_retry_at = NULL,
               last_retry_at = ?
           WHERE id = ?`,
          [now, id],
        );

        return 'rejected';
      }

      if (result.status !== Status.PendingReference) {
        throw new Error(
          `Unexpected reversal status: ${result.status}`,
        );
      }

      // Reference still unavailable.
      const attempts = row.retryAttempts + 1;

      if (
        shouldRejectPendingReference(
          attempts,
          createdAt,
          now,
        )
      ) {
        await expirePending(tx, row, attempts, now);
        return 'expired';
      }

      const nextRetryAt =
        nextPendingReferenceRetryAt(
          attempts,
          now,
        );

      await tx.execute(
        `UPDATE wager_transactions
         SET retry_attempts = ?,
             last_retry_at = ?,
             next_retry_at = ?
         WHERE id = ?
           AND status = ?`,
        [
          attempts,
          now,
          nextRetryAt,
          id,
          Status.PendingReference,
        ],
      );

      return 'retry_scheduled';
    },
    { clear: true },
  );
}

/**
 * Runs one batch.
 *
 * Candidate discovery does not hold locks.
 * Each operation acquires its own wallet and
 * transaction locks before changing any state.
 */
export async function processPendingReferenceBatch(
  orm: MikroORM,
  batchSize = 25,
): Promise<PendingReferenceStats> {
  const expiresBefore = new Date(
    Date.now() - PENDING_REFERENCE_TTL_MS,
  );

  const candidates = await orm.em.fork().execute<
    Candidate[]
  >(
    `SELECT
       id,
       wallet_id AS "walletId"
     FROM wager_transactions
     WHERE status = ?
       AND (
         next_retry_at IS NULL
         OR next_retry_at <= NOW()
         OR created_at <= ?
       )
     ORDER BY
       COALESCE(next_retry_at, created_at),
       created_at,
       id
     LIMIT ?`,
    [
      Status.PendingReference,
      expiresBefore,
      batchSize,
    ],
  );

  const stats: PendingReferenceStats = {
    processed: 0,
    rejected: 0,
    retryScheduled: 0,
    expired: 0,
    skipped: 0,
  };

  for (const candidate of candidates) {
    try {
      const result =
        await processPendingReferenceById(
          orm,
          candidate.id,
        );

      if (result === 'processed') {
        stats.processed++;
      } else if (result === 'rejected') {
        stats.rejected++;
      } else if (result === 'retry_scheduled') {
        stats.retryScheduled++;
      } else if (result === 'expired') {
        stats.expired++;
      } else {
        stats.skipped++;
      }
    } catch (error) {
      // No commit means the operation remains
      // available for a later retry.
      console.error(
        '[PendingReference] Processing failed:',
        candidate.id,
        error,
      );
    }
  }

  return stats;
}
