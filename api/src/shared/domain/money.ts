
import Decimal from 'decimal.js';

const MoneyDecimal = Decimal.clone({
    precision: 50,
});

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private static readonly MAX_AMOUNT = new MoneyDecimal(
    '999999999999999999.99',
  );

  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    if (
      value.decimalPlaces() > 2 ||
      value.abs().greaterThan(Money.MAX_AMOUNT)
    ) {
      throw new Error('Money amount out of range');
    }

    Object.freeze(this);
  }

  
  static from(props: MoneyProps): Money {
    // Validar formato do valor monetário
    const validAmount = /^(0|[1-9]\d{0,17})\.\d{2}$/;

    if (
        typeof props?.amount !== 'string' ||
        !validAmount.test(props.amount)
    ) {
        throw new Error('Invalid money amount');
    }

    // Validar formato da moeda
    if (
        typeof props.currency !== 'string' ||
        !/^[A-Z]{3}$/.test(props.currency)
    ) {
        throw new Error('Invalid currency');
    }

    // Criar o valor com precisão de 50 dígitos
    return new Money(
        new MoneyDecimal(props.amount),
        props.currency,
    );
  }


  static zero(currency: string): Money {
    return Money.from({
      amount: '0.00',
      currency,
    });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(
      this.value.plus(other.value),
      this.currency,
    );
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(
      this.value.minus(other.value),
      this.currency,
    );
  }

  negate(): Money {
    if (this.isZero()) {
      return Money.zero(this.currency);
    }

    return new Money(
      this.value.negated(),
      this.currency,
    );
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan('0');
  }

  isNegative(): boolean {
    return this.value.lessThan('0');
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Currency mismatch: ${this.currency} and ${other.currency}`,
      );
    }
  }
}
