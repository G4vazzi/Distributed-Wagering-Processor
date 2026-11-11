
import { Money } from '../../../shared/domain/money';

import {
  LedgerDirection,
  WalletLedgerEntry,
} from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId?: string;
  openingLedgerEntryId?: string;
  createdAt?: Date;
}

export interface OpenWalletResult {
  wallet: Wallet;
  openingEntry?: WalletLedgerEntry;
}

export interface WalletMovementProps {
  transactionId: string;
  ledgerEntryId: string;
  money: Money;
  occurredAt?: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenWalletResult {
    if (!props.id || !props.playerId) {
      throw new Error('Missing wallet identifiers');
    }

    if (props.initialBalance.isNegative()) {
      throw new Error('Initial balance cannot be negative');
    }

    const now = new Date(
      props.createdAt?.getTime() ?? Date.now(),
    );

    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      new Date(now),
      new Date(now),
    );

    if (props.initialBalance.isZero()) {
      return { wallet };
    }

    if (
      !props.openingTransactionId ||
      !props.openingLedgerEntryId
    ) {
      throw new Error('Missing opening identifiers');
    }

    const openingEntry = WalletLedgerEntry.create({
      id: props.openingLedgerEntryId,
      walletId: wallet.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: props.initialBalance,
      createdAt: now,
    });

    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    return this.applyMovement(
      props,
      LedgerDirection.Debit,
    );
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    return this.applyMovement(
      props,
      LedgerDirection.Credit,
    );
  }

  private applyMovement(
    props: WalletMovementProps,
    direction: LedgerDirection,
  ): WalletLedgerEntry {
    this.assertSameCurrency(props.money);

    if (!props.money.isPositive()) {
      throw new Error('Movement amount must be positive');
    }

    if (
      direction === LedgerDirection.Debit &&
      this._balance.isLessThan(props.money)
    ) {
      throw new Error('Insufficient wallet balance');
    }

    const balanceBefore = this._balance;

    const balanceAfter =
      direction === LedgerDirection.Credit
        ? balanceBefore.add(props.money)
        : balanceBefore.subtract(props.money);

    const occurredAt = new Date(
      props.occurredAt?.getTime() ?? Date.now(),
    );

    // O ledger é validado antes de alterar a wallet.
    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore,
      balanceAfter,
      createdAt: occurredAt,
    });

    // Só modifica o estado após criar o lançamento.
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date(occurredAt);

    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new Error(
        `Currency mismatch: ${this.currency} and ${money.currency}`,
      );
    }
  }
}
