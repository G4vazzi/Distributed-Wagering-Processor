
import { Migration } from '@mikro-orm/migrations';

export class Migration20261113180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
      ADD COLUMN retry_attempts INTEGER NOT NULL DEFAULT 0
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      ADD COLUMN next_retry_at TIMESTAMPTZ NULL
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      ADD COLUMN last_retry_at TIMESTAMPTZ NULL
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      ADD CONSTRAINT wager_retry_attempts_nonnegative_check
      CHECK (retry_attempts >= 0)
    `);

    this.addSql(`
      UPDATE wager_transactions
      SET next_retry_at = NOW()
      WHERE status = 'PENDING_REFERENCE'
        AND next_retry_at IS NULL
    `);

    this.addSql(`
      CREATE INDEX wager_pending_retry_due_idx
      ON wager_transactions (
        next_retry_at,
        created_at,
        id
      )
      WHERE status = 'PENDING_REFERENCE'
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP INDEX IF EXISTS wager_pending_retry_due_idx
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      DROP CONSTRAINT IF EXISTS
      wager_retry_attempts_nonnegative_check
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      DROP COLUMN IF EXISTS last_retry_at
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      DROP COLUMN IF EXISTS next_retry_at
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      DROP COLUMN IF EXISTS retry_attempts
    `);
  }
}
