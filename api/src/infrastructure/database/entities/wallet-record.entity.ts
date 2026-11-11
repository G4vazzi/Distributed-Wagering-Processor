
import {
  Check,
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/core';

@Entity({ tableName: 'wallets' })
@Unique({ properties: ['playerId', 'currency'] })
@Check({
    name: 'wallets_balance_nonnegative_check',
    expression: 'balance >= 0',
})
@Check({
    name: 'wallets_version_positive_check',
    expression: 'version >= 1',
})
export class WalletRecord {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid' })
  playerId!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({
    type: 'decimal',
    precision: 20,
    scale: 2,
  })
  balance!: string;

  @Property({ default: 1 })
  version: number = 1;

  @Property({ columnType: 'timestamptz' })
  createdAt!: Date;

  @Property({ columnType: 'timestamptz' })
  updatedAt!: Date;
}
