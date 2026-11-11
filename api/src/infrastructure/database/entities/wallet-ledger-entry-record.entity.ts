
import {
  Check,
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/core';

import { WalletRecord } from './wallet-record.entity';
import { WagerTransactionRecord } from
  './wager-transaction-record.entity';

import { LedgerDirection } from
  '../../../modules/wallet/domain/wallet-ledger-entry';

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({
  name: 'ledger_wallet_transaction_unique',
  properties: ['walletId', 'transactionId'],
})
@Index({
  name: 'ledger_wallet_created_idx',
  properties: ['walletId', 'createdAt', 'id'],
})
@Check({
  name: 'ledger_amount_positive_check',
  expression: 'amount > 0',
})
@Check({
  name: 'ledger_balances_nonnegative_check',
  expression: `
    balance_before >= 0 AND balance_after >= 0
  `,
})
@Check({
  name: 'ledger_direction_valid_check',
  expression: "direction IN ('DEBIT', 'CREDIT')",
})
@Check({
  name: 'ledger_arithmetic_check',
  expression: `
    (direction = 'CREDIT'
      AND balance_after = balance_before + amount)
    OR
    (direction = 'DEBIT'
      AND balance_after = balance_before - amount)
  `,
})
export class WalletLedgerEntryRecord {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne(() => WalletRecord, {
    mapToPk: true,
    joinColumn: 'wallet_id',
  })
  walletId!: string;

  @ManyToOne(() => WagerTransactionRecord, {
    mapToPk: true,
    joinColumn: 'transaction_id',
  })
  transactionId!: string;

  @Property({ type: 'string', length: 6 })
  direction!: LedgerDirection;

  @Property({
    type: 'decimal',
    precision: 20,
    scale: 2,
  })
  amount!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({
    type: 'decimal',
    precision: 20,
    scale: 2,
  })
  balanceBefore!: string;

  @Property({
    type: 'decimal',
    precision: 20,
    scale: 2,
  })
  balanceAfter!: string;

  @Property({ columnType: 'timestamptz' })
  createdAt!: Date;
}
