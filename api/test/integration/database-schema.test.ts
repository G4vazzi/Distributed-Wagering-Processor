
import 'dotenv/config';

import { describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not configured');
}

describe('PostgreSQL - Financial integrity', () => {
  test('possui as tabelas financeiras', async () => {
    const client = new Client({ connectionString });

    await client.connect();

    try {
      const result = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (
            'wallets',
            'wager_transactions',
            'wallet_ledger_entries'
          )
      `);

      const names = result.rows.map(
        (row: { table_name: string }) => row.table_name,
      );

      expect(names).toContain('wallets');
      expect(names).toContain('wager_transactions');
      expect(names).toContain('wallet_ledger_entries');
    } finally {
      await client.end();
    }
  });

  test('impede saldo negativo diretamente no banco', async () => {
    const client = new Client({ connectionString });

    await client.connect();

    try {
      await client.query('BEGIN');

      const id = randomUUID();
      const playerId = randomUUID();

      // PostgreSQL deve rejeitar o saldo negativo.
      await expect(
        client.query(
          `
            INSERT INTO wallets (
              id,
              player_id,
              currency,
              balance,
              version,
              created_at,
              updated_at
            )
            VALUES (
              $1, $2, 'BRL', '-10.00',
              1, NOW(), NOW()
            )
          `,
          [id, playerId],
        ),
      ).rejects.toMatchObject({
        code: '23514',
      });

    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});
