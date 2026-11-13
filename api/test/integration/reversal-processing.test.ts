
import 'dotenv/config';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { MikroORM } from '@mikro-orm/postgresql';

import ormConfig from '../../src/mikro-orm.config';

import {
  OpenWalletUseCase,
  type OpenWalletOutput,
} from '../../src/modules/wallet/application/open-wallet.use-case';

import { ProcessBetUseCase } from '../../src/modules/wagering/application/process-bet.use-case';

import { ProcessWinLossUseCase } from '../../src/modules/wagering/application/process-win-loss.use-case';

import {
  ProcessReversalUseCase,
  type ProcessReversalInput,
} from '../../src/modules/wagering/application/process-reversal.use-case';

import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  FailureCode,
} from '../../src/modules/wagering/domain/wager-transaction';

const connectionString = process.env.DATABASE_URL;

// ==========================================
// TESTES DE INTEGRAÇÃO - REFUND E ROLLBACK
// ==========================================

describe('REFUND e ROLLBACK - PostgreSQL', () => {
  let orm: MikroORM;
  let db: Client;

  // ========================================
  // CONFIGURAÇÃO DO BANCO DE TESTES
  // ========================================

  beforeAll(async () => {
    if (
      !connectionString ||
      new URL(connectionString).pathname !== '/wagering_test'
    ) {
      throw new Error(
        'Tests require the isolated wagering_test database',
      );
    }

    orm = await MikroORM.init(ormConfig);

    db = new Client({ connectionString });

    await db.connect();
  });

  afterAll(async () => {
    if (db) {
      await db.end();
    }

    if (orm) {
      await orm.close(true);
    }
  });

  // ========================================
  // HELPERS - CRIAÇÃO DE CARTEIRA
  // ========================================

  async function openWallet(): Promise<OpenWalletOutput> {
    return new OpenWalletUseCase(orm.em.fork()).execute({
      playerId: randomUUID(),
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    });
  }

  // ========================================
  // HELPERS - PROCESSAMENTO DE BET
  // ========================================

  async function bet(
    wallet: OpenWalletOutput,
    amount: string,
    externalTransactionId = randomUUID(),
  ): Promise<string> {
    await new ProcessBetUseCase(orm.em.fork()).execute({
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-001',
      gameId: 'game-001',
      money: {
        amount,
        currency: 'BRL',
      },
    });

    return externalTransactionId;
  }

  // ========================================
  // HELPERS - PROCESSAMENTO DE WIN
  // ========================================

  async function win(
    wallet: OpenWalletOutput,
    amount: string,
  ): Promise<string> {
    const externalTransactionId = randomUUID();

    await new ProcessWinLossUseCase(orm.em.fork()).execute({
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-001',
      gameId: 'game-001',
      kind: Kind.Win,
      money: {
        amount,
        currency: 'BRL',
      },
    });

    return externalTransactionId;
  }

  // ========================================
  // HELPERS - ENTRADA DE REVERSÃO
  // ========================================

  function reversalInput(
    wallet: OpenWalletOutput,
    kind: Kind.Refund | Kind.Rollback,
    referenceExternalTransactionId: string,
    amount: string,
  ): ProcessReversalInput {
    const externalTransactionId = randomUUID();

    return {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-001',
      gameId: 'game-001',
      kind,
      money: {
        amount,
        currency: 'BRL',
      },
      referenceExternalTransactionId,
    };
  }

  // ========================================
  // HELPERS - EXECUTAR REVERSÃO
  // ========================================

  function process(input: ProcessReversalInput) {
    return new ProcessReversalUseCase(
      orm.em.fork(),
    ).execute(input);
  }

  // ========================================
  // HELPERS - CONSULTAR SALDO
  // ========================================

  async function balance(walletId: string): Promise<string> {
    const result = await db.query(
      'SELECT balance FROM wallets WHERE id = $1',
      [walletId],
    );

    return result.rows[0].balance as string;
  }

  // ========================================
  // HELPERS - CONTAR LANÇAMENTOS DO LEDGER
  // ========================================

  async function countLedger(
    walletId: string,
    kind: Kind,
  ): Promise<number> {
    const result = await db.query(
      `SELECT count(*)::int AS total
       FROM wallet_ledger_entries l
       JOIN wager_transactions t
         ON t.id = l.transaction_id
       WHERE l.wallet_id = $1
         AND t.kind = $2`,
      [walletId, kind],
    );

    return result.rows[0].total as number;
  }

  // ========================================
  // TESTE 1 - REFUND DE BET
  // ========================================

  test('REFUND devolve o valor de uma BET', async () => {
    const wallet = await openWallet();

    const betId = await bet(wallet, '80.00');

    const result = await process(
      reversalInput(
        wallet,
        Kind.Refund,
        betId,
        '80.00',
      ),
    );

    expect(result.status).toBe(Status.Processed);
    expect(result.balance.amount).toBe('100.00');

    expect(await balance(wallet.id)).toBe('100.00');

    expect(
      await countLedger(wallet.id, Kind.Refund),
    ).toBe(1);
  });

  // ========================================
  // TESTE 2 - ROLLBACK DE BET
  // ========================================

  test('ROLLBACK de BET devolve o débito', async () => {
    const wallet = await openWallet();

    const betId = await bet(wallet, '40.00');

    const result = await process(
      reversalInput(
        wallet,
        Kind.Rollback,
        betId,
        '40.00',
      ),
    );

    expect(result.status).toBe(Status.Processed);
    expect(result.balance.amount).toBe('100.00');

    expect(
      await countLedger(wallet.id, Kind.Rollback),
    ).toBe(1);
  });

  // ========================================
  // TESTE 3 - ROLLBACK DE WIN
  // ========================================

  test('ROLLBACK de WIN desconta o crédito', async () => {
    const wallet = await openWallet();

    const winId = await win(wallet, '25.00');

    const result = await process(
      reversalInput(
        wallet,
        Kind.Rollback,
        winId,
        '25.00',
      ),
    );

    expect(result.status).toBe(Status.Processed);
    expect(result.balance.amount).toBe('100.00');

    expect(
      await countLedger(wallet.id, Kind.Rollback),
    ).toBe(1);
  });

  // ========================================
  // TESTE 4 - ROLLBACK DE REFUND
  // ========================================

  test('ROLLBACK de REFUND inverte o reembolso', async () => {
    const wallet = await openWallet();

    const betId = await bet(wallet, '40.00');

    // Primeiro, processamos o reembolso da BET.
    const refund = reversalInput(
      wallet,
      Kind.Refund,
      betId,
      '40.00',
    );

    const refundResult = await process(refund);

    expect(refundResult.status).toBe(Status.Processed);
    expect(refundResult.balance.amount).toBe('100.00');

    // Depois, tentamos reverter o REFUND.
    const rollbackInput = reversalInput(
      wallet,
      Kind.Rollback,
      refund.externalTransactionId,
      '40.00',
    );

    const rollback = await process(rollbackInput);

    expect(rollback.status).toBe(Status.Processed);
    expect(rollback.balance.amount).toBe('60.00');

    expect(await balance(wallet.id)).toBe('60.00');
  });

  // ========================================
  // TESTE 5 - REFERÊNCIA FORA DE ORDEM
  // ========================================

  test('REFUND espera uma BET que ainda não chegou', async () => {
    const wallet = await openWallet();

    const missingBetId = randomUUID();

    const refund = reversalInput(
      wallet,
      Kind.Refund,
      missingBetId,
      '50.00',
    );

    // O REFUND chega antes da BET.
    const pending = await process(refund);

    expect(pending.status).toBe(Status.PendingReference);
    expect(pending.balance.amount).toBe('100.00');

    // A BET referenciada chega posteriormente.
    await bet(wallet, '50.00', missingBetId);

    // Reprocessamos o REFUND pendente.
    const processed = await process(refund);

    expect(processed.status).toBe(Status.Processed);
    expect(processed.balance.amount).toBe('100.00');

    expect(processed.transactionId).toBe(
      pending.transactionId,
    );

    // Um novo envio deve ser tratado como replay.
    const replay = await process(refund);

    expect(replay.idempotentReplay).toBe(true);

    expect(
      await countLedger(wallet.id, Kind.Refund),
    ).toBe(1);
  });

  // ========================================
  // TESTE 6 - REFUND DUPLICADO
  // ========================================

  test('impede REFUND duplicado da mesma BET', async () => {
    const wallet = await openWallet();

    const betId = await bet(wallet, '50.00');

    const first = await process(
      reversalInput(
        wallet,
        Kind.Refund,
        betId,
        '50.00',
      ),
    );

    const second = await process(
      reversalInput(
        wallet,
        Kind.Refund,
        betId,
        '50.00',
      ),
    );

    expect(first.status).toBe(Status.Processed);
    expect(second.status).toBe(Status.Rejected);

    expect(second.failureCode).toBe(
      FailureCode.ReferenceAlreadyReversed,
    );

    expect(
      await countLedger(wallet.id, Kind.Refund),
    ).toBe(1);

    expect(await balance(wallet.id)).toBe('100.00');
  });

  // ========================================
  // TESTE 7 - VALOR DIFERENTE
  // ========================================

  test('rejeita reversão com valor diferente', async () => {
    const wallet = await openWallet();

    const betId = await bet(wallet, '40.00');

    const result = await process(
      reversalInput(
        wallet,
        Kind.Refund,
        betId,
        '30.00',
      ),
    );

    expect(result.status).toBe(Status.Rejected);

    expect(result.failureCode).toBe(
      FailureCode.InvalidAmount,
    );

    expect(await balance(wallet.id)).toBe('60.00');

    expect(
      await countLedger(wallet.id, Kind.Refund),
    ).toBe(0);
  });

  // ========================================
  // TESTE 8 - REFERÊNCIA DE OUTRA RODADA
  // ========================================

  test('rejeita referência de outra rodada', async () => {
    const wallet = await openWallet();

    const betId = await bet(wallet, '40.00');

    const request = reversalInput(
      wallet,
      Kind.Refund,
      betId,
      '40.00',
    );

    const result = await process({
      ...request,
      roundId: 'round-different',
    });

    expect(result.status).toBe(Status.Rejected);

    expect(result.failureCode).toBe(
      FailureCode.InvalidReference,
    );

    expect(await balance(wallet.id)).toBe('60.00');
  });

  // ========================================
  // TESTE 9 - SALDO INSUFICIENTE NA REVERSÃO
  // ========================================

  test('ROLLBACK de WIN não permite saldo negativo', async () => {
    const wallet = await openWallet();

    const winId = await win(wallet, '25.00');

    // Saldo após WIN: R$ 125,00.
    // Após a BET de R$ 110,00: R$ 15,00.
    await bet(wallet, '110.00');

    const result = await process(
      reversalInput(
        wallet,
        Kind.Rollback,
        winId,
        '25.00',
      ),
    );

    expect(result.status).toBe(Status.Rejected);

    expect(result.failureCode).toBe(
      FailureCode.ReversalInsufficientFunds,
    );

    expect(await balance(wallet.id)).toBe('15.00');

    expect(
      await countLedger(wallet.id, Kind.Rollback),
    ).toBe(0);
  });

  // ========================================
  // TESTE 10 - IDEMPOTÊNCIA E SALDO HISTÓRICO
  // ========================================

  test('replay retorna saldo histórico do REFUND', async () => {
    const wallet = await openWallet();

    const betId = await bet(wallet, '30.00');

    const refund = reversalInput(
      wallet,
      Kind.Refund,
      betId,
      '30.00',
    );

    const first = await process(refund);

    expect(first.status).toBe(Status.Processed);
    expect(first.balance.amount).toBe('100.00');

    // Outra aposta modifica o saldo posteriormente.
    await bet(wallet, '10.00');

    const replay = await process(refund);

    // O replay preserva o resultado original.
    expect(replay.transactionId).toBe(
      first.transactionId,
    );

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.amount).toBe('100.00');

    // O saldo atual é diferente do saldo histórico.
    expect(await balance(wallet.id)).toBe('90.00');

    expect(
      await countLedger(wallet.id, Kind.Refund),
    ).toBe(1);
  });
});
