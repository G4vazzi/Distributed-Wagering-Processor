
import { Migration } from '@mikro-orm/migrations';

export class Migration20261112160000 extends Migration {
  override async up(): Promise<void> {

    // ==========================================
    // LEDGER IMUTÁVEL
    // ==========================================

    this.addSql(`
      create function prevent_ledger_mutation()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception
          'Financial ledger entries are immutable'
          using errcode = 'P0001';

        return null;
      end;
      $$;
    `);

    // Bloqueia UPDATE e DELETE
    this.addSql(`
      create trigger ledger_immutable_rows
      before update or delete
      on wallet_ledger_entries
      for each row
      execute function prevent_ledger_mutation();
    `);

    // Bloqueia TRUNCATE
    this.addSql(`
      create trigger ledger_immutable_truncate
      before truncate
      on wallet_ledger_entries
      for each statement
      execute function prevent_ledger_mutation();
    `);

    // ==========================================
    // IMPEDIR REVERSÕES PROCESSADAS DUPLICADAS
    // ==========================================

    this.addSql(`
      create unique index
        wager_processed_reversal_unique
      on wager_transactions (
        reference_transaction_id,
        kind
      )
      where
        reference_transaction_id is not null
        and kind in ('REFUND', 'ROLLBACK')
        and status = 'PROCESSED';
    `);
  }

  override async down(): Promise<void> {

    // Reverte somente as proteções desta migration.

    this.addSql(`
      drop index if exists
        wager_processed_reversal_unique;
    `);

    this.addSql(`
      drop trigger if exists
        ledger_immutable_truncate
      on wallet_ledger_entries;
    `);

    this.addSql(`
      drop trigger if exists
        ledger_immutable_rows
      on wallet_ledger_entries;
    `);

    this.addSql(`
      drop function if exists prevent_ledger_mutation();
    `);
  }
}
