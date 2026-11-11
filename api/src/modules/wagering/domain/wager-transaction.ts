
import { Money } from '../../../shared/domain/money';
import { LedgerDirection } from '../../wallet/domain/wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  InvalidReference = 'INVALID_REFERENCE',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  InvalidAmount = 'INVALID_AMOUNT',
  PermanentInfrastructureFailure = 'PERMANENT_INFRASTRUCTURE_FAILURE',
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState
  extends Omit<CreateWagerTransactionProps, 'createdAt'> {
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId?: string;

  private readonly _createdAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId?: string;
  private _failureCode?: FailureCode;
  private _processedAt?: Date;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId =
      state.referenceExternalTransactionId;

    this._createdAt = new Date(state.createdAt);
    this._status = state.status;
    this._referenceTransactionId =
      state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt
      ? new Date(state.processedAt)
      : undefined;
  }

  static create(
    props: CreateWagerTransactionProps,
  ): WagerTransaction {
    const identifiers = [
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
    ];

    if (identifiers.some(
      value => typeof value !== 'string' || !value.trim(),
    )) {
      throw new Error('Missing transaction identifiers');
    }

    if (
      !Object.values(WagerTransactionKind).includes(props.kind) ||
      props.kind === WagerTransactionKind.Opening
    ) {
      throw new Error('Invalid external transaction kind');
    }

    if (!/^[a-f0-9]{64}$/i.test(props.payloadHash)) {
      throw new Error('Invalid payload hash');
    }

    if (!props.money.isPositive()) {
      throw new Error('Transaction amount must be positive');
    }

    if (
      props.referenceExternalTransactionId !== undefined &&
      !props.referenceExternalTransactionId.trim()
    ) {
      throw new Error('Invalid reference');
    }

    if (
      [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]
        .includes(props.kind) &&
      !props.referenceExternalTransactionId
    ) {
      throw new Error('Transaction reference is required');
    }

    return new WagerTransaction({
      ...props,
      createdAt: new Date(props.createdAt ?? Date.now()),
      status: WagerTransactionStatus.Pending,
    });
  }

  static rehydrate(
    state: WagerTransactionState,
  ): WagerTransaction {
    return new WagerTransaction(state);
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt
      ? new Date(this._processedAt)
      : undefined;
  }

  isTerminal(): boolean {
    return [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ].includes(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return [
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ].includes(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markPendingReference(): void {
    this.assertNotTerminal();

    if (!this.referenceExternalTransactionId) {
      throw new Error('Transaction has no reference');
    }

    this._status = WagerTransactionStatus.PendingReference;
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
  ): void {
    this.assertNotTerminal();

    if (this.requiresReference() && !referenceTransactionId) {
      throw new Error('Resolved reference is required');
    }

    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = new Date(at);
    this._status = WagerTransactionStatus.Processed;
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal();

    this._failureCode = code;
    this._status = WagerTransactionStatus.Rejected;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal();

    this._failureCode = code;
    this._status = WagerTransactionStatus.Failed;
  }

  ledgerDirectionFor(
    reference?: WagerTransaction,
  ): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;

      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;

      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new Error('Rollback reference is required');
        }

        if (reference.kind === WagerTransactionKind.Bet) {
          return LedgerDirection.Credit;
        }

        if (
          reference.kind === WagerTransactionKind.Win ||
          reference.kind === WagerTransactionKind.Refund
        ) {
          return LedgerDirection.Debit;
        }

        throw new Error('Invalid rollback reference kind');

      case WagerTransactionKind.Loss:
        throw new Error('LOSS does not generate ledger entries');
    }
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new Error('InvalidTransactionStateError');
    }
  }
}
