"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Money = void 0;
const decimal_js_1 = __importDefault(require("decimal.js"));
const MoneyDecimal = decimal_js_1.default.clone({
    precision: 50,
});
class Money {
    value;
    currency;
    static MAX_AMOUNT = new MoneyDecimal('999999999999999999.99');
    constructor(value, currency) {
        this.value = value;
        this.currency = currency;
        if (value.decimalPlaces() > 2 ||
            value.abs().greaterThan(Money.MAX_AMOUNT)) {
            throw new Error('Money amount out of range');
        }
        Object.freeze(this);
    }
    static from(props) {
        const validAmount = /^(0|[1-9]\d{0,17})\.\d{2}$/;
        if (typeof props?.amount !== 'string' ||
            !validAmount.test(props.amount)) {
            throw new Error('Invalid money amount');
        }
        if (typeof props.currency !== 'string' ||
            !/^[A-Z]{3}$/.test(props.currency)) {
            throw new Error('Invalid currency');
        }
        return new Money(new MoneyDecimal(props.amount), props.currency);
    }
    static zero(currency) {
        return Money.from({
            amount: '0.00',
            currency,
        });
    }
    add(other) {
        this.assertSameCurrency(other);
        return new Money(this.value.plus(other.value), this.currency);
    }
    subtract(other) {
        this.assertSameCurrency(other);
        return new Money(this.value.minus(other.value), this.currency);
    }
    negate() {
        if (this.isZero()) {
            return Money.zero(this.currency);
        }
        return new Money(this.value.negated(), this.currency);
    }
    isZero() {
        return this.value.isZero();
    }
    isPositive() {
        return this.value.greaterThan('0');
    }
    isNegative() {
        return this.value.lessThan('0');
    }
    isLessThan(other) {
        this.assertSameCurrency(other);
        return this.value.lessThan(other.value);
    }
    equals(other) {
        this.assertSameCurrency(other);
        return this.value.equals(other.value);
    }
    toJSON() {
        return {
            amount: this.value.toFixed(2),
            currency: this.currency,
        };
    }
    toString() {
        return `${this.value.toFixed(2)} ${this.currency}`;
    }
    assertSameCurrency(other) {
        if (this.currency !== other.currency) {
            throw new Error(`Currency mismatch: ${this.currency} and ${other.currency}`);
        }
    }
}
exports.Money = Money;
//# sourceMappingURL=money.js.map