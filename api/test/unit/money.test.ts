
import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money';

const brl = (amount: string): Money =>
  Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('cria um valor monetário válido', () => {
    const money = brl('100.00');

    expect(money.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
  });

  test('soma valores com precisão', () => {
    const result = brl('0.10').add(brl('0.20'));

    expect(result.toJSON().amount).toBe('0.30');
  });

  test('subtrai valores corretamente', () => {
    const result = brl('100.00').subtract(brl('25.50'));

    expect(result.toJSON().amount).toBe('74.50');
  });

  test('permite resultado negativo interno', () => {
    const result = brl('10.00').subtract(brl('20.00'));

    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe('-10.00');
  });

  test('não modifica o valor original', () => {
    const original = brl('50.00');
    const result = original.add(brl('10.00'));

    expect(original.toJSON().amount).toBe('50.00');
    expect(result.toJSON().amount).toBe('60.00');
  });

  test('inverte o sinal', () => {
    expect(brl('25.00').negate().toJSON().amount)
      .toBe('-25.00');
  });

  test('identifica valor zero', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
  });

  test('compara valores', () => {
    expect(brl('10.00').isLessThan(brl('20.00')))
      .toBe(true);

    expect(brl('10.00').equals(brl('10.00')))
      .toBe(true);
  });

  test('rejeita moedas diferentes', () => {
    const reais = brl('100.00');
    const dollars = Money.from({
      amount: '50.00',
      currency: 'USD',
    });

    expect(() => reais.add(dollars))
      .toThrow('Currency mismatch');
  });

  test('rejeita valores monetários inválidos', () => {
    const invalidValues = [
      '-10.00',
      '10.123',
      '1e3',
      'NaN',
      'Infinity',
      '',
      '10',
      '10.0',
    ];

    for (const amount of invalidValues) {
      expect(() => brl(amount))
        .toThrow('Invalid money amount');
    }
  });

  test('preserva precisão em valores elevados', () => {
    const result = brl('999999999999999999.98')
        .add(brl('0.01'));

    expect(result.toJSON().amount)
        .toBe('999999999999999999.99');

    expect(() => {
        result.add(brl('0.01'));
    }).toThrow('Money amount out of range');
    });


    test('rejeita moedas inválidas', () => {
    const invalidCurrencies = [
        '',
        'brl',
        'BR',
        'BRLL',
        '123',
    ];

    for (const currency of invalidCurrencies) {
        expect(() =>
        Money.from({
            amount: '100.00',
            currency,
        }),
        ).toThrow('Invalid currency');
    }
    });

});
