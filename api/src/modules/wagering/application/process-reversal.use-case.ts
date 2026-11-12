
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
  LedgerDirection,
  WalletLedgerEntry,
} from '../../wallet/domain/wallet-ledger-entry';

import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
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

import { IdempotencyConflictError } from
  './process-bet.use-case';

export interface ProcessReversalInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Kind.Refund | Kind.Rollback;
  money: MoneyProps;
  referenceExternalTransactionId: string;
}

export interface ProcessReversalOutput {
  transactionId: string;
  status: Status;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

@Injectable()
export class ProcessReversalUseCase {
  constructor(private readonly em: EntityManager) {}

  private asDomain(
    record: WagerTransactionRecord,
  ): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind,
      money: Money.from({
        amount: record.amount,
        currency: record.currency,
      }),
      referenceExternalTransactionId:
        record.referenceExternalTransactionId,
      createdAt: record.createdAt,
      status: record.status,
      referenceTransactionId: record.referenceTransactionId,
      failureCode: record.failureCode,
      processedAt: record.processedAt,
    });
  }

  private enqueueEvent(
    tx: EntityManager,
    walletId: string,
    transactionId: string,
    eventType: string,
    data: Record<string, unknown>,
    now: Date,
  ): void {
    const eventId = randomUUID();

    tx.persist(
      tx.create(OutboxMessageRecord, {
        id: eventId,
        aggregateId: walletId,
        eventType,
        payload: {
          eventId,
          eventType,
          aggregateId: walletId,
          correlationId: transactionId,
          occurredAt: now.toISOString(),
          version: 1,
          data,
        },
        occurredAt: now,
        attempts: 0,
      }),
    );
  }

  async execute(
    input: ProcessReversalInput,
  ): Promise<ProcessReversalOutput> {

    // ======================================
    // 1. VALIDAÇÕES
    // ======================================

    if (
      input.kind !== Kind.Refund &&
      input.kind !== Kind.Rollback
    ) {
      throw new Error('Invalid reversal kind');
    }

    const required: Array<[unknown, number]> = [
      [input.providerId, 128],
      [input.externalTransactionId, 128],
      [input.idempotencyKey, 256],
      [input.playerId, 36],
      [input.walletId, 36],
      [input.roundId, 128],
      [input.gameId, 128],
      [input.referenceExternalTransactionId, 128],
    ];

    for (const [value, maxLength] of required) {
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > maxLength
      ) {
        throw new Error('Invalid transaction identifier');
      }
    }

    if (
      input.externalTransactionId ===
      input.referenceExternalTransactionId
    ) {
      throw new Error('Self-reference is not allowed');
    }

    const money = Money.from(input.money);

    if (!money.isPositive()) {
      throw new Error('Reversal amount must be positive');
    }

    // JSON canônico do contrato atual, com chaves ordenadas.
    const canonicalPayload = JSON.stringify({
      externalTransactionId: input.externalTransactionId,
      gameId: input.gameId,
      kind: input.kind,
      money: money.toJSON(),
      playerId: input.playerId,
      providerId: input.providerId,
      referenceExternalTransactionId:
        input.referenceExternalTransactionId,
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
      const now = new Date();

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
      // 3. IDEMPOTÊNCIA
      // ======================================

      const existing = await tx.findOne(
        WagerTransactionRecord,
        { idempotencyKey: input.idempotencyKey },
      );

      if (existing && existing.payloadHash !== payloadHash) {
        throw new IdempotencyConflictError();
      }

      const external = await tx.findOne(
        WagerTransactionRecord,
        {
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
        },
      );

      if (external && (!existing || external.id !== existing.id)) {
        throw new IdempotencyConflictError(
          'External transaction ID already exists',
        );
      }

      const outputFromRecord = (
        record: WagerTransactionRecord,
        replay: boolean,
      ): ProcessReversalOutput => {
        if (record.resultBalance == null) {
          throw new Error('Stored result balance is missing');
        }

        return {
          transactionId: record.id,
          status: record.status,
          balance: {
            amount: record.resultBalance,
            currency: record.currency,
          },
          failureCode: record.failureCode,
          idempotentReplay: replay,
        };
      };

      if (
        existing &&
        [Status.Processed, Status.Rejected, Status.Failed]
          .includes(existing.status)
      ) {
        return outputFromRecord(existing, true);
      }

      // ======================================
      // 4. RECONSTRUIR A WALLET E A TRANSAÇÃO
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

      const transaction = existing
        ? this.asDomain(existing)
        : WagerTransaction.create({
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
            referenceExternalTransactionId:
              input.referenceExternalTransactionId,
            createdAt: now,
          });

      const record = existing ?? tx.create(
        WagerTransactionRecord,
        {
          id: transaction.id,
          providerId: transaction.providerId,
          externalTransactionId:
            transaction.externalTransactionId,
          idempotencyKey: transaction.idempotencyKey,
          payloadHash,
          walletId: transaction.walletId,
          playerId: transaction.playerId,
          roundId: transaction.roundId,
          gameId: transaction.gameId,
          kind: transaction.kind,
          amount: money.toJSON().amount,
          currency: money.currency,
          status: Status.Pending,
          referenceExternalTransactionId:
            input.referenceExternalTransactionId,
          createdAt: transaction.createdAt,
        },
      );

      // ======================================
      // 5. RESOLVER A REFERÊNCIA
      // ======================================

      const reference = await tx.findOne(
        WagerTransactionRecord,
        {
          providerId: input.providerId,
          externalTransactionId:
            input.referenceExternalTransactionId,
        },
      );

      const referenceWaiting =
        !reference ||
        reference.status === Status.Pending ||
        reference.status === Status.PendingReference;

      if (referenceWaiting) {
        // Uma mensagem já pendente não gera outro evento.
        if (existing) {
          return outputFromRecord(existing, true);
        }

        transaction.markPendingReference();

        record.status = transaction.status;
        record.resultBalance = wallet.balance.toJSON().amount;

        tx.persist(record);

        this.enqueueEvent(
          tx,
          wallet.id,
          transaction.id,
          'WagerTransactionPendingReference',
          {
            transactionId: transaction.id,
            referenceExternalTransactionId:
              input.referenceExternalTransactionId,
            kind: input.kind,
            status: transaction.status,
          },
          now,
        );

        await tx.flush();
        return outputFromRecord(record, false);
      }

      // ======================================
      // 6. VALIDAR REFERÊNCIA E REVERSÃO
      // ======================================

      let rejectionCode: FailureCode | undefined;

      const allowedKind =
        input.kind === Kind.Refund
            ? reference.kind === Kind.Bet
            : reference.kind === Kind.Bet ||
              reference.kind === Kind.Win ||
              reference.kind === Kind.Refund;

      const sameContext =
        reference.providerId === input.providerId &&
        reference.playerId === input.playerId &&
        reference.walletId === input.walletId &&
        reference.currency === money.currency &&
        reference.roundId === input.roundId;

      if (
        reference.status !== Status.Processed ||
        !allowedKind ||
        !sameContext
      ) {
        rejectionCode = FailureCode.InvalidReference;
      } else if (
        reference.amount !== money.toJSON().amount
      ) {
        rejectionCode = FailureCode.InvalidAmount;
      } else {
        const previousReversed = await tx.findOne(
            WagerTransactionRecord,
            {
                referenceTransactionId: reference.id,
                kind: input.kind,
                status: Status.Processed,
            },
        );
        if (previousReversed) {
            rejectionCode = FailureCode.ReferenceAlreadyReversed;
        }            
      }

      let ledgerEntry: WalletLedgerEntry | undefined;

      if (!rejectionCode) {
        const referenceDomain = this.asDomain(reference);

        const direction =
          transaction.ledgerDirectionFor(referenceDomain);

        // Débito de reversão não pode criar saldo negativo.
        if (
          direction === LedgerDirection.Debit &&
          wallet.balance.isLessThan(money)
        ) {
          rejectionCode = FailureCode.ReversalInsufficientFunds;
        } else {
          const movement = {
            transactionId: transaction.id,
            ledgerEntryId: randomUUID(),
            money,
            occurredAt: now,
          };

          ledgerEntry =
            direction === LedgerDirection.Credit
              ? wallet.credit(movement)
              : wallet.debit(movement);

          transaction.markProcessed(reference.id, now);

          walletRecord.balance = wallet.balance.toJSON().amount;
          walletRecord.version = wallet.version;
          walletRecord.updatedAt = wallet.updatedAt;
        }
      }

      if (rejectionCode) {
        transaction.reject(rejectionCode);
      }

      // ======================================
      // 7. SALVAR TRANSAÇÃO E LEDGER
      // ======================================

      record.status = transaction.status;
      record.failureCode = transaction.failureCode;
      record.referenceTransactionId =
        transaction.referenceTransactionId;
      record.processedAt = transaction.processedAt;
      record.resultBalance = wallet.balance.toJSON().amount;

      tx.persist(record);

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
      // 8. OUTBOX
      // ======================================

      if (transaction.status === Status.Processed) {
        this.enqueueEvent(
          tx,
          wallet.id,
          transaction.id,
          'WagerTransactionProcessed',
          {
            transactionId: transaction.id,
            kind: transaction.kind,
            referenceTransactionId: reference.id,
            money: money.toJSON(),
            status: transaction.status,
          },
          now,
        );

        if (ledgerEntry) {
          this.enqueueEvent(
            tx,
            wallet.id,
            transaction.id,
            'WalletBalanceChanged',
            {
              walletId: wallet.id,
              transactionId: transaction.id,
              direction: ledgerEntry.direction,
              money: money.toJSON(),
              balanceBefore:
                ledgerEntry.balanceBefore.toJSON(),
              balanceAfter:
                ledgerEntry.balanceAfter.toJSON(),
              walletVersion: wallet.version,
            },
            now,
          );
        }
      } else {
        this.enqueueEvent(
          tx,
          wallet.id,
          transaction.id,
          'WagerTransactionRejected',
          {
            transactionId: transaction.id,
            kind: transaction.kind,
            failureCode: transaction.failureCode,
            status: transaction.status,
          },
          now,
        );
      }

      await tx.flush();
      return outputFromRecord(record, false);

    }, {
      clear: true,
      isolationLevel: IsolationLevel.READ_COMMITTED,
    });
  }
}
