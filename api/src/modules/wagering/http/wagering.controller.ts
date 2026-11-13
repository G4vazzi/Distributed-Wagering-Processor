
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';

import { EntityManager } from '@mikro-orm/postgresql';

import {
  Money,
  type MoneyProps,
} from '../../../shared/domain/money';

import { WalletRecord } from '../../../infrastructure/database/entities/wallet-record.entity';

import { WagerTransactionRecord } from '../../../infrastructure/database/entities/wager-transaction-record.entity';

import { OpenWalletUseCase } from '../../wallet/application/open-wallet.use-case';

import {
  IdempotencyConflictError,
  ProcessBetUseCase,
} from '../application/process-bet.use-case';

import { ProcessWinLossUseCase } from '../application/process-win-loss.use-case';

import { ProcessReversalUseCase } from '../application/process-reversal.use-case';

import {
  WagerTransactionKind as Kind,
} from '../domain/wager-transaction';

// ==========================================
// VALIDAÇÃO DE ENTRADA
// ==========================================

function asObject(
  value: unknown,
  field = 'body',
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new BadRequestException(
      `${field} must be an object`,
    );
  }

  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  field: string,
  maxLength = 128,
): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maxLength
  ) {
    throw new BadRequestException(
      `Invalid or missing field: ${field}`,
    );
  }

  return value.trim();
}

function parseMoney(
  input: unknown,
  allowZero = false,
): MoneyProps {
  const data = asObject(input, 'money');

  const amount = requiredString(
    data.amount,
    'money.amount',
    64,
  );

  const currency = requiredString(
    data.currency,
    'money.currency',
    3,
  );

  let money: Money;

  try {
    money = Money.from({ amount, currency });
  } catch {
    throw new BadRequestException(
      'Invalid monetary value or currency',
    );
  }

  if (
    !money.isPositive() &&
    !(allowZero && money.isZero())
  ) {
    throw new BadRequestException(
      'Amount must be greater than zero',
    );
  }

  return money.toJSON();
}

// ==========================================
// CONTROLLER
// ==========================================

@Controller('v1')
export class WageringController {
  constructor(
    private readonly em: EntityManager,
  ) {}

  // ========================================
  // HEALTH CHECK
  // ========================================

  @Get('health')
  async health() {
    await this.em.getConnection().execute(
      'SELECT 1',
    );

    return {
      status: 'ok',
      service: 'distributed-wagering-processor',
      database: 'connected',
    };
  }

  // ========================================
  // ABRIR CARTEIRA
  // ========================================

  @Post('wallets')
  async openWallet(
    @Body() body: unknown,
  ) {
    const data = asObject(body);

    const input = {
      playerId: requiredString(
        data.playerId,
        'playerId',
        36,
      ),
      initialBalance: parseMoney(
        data.initialBalance,
        true,
      ),
    };

    try {
      return await new OpenWalletUseCase(
        this.em,
      ).execute(input);
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (
          error.name === 'UniqueConstraintViolationException' ||
          error.message.includes('duplicate key')
        )
      ) {
        throw new ConflictException(
          'Wallet already exists for this player and currency',
        );
      }

      throw error;
    }
  }

  // ========================================
  // CONSULTAR CARTEIRA
  // ========================================

  @Get('wallets/:id')
  async getWallet(
    @Param('id') id: string,
  ) {
    const wallet = await this.em.findOne(
      WalletRecord,
      { id },
    );

    if (!wallet) {
      throw new NotFoundException(
        'Wallet not found',
      );
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: {
        amount: wallet.balance,
        currency: wallet.currency,
      },
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  // ========================================
  // PROCESSAR TRANSAÇÃO FINANCEIRA
  // ========================================

  @Post('transactions')
  @HttpCode(200)
  async processTransaction(
    @Body() body: unknown,
    @Headers('idempotency-key')
    headerKey: string | undefined,
  ) {
    const data = asObject(body);

    const kind = requiredString(
      data.kind,
      'kind',
      20,
    );

    const input = {
      providerId: requiredString(
        data.providerId,
        'providerId',
      ),
      externalTransactionId: requiredString(
        data.externalTransactionId,
        'externalTransactionId',
      ),
      idempotencyKey: requiredString(
        headerKey,
        'Idempotency-Key header',
        256,
      ),
      playerId: requiredString(
        data.playerId,
        'playerId',
        36,
      ),
      walletId: requiredString(
        data.walletId,
        'walletId',
        36,
      ),
      roundId: requiredString(
        data.roundId,
        'roundId',
      ),
      gameId: requiredString(
        data.gameId,
        'gameId',
      ),
      money: parseMoney(data.money),
    };

    try {
      if (kind === Kind.Bet) {
        return await new ProcessBetUseCase(
          this.em,
        ).execute(input);
      }

      if (
        kind === Kind.Win ||
        kind === Kind.Loss
      ) {
        return await new ProcessWinLossUseCase(
          this.em,
        ).execute({
          ...input,
          kind,
        });
      }

      if (
        kind === Kind.Refund ||
        kind === Kind.Rollback
      ) {
        return await new ProcessReversalUseCase(
          this.em,
        ).execute({
          ...input,
          kind,
          referenceExternalTransactionId:
            requiredString(
              data.referenceExternalTransactionId,
              'referenceExternalTransactionId',
            ),
        });
      }

      throw new BadRequestException(
        `Unsupported transaction kind: ${kind}`,
      );
    } catch (error: unknown) {
      if (
        error instanceof IdempotencyConflictError
      ) {
        throw new ConflictException(
          error.message,
        );
      }

      if (error instanceof Error) {
        if (
          error.message === 'Wallet not found' ||
          error.message ===
            'Wallet does not belong to player'
        ) {
          throw new NotFoundException(
            'Wallet not found',
          );
        }

        if (
          error.message === 'Currency mismatch'
        ) {
          throw new BadRequestException(
            'Wallet currency does not match transaction currency',
          );
        }
      }

      throw error;
    }
  }

  // ========================================
  // CONSULTAR TRANSAÇÃO
  // ========================================

  @Get('transactions/:id')
  async getTransaction(
    @Param('id') id: string,
  ) {
    const transaction = await this.em.findOne(
      WagerTransactionRecord,
      { id },
    );

    if (!transaction) {
      throw new NotFoundException(
        'Transaction not found',
      );
    }

    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId:
        transaction.externalTransactionId,
      playerId: transaction.playerId,
      walletId: transaction.walletId,
      kind: transaction.kind,
      status: transaction.status,
      money: {
        amount: transaction.amount,
        currency: transaction.currency,
      },
      balance: transaction.resultBalance == null
        ? null
        : {
            amount: transaction.resultBalance,
            currency: transaction.currency,
          },
      failureCode: transaction.failureCode,
      referenceExternalTransactionId:
        transaction.referenceExternalTransactionId,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt,
    };
  }
}
