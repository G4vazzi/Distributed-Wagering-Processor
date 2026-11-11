
import { Migration } from '@mikro-orm/migrations';

export class Migration20261111154037 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wallets" (
        "id" uuid not null,
        "player_id" uuid not null,
        "currency" varchar(3) not null,
        "balance" numeric(20,2) not null,
        "version" int not null default 1,
        "created_at" timestamptz not null,
        "updated_at" timestamptz not null,

        constraint "wallets_pkey"
          primary key ("id"),

        constraint "wallets_version_positive_check"
          check (version >= 1),

        constraint "wallets_balance_nonnegative_check"
          check (balance >= 0)
      );
    `);

    this.addSql(`
      alter table "wallets"
      add constraint "wallets_player_id_currency_unique"
      unique ("player_id", "currency");
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "wallets" cascade;');
  }
}
