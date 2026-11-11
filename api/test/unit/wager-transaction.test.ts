
import { describe, expect, test } from 'bun:test';

import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  FailureCode,
  type CreateWagerTransactionProps,
} from '../../src/modules/wagering/domain/wager-transaction';

import { Money } from '../../src/shared/domain/money';

import { LedgerDirection } from
  '../../src/modules/wallet/domain/wallet-ledger-entry';

const brl = (amount: string): Money =>
  Money.from({ amount, currency: 'BRL' });

const props = (
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps => ({
  id: 'transaction-001',
  providerId: 'provider-a',
  externalTransactionId: 'external-001',
  idempotencyKey: 'provider-a:external-001',
  payloadHash: 'a'.repeat(64),
  walletId: 'wallet-001',
  playerId: 'player-001',
  roundId: 'round-001',
  gameId: 'game-001',
  kind: Kind.Bet,
  money: brl('25.00'),
  ...overrides,
});

const create = (
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction =>
  WagerTransaction.create(props(overrides));

describe('WagerTransaction', () => {
  test('cria transação em PENDING', () => {
    const transaction = create();

    expect(transaction.status).toBe(Status.Pending);
    expect(transaction.isTerminal()).toBe(false);
  });

  test('impede OPENING pela factory externa', () => {
    expect(() => create({
      kind: Kind.Opening,
    })).toThrow('Invalid external transaction kind');
  });

  test('exige referência para REFUND e ROLLBACK', () => {
    for (const kind of [Kind.Refund, Kind.Rollback]) {
      expect(() => create({ kind }))
        .toThrow('Transaction reference is required');
    }
  });

  test('rejeita valores zerados', () => {
    expect(() => create({
      money: brl('0.00'),
    })).toThrow('Transaction amount must be positive');
  });

  test('rejeita hash inválido', () => {
    expect(() => create({
      payloadHash: 'invalid-hash',
    })).toThrow('Invalid payload hash');
  });

  test('marca uma BET como processada', () => {
    const transaction = create();

    transaction.markProcessed(undefined, new Date());

    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.isTerminal()).toBe(true);
    expect(transaction.processedAt).toBeDefined();
  });

  test('impede alterações após processamento', () => {
    const transaction = create();

    transaction.markProcessed(undefined, new Date());

    expect(() =>
      transaction.reject(FailureCode.InsufficientFunds),
    ).toThrow('InvalidTransactionStateError');
  });

  test('aguarda referência e processa posteriormente', () => {
    const transaction = create({
      kind: Kind.Rollback,
      referenceExternalTransactionId: 'external-bet',
    });

    transaction.markPendingReference();

    expect(transaction.status).toBe(Status.PendingReference);

    transaction.markProcessed('internal-bet-id', new Date());

    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.referenceTransactionId)
      .toBe('internal-bet-id');
  });

  test('não processa REFUND sem referência resolvida', () => {
    const transaction = create({
      kind: Kind.Refund,
      referenceExternalTransactionId: 'external-bet',
    });

    expect(() =>
      transaction.markProcessed(undefined, new Date()),
    ).toThrow('Resolved reference is required');

    expect(transaction.status).toBe(Status.Pending);
  });

  test('rejeita transação com código de falha', () => {
    const transaction = create();

    transaction.reject(FailureCode.InsufficientFunds);

    expect(transaction.status).toBe(Status.Rejected);
    expect(transaction.failureCode)
      .toBe(FailureCode.InsufficientFunds);
    expect(transaction.isTerminal()).toBe(true);
  });

  test('registra falha permanente', () => {
    const transaction = create();

    transaction.fail(FailureCode.PermanentInfrastructureFailure);

    expect(transaction.status).toBe(Status.Failed);
    expect(transaction.isTerminal()).toBe(true);
  });

  test('LOSS não modifica saldo nem gera ledger', () => {
    const transaction = create({ kind: Kind.Loss });

    expect(transaction.affectsBalance()).toBe(false);
    expect(() => transaction.ledgerDirectionFor())
      .toThrow('LOSS does not generate ledger entries');
  });

  test('define a direção das operações financeiras', () => {
    expect(create().ledgerDirectionFor())
      .toBe(LedgerDirection.Debit);

    expect(create({ kind: Kind.Win }).ledgerDirectionFor())
      .toBe(LedgerDirection.Credit);

    expect(create({
      kind: Kind.Refund,
      referenceExternalTransactionId: 'external-bet',
    }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK inverte a direção da referência', () => {
    const rollback = create({
      kind: Kind.Rollback,
      referenceExternalTransactionId: 'external-bet',
    });

    expect(rollback.ledgerDirectionFor(
      create({ kind: Kind.Bet }),
    )).toBe(LedgerDirection.Credit);

    expect(rollback.ledgerDirectionFor(
      create({ kind: Kind.Win }),
    )).toBe(LedgerDirection.Debit);

    expect(rollback.ledgerDirectionFor(
      create({
        kind: Kind.Refund,
        referenceExternalTransactionId: 'external-bet',
      }),
    )).toBe(LedgerDirection.Debit);
  });

  test('identifica payloads iguais e diferentes', () => {
    const transaction = create();

    expect(transaction.matchesPayload('a'.repeat(64)))
      .toBe(true);

    expect(transaction.matchesPayload('b'.repeat(64)))
      .toBe(false);
  });

  test('rehydrate reconstrói estado terminal', () => {
    const transaction = WagerTransaction.rehydrate({
      ...props({ kind: Kind.Opening }),
      createdAt: new Date(),
      status: Status.Processed,
      processedAt: new Date(),
    });

    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.isTerminal()).toBe(true);
  });
});
