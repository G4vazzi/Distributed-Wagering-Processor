
import {
  Check,
  Entity,
  Index,
  ManyToOne,
  Opt,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/core';

import { WalletRecord } from './wallet-record.entity';

import {
  WagerTransactionKind,
  WagerTransactionStatus,
  FailureCode,
} from '../../../modules/wagering/domain/wager-transaction';

@Entity({ tableName: 'wager_transactions' })
@Unique({
  name: 'wager_provider_external_unique',
  properties: ['providerId', 'externalTransactionId'],
})
@Unique({
  name: 'wager_idempotency_key_unique',
  properties: ['idempotencyKey'],
})
@Index({
  name: 'wager_wallet_created_idx',
  properties: ['walletId', 'createdAt'],
})
@Check({
  name: 'wager_amount_positive_check',
  expression: 'amount > 0',
})
@Check({
  name: 'wager_kind_valid_check',
  expression: `kind IN (
    'OPENING', 'BET', 'WIN',
    'LOSS', 'REFUND', 'ROLLBACK'
  )`,
})
@Check({
  name: 'wager_status_valid_check',
  expression: `status IN (
    'PENDING', 'PENDING_REFERENCE',
    'PROCESSED', 'REJECTED', 'FAILED'
  )`,
})
@Check({
  name: 'wager_reference_required_check',
  expression: `
    kind NOT IN ('REFUND', 'ROLLBACK')
    OR reference_external_transaction_id IS NOT NULL
  `,
})
@Check({
  name: 'wager_result_balance_nonnegative_check',
  expression: 'result_balance IS NULL OR result_balance >= 0',
})
export class WagerTransactionRecord {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ length: 128 })
  providerId!: string;

  @Property({ length: 128 })
  externalTransactionId!: string;

  @Property({ length: 256 })
  idempotencyKey!: string;

  @Property({ length: 64 })
  payloadHash!: string;

  @ManyToOne(() => WalletRecord, {
    mapToPk: true,
    joinColumn: 'wallet_id',
  })
  walletId!: string;

  @Property({ type: 'uuid' })
  playerId!: string;

  @Property({ length: 128 })
  roundId!: string;

  @Property({ length: 128 })
  gameId!: string;

  @Property({ type: 'string', length: 24 })
  kind!: WagerTransactionKind;

  @Property({
    type: 'decimal',
    precision: 20,
    scale: 2,
  })
  amount!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({
    type: 'string',
    length: 24,
    default: WagerTransactionStatus.Pending,
  })
  status: WagerTransactionStatus =
    WagerTransactionStatus.Pending;

  @Property({ length: 128, nullable: true })
  referenceExternalTransactionId?: string;

  @ManyToOne(() => WagerTransactionRecord, {
    mapToPk: true,
    joinColumn: 'reference_transaction_id',
    nullable: true,
  })
  referenceTransactionId?: string;

  @Property({
    type: 'string',
    length: 80,
    nullable: true,
  })
  failureCode?: FailureCode;

  @Property({
    type: 'decimal',
    precision: 20,
    scale: 2,
    nullable: true,
  })
  resultBalance?: string;

  @Property({ columnType: 'timestamptz' })
  createdAt!: Date;

  @Property({
    columnType: 'timestamptz',
    nullable: true,
  })
  processedAt?: Date;

  // ==========================================
  // PENDING REFERENCE RETRY CONTROL
  // ==========================================

  @Property({
    fieldName: 'retry_attempts',
    default: 0,
  })
  retryAttempts: number & Opt = 0;

  @Property({
    fieldName: 'next_retry_at',
    columnType: 'timestamptz',
    nullable: true,
  })
  nextRetryAt?: Date;

  @Property({
    fieldName: 'last_retry_at',
    columnType: 'timestamptz',
    nullable: true,
  })
  lastRetryAt?: Date;

}
