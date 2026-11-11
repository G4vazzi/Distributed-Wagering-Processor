
import { describe, expect, test } from 'bun:test';

import {
  WalletLedgerEntry,
  LedgerDirection,
  type CreateLedgerEntryProps,
} from '../../src/modules/wallet/domain/wallet-ledger-entry';

import { Money } from '../../src/shared/domain/money';

const brl = (amount: string): Money =>
  Money.from({ amount, currency: 'BRL' });

const createProps = (
  overrides: Partial<CreateLedgerEntryProps> = {},
): CreateLedgerEntryProps => ({
  id: 'ledger-001',
  walletId: 'wallet-001',
  transactionId: 'transaction-001',
  direction: LedgerDirection.Debit,
  money: brl('25.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('75.00'),
  createdAt: new Date('2026-11-11T12:00:00Z'),
  ...overrides,
});

describe('WalletLedgerEntry', () => {
  test('cria um lançamento de débito válido', () => {
    const entry = WalletLedgerEntry.create(createProps());

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toJSON().amount).toBe('75.00');
  });

  test('cria um lançamento de crédito válido', () => {
    const entry = WalletLedgerEntry.create(createProps({
      direction: LedgerDirection.Credit,
      balanceAfter: brl('125.00'),
    }));

    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toJSON().amount).toBe('125.00');
  });

  test('rejeita saldo posterior inconsistente', () => {
    expect(() =>
      WalletLedgerEntry.create(createProps({
        balanceAfter: brl('80.00'),
      })),
    ).toThrow('Ledger balance mismatch');
  });

  test('rejeita débito que deixaria saldo negativo', () => {
    expect(() =>
      WalletLedgerEntry.create(createProps({
        money: brl('150.00'),
        balanceAfter: brl('0.00'),
      })),
    ).toThrow('Ledger balance mismatch');
  });

  test('rejeita movimentação de valor zero', () => {
    expect(() =>
      WalletLedgerEntry.create(createProps({
        money: brl('0.00'),
      })),
    ).toThrow('Ledger amount must be positive');
  });

  test('rejeita moedas incompatíveis', () => {
    const usd = Money.from({
      amount: '25.00',
      currency: 'USD',
    });

    expect(() =>
      WalletLedgerEntry.create(createProps({
        money: usd,
      })),
    ).toThrow('Currency mismatch');
  });

  test('protege a data contra alterações externas', () => {
    const date = new Date('2026-11-11T12:00:00Z');

    const entry = WalletLedgerEntry.create(createProps({
      createdAt: date,
    }));

    date.setFullYear(2030);

    const returnedDate = entry.createdAt;
    returnedDate.setFullYear(2040);

    expect(entry.createdAt.getUTCFullYear()).toBe(2026);
  });

  test('reidrata um lançamento persistido', () => {
    const entry = WalletLedgerEntry.rehydrate(
      createProps({
        balanceAfter: brl('80.00'),
      }),
    );

    expect(entry.id).toBe('ledger-001');
    expect(entry.isBalanced()).toBe(false);
  });
});
