
import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';

import {
  IsolationLevel,
  LockMode,
} from '@mikro-orm/core';

import { EntityManager } from '@mikro-orm/postgresql';

import {
  Money,
  type MoneyProps,
} from '../../../shared/domain/money';

import { Wallet } from '../../wallet/domain/wallet';

import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';

import { WalletRecord } from
  '../../../infrastructure/database/entities/wallet-record.entity';

import { WagerTransactionRecord } from
  '../../../infrastructure/database/entities/wager-transaction-record.entity';

import { WalletLedgerEntryRecord } from
  '../../../infrastructure/database/entities/wallet-ledger-entry-record.entity';

import { OutboxMessageRecord } from
  '../../../infrastructure/database/entities/outbox-message-record.entity';

import { IdempotencyConflictError } from
  './process-bet.use-case';

export interface ProcessWinLossInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind:
    | WagerTransactionKind.Win
    | WagerTransactionKind.Loss;
  money: MoneyProps;
}

export interface ProcessWinLossOutput {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
}

@Injectable()
export class ProcessWinLossUseCase {
  constructor(
    private readonly em: EntityManager,
  ) {}

  async execute(
    input: ProcessWinLossInput,
  ): Promise<ProcessWinLossOutput> {

    // ======================================
    // 1. VALIDAÇÕES DE ENTRADA
    // ======================================

    if (
      input.kind !== WagerTransactionKind.Win &&
      input.kind !== WagerTransactionKind.Loss
    ) {
      throw new Error('Invalid WIN/LOSS transaction kind');
    }

    if (
      typeof input.idempotencyKey !== 'string' ||
      !input.idempotencyKey.trim() ||
      input.idempotencyKey.length > 256
    ) {
      throw new Error('Invalid Idempotency-Key');
    }

    const money = Money.from(input.money);

    // Ordem fixa dos campos para o hash canônico.
    const canonicalPayload = JSON.stringify({
      externalTransactionId: input.externalTransactionId,
      gameId: input.gameId,
      kind: input.kind,
      money: money.toJSON(),
      playerId: input.playerId,
      providerId: input.providerId,
      roundId: input.roundId,
      walletId: input.walletId,
    });

    const payloadHash = createHash('sha256')
      .update(canonicalPayload)
      .digest('hex');

    // ======================================
    // 2. TRANSAÇÃO SQL
    // ======================================

    return this.em.transactional(async (tx) => {

      const walletRecord = await tx.findOne(
        WalletRecord,
        { id: input.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      if (!walletRecord) {
        throw new Error('Wallet not found');
      }

      if (walletRecord.playerId !== input.playerId) {
        throw new Error('Wallet does not belong to player');
      }

      if (walletRecord.currency !== money.currency) {
        throw new Error('Currency mismatch');
      }

      // ======================================
      // 3. IDEMPOTÊNCIA PERSISTENTE
      // ======================================

      const existing = await tx.findOne(
        WagerTransactionRecord,
        { idempotencyKey: input.idempotencyKey },
      );

      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new IdempotencyConflictError();
        }

        if (
          existing.status !==
            WagerTransactionStatus.Processed ||
          existing.resultBalance == null
        ) {
          throw new Error('Stored transaction is not completed');
        }

        return {
          transactionId: existing.id,
          status: existing.status,
          balance: {
            amount: existing.resultBalance,
            currency: existing.currency,
          },
          idempotentReplay: true,
        };
      }

      const existingExternal = await tx.findOne(
        WagerTransactionRecord,
        {
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
        },
      );

      if (existingExternal) {
        throw new IdempotencyConflictError(
          'External transaction ID already exists',
        );
      }

      // ======================================
      // 4. REIDRATAR A WALLET
      // ======================================

      const wallet = Wallet.rehydrate({
        id: walletRecord.id,
        playerId: walletRecord.playerId,
        currency: walletRecord.currency,
        balance: Money.from({
          amount: walletRecord.balance,
          currency: walletRecord.currency,
        }),
        version: walletRecord.version,
        createdAt: walletRecord.createdAt,
        updatedAt: walletRecord.updatedAt,
      });

      const now = new Date();

      const transaction = WagerTransaction.create({
        id: randomUUID(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        money,
        createdAt: now,
      });

      // ======================================
      // 5. PROCESSAR WIN OU LOSS
      // ======================================

      let ledgerEntry: ReturnType<Wallet['credit']> | undefined;

      if (input.kind === WagerTransactionKind.Win) {
        ledgerEntry = wallet.credit({
          transactionId: transaction.id,
          ledgerEntryId: randomUUID(),
          money,
          occurredAt: now,
        });

        walletRecord.balance = wallet.balance.toJSON().amount;
        walletRecord.version = wallet.version;
        walletRecord.updatedAt = wallet.updatedAt;
      }

      // LOSS não modifica o saldo nem gera ledger.
      transaction.markProcessed(undefined, now);

      // ======================================
      // 6. PERSISTIR A TRANSAÇÃO
      // ======================================

      tx.persist(
        tx.create(WagerTransactionRecord, {
          id: transaction.id,
          providerId: transaction.providerId,
          externalTransactionId:
            transaction.externalTransactionId,
          idempotencyKey: transaction.idempotencyKey,
          payloadHash: transaction.payloadHash,
          walletId: transaction.walletId,
          playerId: transaction.playerId,
          roundId: transaction.roundId,
          gameId: transaction.gameId,
          kind: transaction.kind,
          amount: money.toJSON().amount,
          currency: money.currency,
          status: transaction.status,
          resultBalance: wallet.balance.toJSON().amount,
          createdAt: transaction.createdAt,
          processedAt: transaction.processedAt,
        }),
      );

      // ======================================
      // 7. PERSISTIR LEDGER PARA WIN
      // ======================================

      if (ledgerEntry) {
        tx.persist(
          tx.create(WalletLedgerEntryRecord, {
            id: ledgerEntry.id,
            walletId: ledgerEntry.walletId,
            transactionId: ledgerEntry.transactionId,
            direction: ledgerEntry.direction,
            amount: ledgerEntry.money.toJSON().amount,
            currency: ledgerEntry.money.currency,
            balanceBefore:
              ledgerEntry.balanceBefore.toJSON().amount,
            balanceAfter:
              ledgerEntry.balanceAfter.toJSON().amount,
            createdAt: ledgerEntry.createdAt,
          }),
        );
      }

      // ======================================
      // 8. EVENTOS NA OUTBOX
      // ======================================

      const addEvent = (
        eventType: string,
        data: Record<string, unknown>,
      ): void => {
        const eventId = randomUUID();

        tx.persist(
          tx.create(OutboxMessageRecord, {
            id: eventId,
            aggregateId: wallet.id,
            eventType,
            payload: {
              eventId,
              eventType,
              aggregateId: wallet.id,
              correlationId: transaction.id,
              occurredAt: now.toISOString(),
              version: 1,
              data,
            },
            occurredAt: now,
            attempts: 0,
          }),
        );
      };

      addEvent('WagerTransactionProcessed', {
        transactionId: transaction.id,
        walletId: wallet.id,
        providerId: input.providerId,
        kind: input.kind,
        money: money.toJSON(),
        status: transaction.status,
      });

      if (ledgerEntry) {
        addEvent('WalletBalanceChanged', {
          walletId: wallet.id,
          transactionId: transaction.id,
          direction: ledgerEntry.direction,
          money: money.toJSON(),
          balanceBefore: ledgerEntry.balanceBefore.toJSON(),
          balanceAfter: ledgerEntry.balanceAfter.toJSON(),
          walletVersion: wallet.version,
        });
      }

      // ======================================
      // 9. COMMIT ATÔMICO
      // ======================================

      await tx.flush();

      return {
        transactionId: transaction.id,
        status: transaction.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    }, {
      clear: true,
      isolationLevel: IsolationLevel.READ_COMMITTED,
    });
  }
}
