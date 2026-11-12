
import { Injectable } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import { EntityManager } from '@mikro-orm/postgresql';

import {
  Money,
  type MoneyProps,
} from '../../../shared/domain/money';

import { Wallet } from '../domain/wallet';

import { WalletRecord } from
  '../../../infrastructure/database/entities/wallet-record.entity';

import { WagerTransactionRecord } from
  '../../../infrastructure/database/entities/wager-transaction-record.entity';

import { WalletLedgerEntryRecord } from
  '../../../infrastructure/database/entities/wallet-ledger-entry-record.entity';

import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../wagering/domain/wager-transaction';

export interface OpenWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface OpenWalletOutput {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  openingTransactionId?: string;
}

@Injectable()
export class OpenWalletUseCase {
  constructor(
    private readonly em: EntityManager,
  ) {}

  async execute(
    input: OpenWalletInput,
  ): Promise<OpenWalletOutput> {
    if (
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
        .test(input.playerId)
    ) {
      throw new Error('Invalid playerId');
    }

    const initialBalance = Money.from(input.initialBalance);

    const walletId = randomUUID();
    const openingTransactionId = randomUUID();
    const openingLedgerEntryId = randomUUID();

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: input.playerId,
      initialBalance,
      openingTransactionId,
      openingLedgerEntryId,
    });

    await this.em.transactional(async (tx) => {
      const walletRecord = tx.create(WalletRecord, {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.toJSON().amount,
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      });

      tx.persist(walletRecord);

      if (openingEntry) {
        const payloadHash = createHash('sha256')
          .update(
            `OPENING:${wallet.id}:${initialBalance.toString()}`,
          )
          .digest('hex');

        const transactionRecord = tx.create(
          WagerTransactionRecord,
          {
            id: openingTransactionId,
            providerId: '__internal__',
            externalTransactionId: openingTransactionId,
            idempotencyKey:
              `internal:wallet-opening:${wallet.id}`,
            payloadHash,
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: `opening:${wallet.id}`,
            gameId: 'wallet-opening',
            kind: WagerTransactionKind.Opening,
            amount: initialBalance.toJSON().amount,
            currency: wallet.currency,
            status: WagerTransactionStatus.Processed,
            resultBalance: wallet.balance.toJSON().amount,
            createdAt: wallet.createdAt,
            processedAt: wallet.createdAt,
          },
        );

        tx.persist(transactionRecord);

        const ledgerRecord = tx.create(
          WalletLedgerEntryRecord,
          {
            id: openingEntry.id,
            walletId: openingEntry.walletId,
            transactionId: openingEntry.transactionId,
            direction: openingEntry.direction,
            amount: openingEntry.money.toJSON().amount,
            currency: openingEntry.money.currency,
            balanceBefore:
              openingEntry.balanceBefore.toJSON().amount,
            balanceAfter:
              openingEntry.balanceAfter.toJSON().amount,
            createdAt: openingEntry.createdAt,
          },
        );

        tx.persist(ledgerRecord);
      }
    }, { clear: true });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      openingTransactionId: openingEntry
        ? openingTransactionId
        : undefined,
    };
  }
}
