
import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';

import { LockMode, IsolationLevel } from '@mikro-orm/core';
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
  FailureCode,
} from '../domain/wager-transaction';

import { WalletRecord } from
  '../../../infrastructure/database/entities/wallet-record.entity';

import { WagerTransactionRecord } from
  '../../../infrastructure/database/entities/wager-transaction-record.entity';

import { WalletLedgerEntryRecord } from
  '../../../infrastructure/database/entities/wallet-ledger-entry-record.entity';

import { OutboxMessageRecord } from
  '../../../infrastructure/database/entities/outbox-message-record.entity';

export interface ProcessBetInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  money: MoneyProps;
}

export interface ProcessBetOutput {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export class IdempotencyConflictError extends Error {
  constructor(message = 'Idempotency key conflict') {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

@Injectable()
export class ProcessBetUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(input: ProcessBetInput): Promise<ProcessBetOutput> {
    if (
      typeof input.idempotencyKey !== 'string' ||
      !input.idempotencyKey.trim()
    ) {
      throw new Error('Idempotency-Key is required');
    }

    const money = Money.from(input.money);

    // Campos de negócio em ordem canônica.
    // Não inclui Idempotency-Key nem metadados de transporte.
    const canonicalPayload = JSON.stringify({
      externalTransactionId: input.externalTransactionId,
      gameId: input.gameId,
      kind: WagerTransactionKind.Bet,
      money: money.toJSON(),
      playerId: input.playerId,
      providerId: input.providerId,
      roundId: input.roundId,
      walletId: input.walletId,
    });

    const payloadHash = createHash('sha256')
      .update(canonicalPayload)
      .digest('hex');

    return this.em.transactional(async (tx) => {
      // ======================================
      // 1. BLOQUEAR A CARTEIRA
      // ======================================

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
      // 2. VERIFICAR IDEMPOTÊNCIA
      // ======================================

      const existing = await tx.findOne(
        WagerTransactionRecord,
        { idempotencyKey: input.idempotencyKey },
      );

      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new IdempotencyConflictError();
        }

        if (existing.resultBalance == null) {
          throw new Error('Stored transaction is still pending');
        }

        return {
          transactionId: existing.id,
          status: existing.status,
          balance: {
            amount: existing.resultBalance,
            currency: existing.currency,
          },
          failureCode: existing.failureCode,
          idempotentReplay: true,
        };
      }

      // Identificador externo também deve ser único.
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
      // 3. RECONSTRUIR ENTIDADES DE DOMÍNIO
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
        kind: WagerTransactionKind.Bet,
        money,
        createdAt: now,
      });

      // ======================================
      // 4. PROCESSAR OU REJEITAR A APOSTA
      // ======================================

      let ledgerEntry: ReturnType<Wallet['debit']> | undefined;

      if (wallet.balance.isLessThan(money)) {
        transaction.reject(FailureCode.InsufficientFunds);
      } else {
        ledgerEntry = wallet.debit({
          transactionId: transaction.id,
          ledgerEntryId: randomUUID(),
          money,
          occurredAt: now,
        });

        transaction.markProcessed(undefined, now);

        walletRecord.balance = wallet.balance.toJSON().amount;
        walletRecord.version = wallet.version;
        walletRecord.updatedAt = wallet.updatedAt;
      }

      // ======================================
      // 5. PERSISTIR A TRANSAÇÃO FINANCEIRA
      // ======================================

      const transactionRecord = tx.create(
        WagerTransactionRecord,
        {
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
          failureCode: transaction.failureCode,
          resultBalance: wallet.balance.toJSON().amount,
          createdAt: transaction.createdAt,
          processedAt: transaction.processedAt,
        },
      );

      tx.persist(transactionRecord);

      // ======================================
      // 6. PERSISTIR LEDGER (SE HOUVER DÉBITO)
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
      // 7. REGISTRAR EVENTOS NA OUTBOX
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

      if (transaction.status === WagerTransactionStatus.Processed) {
        addEvent('WagerTransactionProcessed', {
          transactionId: transaction.id,
          walletId: wallet.id,
          providerId: input.providerId,
          kind: WagerTransactionKind.Bet,
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
      } else {
        addEvent('WagerTransactionRejected', {
          transactionId: transaction.id,
          walletId: wallet.id,
          failureCode: transaction.failureCode,
          status: transaction.status,
        });
      }

      // ======================================
      // 8. CONFIRMAR ALTERAÇÕES
      // ======================================

      await tx.flush();

      return {
        transactionId: transaction.id,
        status: transaction.status,
        balance: wallet.balance.toJSON(),
        failureCode: transaction.failureCode,
        idempotentReplay: false,
      };
    }, {
      clear: true,
      isolationLevel: IsolationLevel.READ_COMMITTED,
    });
  }
}
