
import { Migration } from '@mikro-orm/migrations';

export class Migration20261111162553 extends Migration {

  override async up(): Promise<void> {

    // ==========================================
    // WAGER TRANSACTIONS
    // ==========================================

    this.addSql(`
      create table "wager_transactions" (
        "id" uuid not null,
        "provider_id" varchar(128) not null,
        "external_transaction_id" varchar(128) not null,
        "idempotency_key" varchar(256) not null,
        "payload_hash" varchar(64) not null,
        "wallet_id" uuid not null,
        "player_id" uuid not null,
        "round_id" varchar(128) not null,
        "game_id" varchar(128) not null,
        "kind" varchar(24) not null,
        "amount" numeric(20,2) not null,
        "currency" varchar(3) not null,
        "status" varchar(24) not null default 'PENDING',
        "reference_external_transaction_id" varchar(128) null,
        "reference_transaction_id" uuid null,
        "failure_code" varchar(80) null,
        "result_balance" numeric(20,2) null,
        "created_at" timestamptz not null,
        "processed_at" timestamptz null,

        constraint "wager_transactions_pkey"
          primary key ("id"),

        constraint "wager_amount_positive_check"
          check (amount > 0),

        constraint "wager_result_balance_nonnegative_check"
          check (
            result_balance is null
            or result_balance >= 0
          ),

        constraint "wager_kind_valid_check"
          check (
            kind in (
              'OPENING', 'BET', 'WIN',
              'LOSS', 'REFUND', 'ROLLBACK'
            )
          ),

        constraint "wager_status_valid_check"
          check (
            status in (
              'PENDING', 'PENDING_REFERENCE',
              'PROCESSED', 'REJECTED', 'FAILED'
            )
          ),

        constraint "wager_reference_required_check"
          check (
            kind not in ('REFUND', 'ROLLBACK')
            or reference_external_transaction_id is not null
          )
      );
    `);

    // ==========================================
    // WAGER INDEXES AND UNIQUENESS
    // ==========================================

    this.addSql(`
      create index "wager_wallet_created_idx"
      on "wager_transactions" (
        "wallet_id",
        "created_at"
      );
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_idempotency_key_unique"
      unique ("idempotency_key");
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_provider_external_unique"
      unique ("provider_id", "external_transaction_id");
    `);

    // ==========================================
    // WALLET LEDGER ENTRIES
    // ==========================================

    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "direction" varchar(6) not null,
        "amount" numeric(20,2) not null,
        "currency" varchar(3) not null,
        "balance_before" numeric(20,2) not null,
        "balance_after" numeric(20,2) not null,
        "created_at" timestamptz not null,

        constraint "wallet_ledger_entries_pkey"
          primary key ("id"),

        constraint "ledger_amount_positive_check"
          check (amount > 0),

        constraint "ledger_balances_nonnegative_check"
          check (
            balance_before >= 0
            and balance_after >= 0
          ),

        constraint "ledger_direction_valid_check"
          check (
            direction in ('DEBIT', 'CREDIT')
          ),

        constraint "ledger_arithmetic_check"
          check (
            (
              direction = 'CREDIT'
              and balance_after = balance_before + amount
            )
            or
            (
              direction = 'DEBIT'
              and balance_after = balance_before - amount
            )
          )
      );
    `);

    // ==========================================
    // LEDGER INDEXES AND UNIQUENESS
    // ==========================================

    this.addSql(`
      create index "ledger_wallet_created_idx"
      on "wallet_ledger_entries" (
        "wallet_id",
        "created_at",
        "id"
      );
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "ledger_wallet_transaction_unique"
      unique ("wallet_id", "transaction_id");
    `);

    // ==========================================
    // FOREIGN KEYS
    // ==========================================

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_wallet_id_foreign"
      foreign key ("wallet_id")
      references "wallets" ("id")
      on update cascade;
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint
        "wager_transactions_reference_transaction_id_foreign"
      foreign key ("reference_transaction_id")
      references "wager_transactions" ("id")
      on update cascade
      on delete set null;
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_wallet_id_foreign"
      foreign key ("wallet_id")
      references "wallets" ("id")
      on update cascade;
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint
        "wallet_ledger_entries_transaction_id_foreign"
      foreign key ("transaction_id")
      references "wager_transactions" ("id")
      on update cascade;
    `);
  }

  // ==========================================
  // ROLLBACK
  // ==========================================

  override async down(): Promise<void> {

    // O ledger depende das transações.
    // Por isso, removemos o ledger primeiro.

    this.addSql(`
      drop table if exists "wallet_ledger_entries";
    `);

    // Após remover o ledger,
    // podemos remover as transações.

    this.addSql(`
      drop table if exists "wager_transactions";
    `);
  }
}
