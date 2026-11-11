export interface MoneyProps {
    amount: string;
    currency: string;
}
export declare class Money {
    private readonly value;
    readonly currency: string;
    private static readonly MAX_AMOUNT;
    private constructor();
    static from(props: MoneyProps): Money;
    static zero(currency: string): Money;
    add(other: Money): Money;
    subtract(other: Money): Money;
    negate(): Money;
    isZero(): boolean;
    isPositive(): boolean;
    isNegative(): boolean;
    isLessThan(other: Money): boolean;
    equals(other: Money): boolean;
    toJSON(): MoneyProps;
    toString(): string;
    private assertSameCurrency;
}
