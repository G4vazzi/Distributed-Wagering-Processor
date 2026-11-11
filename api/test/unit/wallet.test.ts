
import { describe, expect, test } from 'bun:test';

import { Wallet } from '../../src/modules/wallet/domain/wallet';

import { LedgerDirection } from
  '../../src/modules/wallet/domain/wallet-ledger-entry';

import { Money } from '../../src/shared/domain/money';

const brl = (amount: string): Money =>
  Money.from({ amount, currency: 'BRL' });

const openWallet = (balance = '100.00') =>
  Wallet.open({
    id: 'wallet-001',
    playerId: 'player-001',
    initialBalance: brl(balance),
    openingTransactionId: 'opening-001',
    openingLedgerEntryId: 'ledger-opening-001',
  });

const movement = (amount: string) => ({
  transactionId: 'transaction-001',
  ledgerEntryId: 'ledger-001',
  money: brl(amount),
});

describe('Wallet', () => {
  test('cria uma carteira com saldo inicial', () => {
    const { wallet, openingEntry } = openWallet();

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);

    expect(openingEntry?.direction)
      .toBe(LedgerDirection.Credit);

    expect(openingEntry?.balanceBefore.toJSON().amount)
      .toBe('0.00');

    expect(openingEntry?.isBalanced()).toBe(true);
  });

  test('cria carteira zerada sem lançamento', () => {
    const { wallet, openingEntry } = openWallet('0.00');

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('exige identificadores para crédito inicial', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-001',
        playerId: 'player-001',
        initialBalance: brl('100.00'),
      }),
    ).toThrow('Missing opening identifiers');
  });

  test('realiza débito e gera ledger', () => {
    const { wallet } = openWallet();

    const entry = wallet.debit(movement('25.00'));

    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.isBalanced()).toBe(true);
  });

  test('realiza crédito e gera ledger', () => {
    const { wallet } = openWallet();

    const entry = wallet.credit(movement('50.00'));

    expect(wallet.balance.toJSON().amount).toBe('150.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
  });

  test('rejeita débito sem saldo suficiente', () => {
    const { wallet } = openWallet();

    expect(() =>
      wallet.debit(movement('150.00')),
    ).toThrow('Insufficient wallet balance');

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('permite utilizar todo o saldo', () => {
    const { wallet } = openWallet();

    wallet.debit(movement('100.00'));

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(2);
  });

  test('rejeita movimentação de valor zero', () => {
    const { wallet } = openWallet();

    expect(() =>
      wallet.credit(movement('0.00')),
    ).toThrow('Movement amount must be positive');

    expect(wallet.version).toBe(1);
  });

  test('rejeita moeda diferente', () => {
    const { wallet } = openWallet();

    expect(() =>
      wallet.debit({
        ...movement('10.00'),
        money: Money.from({
          amount: '10.00',
          currency: 'USD',
        }),
      }),
    ).toThrow('Currency mismatch');

    expect(wallet.version).toBe(1);
  });

  test('incrementa versão a cada movimentação', () => {
    const { wallet } = openWallet();

    wallet.debit(movement('20.00'));

    wallet.credit({
      ...movement('10.00'),
      transactionId: 'transaction-002',
      ledgerEntryId: 'ledger-002',
    });

    expect(wallet.balance.toJSON().amount).toBe('90.00');
    expect(wallet.version).toBe(3);
  });

  test('não altera saldo em erro de valor máximo', () => {
    const { wallet } = openWallet(
      '999999999999999999.99',
    );

    expect(() =>
      wallet.credit(movement('0.01')),
    ).toThrow('Money amount out of range');

    expect(wallet.balance.toJSON().amount)
      .toBe('999999999999999999.99');

    expect(wallet.version).toBe(1);
  });

  test('rehydrate preserva o estado persistido', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-001',
      playerId: 'player-001',
      currency: 'BRL',
      balance: brl('75.00'),
      version: 5,
      createdAt: new Date('2026-11-01T12:00:00Z'),
      updatedAt: new Date('2026-11-11T12:00:00Z'),
    });

    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(5);
    expect(wallet.currency).toBe('BRL');
  });

  test('protege as datas de alterações externas', () => {
    const { wallet } = openWallet();

    const date = wallet.createdAt;
    date.setFullYear(2035);

    expect(wallet.createdAt.getFullYear())
      .not.toBe(2035);
  });
});
