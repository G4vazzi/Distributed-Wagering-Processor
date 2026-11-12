
import 'dotenv/config';

import { describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not configured');
}

describe('Inbox and Outbox - PostgreSQL', () => {
  test('impede mensagem duplicada na Inbox', async () => {
    const db = new Client({ connectionString });
    await db.connect();

    try {
      await db.query('BEGIN');

      const sql = `
        INSERT INTO inbox_messages (
          consumer_name,
          message_id,
          payload_hash,
          received_at
        )
        VALUES ($1, $2, $3, NOW())
      `;

      const values = [
        'wager-consumer',
        randomUUID(),
        'a'.repeat(64),
      ];

      await db.query(sql, values);

      await expect(
        db.query(sql, values),
      ).rejects.toMatchObject({
        code: '23505',
      });
    } finally {
      await db.query('ROLLBACK');
      await db.end();
    }
  });

  test('impede tentativas negativas na Outbox', async () => {
    const db = new Client({ connectionString });
    await db.connect();

    try {
      await db.query('BEGIN');

      await expect(
        db.query(
          `
            INSERT INTO outbox_messages (
              id,
              aggregate_id,
              event_type,
              payload,
              occurred_at,
              attempts
            )
            VALUES (
              $1, $2, $3, $4::jsonb, NOW(), -1
            )
          `,
          [
            randomUUID(),
            randomUUID(),
            'WalletBalanceChanged',
            JSON.stringify({ amount: '25.00' }),
          ],
        ),
      ).rejects.toMatchObject({
        code: '23514',
      });
    } finally {
      await db.query('ROLLBACK');
      await db.end();
    }
  });
});
