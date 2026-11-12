
import { Migration } from '@mikro-orm/migrations';

export class Migration20261112143448 extends Migration {

  override async up(): Promise<void> {

    // ==========================================
    // INBOX MESSAGES
    // ==========================================

    this.addSql(`
      create table "inbox_messages" (
        "consumer_name" varchar(128) not null,
        "message_id" varchar(160) not null,
        "payload_hash" varchar(64) not null,
        "received_at" timestamptz not null,
        "processed_at" timestamptz null,

        constraint "inbox_messages_pkey"
          primary key ("consumer_name", "message_id")
      );
    `);

    // ==========================================
    // OUTBOX MESSAGES
    // ==========================================

    this.addSql(`
      create table "outbox_messages" (
        "id" uuid not null,
        "aggregate_id" uuid not null,
        "event_type" varchar(100) not null,
        "payload" jsonb not null,
        "occurred_at" timestamptz not null,
        "attempts" int not null default 0,
        "next_attempt_at" timestamptz null,
        "published_at" timestamptz null,

        constraint "outbox_messages_pkey"
          primary key ("id"),

        constraint "outbox_attempts_nonnegative_check"
          check (attempts >= 0)
      );
    `);

    // ==========================================
    // ÍNDICE PARA PUBLICAÇÃO DE EVENTOS
    // ==========================================

    this.addSql(`
      create index "outbox_pending_idx"
      on "outbox_messages" (
        "published_at",
        "next_attempt_at",
        "occurred_at"
      );
    `);
  }

  override async down(): Promise<void> {

    // Reverte apenas as tabelas desta migration

    this.addSql(`
      drop table "outbox_messages";
    `);

    this.addSql(`
      drop table "inbox_messages";
    `);
  }
}
