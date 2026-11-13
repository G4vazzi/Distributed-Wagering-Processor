
import 'dotenv/config';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { randomUUID } from 'node:crypto';

import { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';

import ormConfig from '../../src/mikro-orm.config';

import { OpenWalletUseCase } from
  '../../src/modules/wallet/application/open-wallet.use-case';

import { ProcessBetUseCase } from
  '../../src/modules/wagering/application/process-bet.use-case';

import { ProcessReversalUseCase } from
  '../../src/modules/wagering/application/process-reversal.use-case';

import {
  processPendingReferenceById,
} from '../../src/modules/wagering/application/pending-reference.processor';

import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/modules/wagering/domain/wager-transaction';

const connectionString = process.env.DATABASE_URL;

describe('Pending Reference Worker - PostgreSQL', () => {
  let orm: MikroORM;
  let db: Client;

  beforeAll(async () => {
    if (
      !connectionString ||
      new URL(connectionString).pathname !==
        '/wagering_test'
    ) {
      throw new Error(
        'Tests require wagering_test database',
      );
    }

    orm = await MikroORM.init(ormConfig);

    db = new Client({ connectionString });
    await db.connect();
  });

  afterAll(async () => {
    if (db) await db.end();
    if (orm) await orm.close(true);
  });

  test(
    'processes REFUND when its BET arrives later',
    async () => {
      const playerId = randomUUID();

      const wallet = await new OpenWalletUseCase(
        orm.em.fork(),
      ).execute({
        playerId,
        initialBalance: {
          amount: '100.00',
          currency: 'BRL',
        },
      });

      const betId = randomUUID();
      const refundId = randomUUID();

      const refund = await new ProcessReversalUseCase(
        orm.em.fork(),
      ).execute({
        providerId: 'provider-pending-test',
        externalTransactionId: refundId,
        idempotencyKey: `refund:${refundId}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round-pending-test',
        gameId: 'game-pending-test',
        kind: Kind.Refund,
        money: {
          amount: '40.00',
          currency: 'BRL',
        },
        referenceExternalTransactionId: betId,
      });

      expect(refund.status).toBe(
        Status.PendingReference,
      );

      // First worker attempt: reference unavailable.
      const first =
        await processPendingReferenceById(
          orm,
          refund.transactionId,
        );

      expect(first).toBe('retry_scheduled');

      // The original BET arrives afterwards.
      const bet = await new ProcessBetUseCase(
        orm.em.fork(),
      ).execute({
        providerId: 'provider-pending-test',
        externalTransactionId: betId,
        idempotencyKey: `bet:${betId}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round-pending-test',
        gameId: 'game-pending-test',
        money: {
          amount: '40.00',
          currency: 'BRL',
        },
      });

      expect(bet.status).toBe(Status.Processed);

      // Advance the scheduled retry for testing.
      await db.query(
        `UPDATE wager_transactions
         SET next_retry_at =
           NOW() - INTERVAL '1 second'
         WHERE id = $1`,
        [refund.transactionId],
      );

      // Two workers compete for the same pending refund.
      await Promise.all([
        processPendingReferenceById(
          orm,
          refund.transactionId,
        ),
        processPendingReferenceById(
          orm,
          refund.transactionId,
        ),
      ]);

      const result = await db.query<{
        status: string;
        failure_code: string | null;
      }>(
        `SELECT status, failure_code
         FROM wager_transactions
         WHERE id = $1`,
        [refund.transactionId],
      );

      expect(result.rows[0]?.status).toBe(
        Status.Processed,
      );

      const balance = await db.query<{
        balance: string;
      }>(
        `SELECT balance
         FROM wallets
         WHERE id = $1`,
        [wallet.id],
      );

      expect(balance.rows[0]?.balance).toBe(
        '100.00',
      );

      const ledger = await db.query<{
        total: number;
      }>(
        `SELECT count(*)::int AS total
         FROM wallet_ledger_entries
         WHERE transaction_id = $1`,
        [refund.transactionId],
      );

      expect(ledger.rows[0]?.total).toBe(1);
    },
  );

  test(
    'expires missing reference without changing balance',
    async () => {
      const playerId = randomUUID();

      const wallet = await new OpenWalletUseCase(
        orm.em.fork(),
      ).execute({
        playerId,
        initialBalance: {
          amount: '100.00',
          currency: 'BRL',
        },
      });

      const refundId = randomUUID();

      const refund = await new ProcessReversalUseCase(
        orm.em.fork(),
      ).execute({
        providerId: 'provider-expiry-test',
        externalTransactionId: refundId,
        idempotencyKey: `refund:${refundId}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round-expiry-test',
        gameId: 'game-expiry-test',
        kind: Kind.Refund,
        money: {
          amount: '30.00',
          currency: 'BRL',
        },
        referenceExternalTransactionId:
          randomUUID(),
      });

      expect(refund.status).toBe(
        Status.PendingReference,
      );

      // Simulate a reference unresolved for 31 minutes.
      await db.query(
        `UPDATE wager_transactions
         SET created_at =
           NOW() - INTERVAL '31 minutes'
         WHERE id = $1`,
        [refund.transactionId],
      );

      const result =
        await processPendingReferenceById(
          orm,
          refund.transactionId,
        );

      expect(result).toBe('expired');

      const transaction = await db.query<{
        status: string;
        failure_code: string;
      }>(
        `SELECT status, failure_code
         FROM wager_transactions
         WHERE id = $1`,
        [refund.transactionId],
      );

      expect(transaction.rows[0]?.status).toBe(
        Status.Rejected,
      );

      expect(
        transaction.rows[0]?.failure_code,
      ).toBe(FailureCode.InvalidReference);

      const balance = await db.query<{
        balance: string;
      }>(
        `SELECT balance
         FROM wallets
         WHERE id = $1`,
        [wallet.id],
      );

      expect(balance.rows[0]?.balance).toBe(
        '100.00',
      );

      const events = await db.query<{
        total: number;
      }>(
        `SELECT count(*)::int AS total
         FROM outbox_messages
         WHERE payload->>'correlationId' = $1
           AND event_type =
             'WagerTransactionRejected'`,
        [refund.transactionId],
      );

      expect(events.rows[0]?.total).toBe(1);

      // A second execution must not reject it twice.
      const replay =
        await processPendingReferenceById(
          orm,
          refund.transactionId,
        );

      expect(replay).toBe('skipped');
    },
  );
});
