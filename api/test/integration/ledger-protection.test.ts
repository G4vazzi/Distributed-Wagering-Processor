
import 'dotenv/config';

import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not configured');
}

async function withLedger(
  callback: (db: Client, ledgerId: string) => Promise<void>,
): Promise<void> {
  const db = new Client({ connectionString });
  await db.connect();

  const walletId = randomUUID();
  const playerId = randomUUID();
  const transactionId = randomUUID();
  const ledgerId = randomUUID();

  try {
    await db.query('BEGIN');

    await db.query(`
      INSERT INTO wallets (
        id, player_id, currency, balance,
        version, created_at, updated_at
      )
      VALUES ($1, $2, 'BRL', '100.00', 1, NOW(), NOW())
    `, [walletId, playerId]);

    await db.query(`
      INSERT INTO wager_transactions (
        id, provider_id, external_transaction_id,
        idempotency_key, payload_hash, wallet_id,
        player_id, round_id, game_id, kind,
        amount, currency, status, created_at
      )
      VALUES (
        $1, '__internal__', $2, $3, $4, $5,
        $6, 'opening', 'wallet-opening',
        'OPENING', '100.00', 'BRL',
        'PROCESSED', NOW()
      )
    `, [
      transactionId,
      transactionId,
      `internal:${transactionId}`,
      'a'.repeat(64),
      walletId,
      playerId,
    ]);

    await db.query(`
      INSERT INTO wallet_ledger_entries (
        id, wallet_id, transaction_id,
        direction, amount, currency,
        balance_before, balance_after, created_at
      )
      VALUES (
        $1, $2, $3,
        'CREDIT', '100.00', 'BRL',
        '0.00', '100.00', NOW()
      )
    `, [ledgerId, walletId, transactionId]);

    await callback(db, ledgerId);
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
}

describe('Ledger - Database protection', () => {
  test('bloqueia UPDATE no ledger', async () => {
    await withLedger(async (db, ledgerId) => {
      await expect(
        db.query(
          `UPDATE wallet_ledger_entries
           SET amount = '50.00'
           WHERE id = $1`,
          [ledgerId],
        ),
      ).rejects.toMatchObject({
        code: 'P0001',
      });
    });
  });

  test('bloqueia DELETE no ledger', async () => {
    await withLedger(async (db, ledgerId) => {
      await expect(
        db.query(
          `DELETE FROM wallet_ledger_entries
           WHERE id = $1`,
          [ledgerId],
        ),
      ).rejects.toMatchObject({
        code: 'P0001',
      });
    });
  });

  test('bloqueia TRUNCATE no ledger', async () => {
    await withLedger(async (db) => {
      await expect(
        db.query(
          'TRUNCATE TABLE wallet_ledger_entries',
        ),
      ).rejects.toMatchObject({
        code: 'P0001',
      });
    });
  });

  test('possui índice de reversão única', async () => {
    const db = new Client({ connectionString });
    await db.connect();

    try {
      const result = await db.query(`
        SELECT indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'wager_transactions'
          AND indexname = 'wager_processed_reversal_unique'
      `);

      expect(result.rows).toHaveLength(1);

      expect(result.rows[0].indexdef)
        .toContain('UNIQUE INDEX');
    } finally {
      await db.end();
    }
  });
});
