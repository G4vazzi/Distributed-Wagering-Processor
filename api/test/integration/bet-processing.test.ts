
import 'dotenv/config';

import {
  beforeAll,
  afterAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { MikroORM } from '@mikro-orm/postgresql';

import ormConfig from '../../src/mikro-orm.config';

import { OpenWalletUseCase } from
  '../../src/modules/wallet/application/open-wallet.use-case';

import {
  ProcessBetUseCase,
  type ProcessBetInput,
} from '../../src/modules/wagering/application/process-bet.use-case';

import {
  WagerTransactionStatus,
  FailureCode,
} from '../../src/modules/wagering/domain/wager-transaction';

import type { OpenWalletOutput } from
  '../../src/modules/wallet/application/open-wallet.use-case';

const connectionString = process.env.DATABASE_URL;

describe('BET - PostgreSQL e concorrência real', () => {
  let orm: MikroORM;
  let db: Client;

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
    if (db) await db.end();
    if (orm) await orm.close(true);
  });

  async function openWallet(): Promise<OpenWalletOutput> {
    return new OpenWalletUseCase(orm.em.fork()).execute({
      playerId: randomUUID(),
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    });
  }

  function betInput(
    wallet: OpenWalletOutput,
    externalTransactionId: string,
    amount = '80.00',
  ): ProcessBetInput {
    return {
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
    };
  }

  function processBet(input: ProcessBetInput) {
    // Um EntityManager independente por operação.
    return new ProcessBetUseCase(
      orm.em.fork(),
    ).execute(input);
  }

  async function readBalance(walletId: string) {
    const result = await db.query(
      `SELECT balance, version
       FROM wallets WHERE id = $1`,
      [walletId],
    );

    return result.rows[0];
  }

  async function countDebits(walletId: string): Promise<number> {
    const result = await db.query(
      `SELECT count(*)::int AS total
       FROM wallet_ledger_entries
       WHERE wallet_id = $1
         AND direction = 'DEBIT'`,
      [walletId],
    );

    return result.rows[0].total as number;
  }

  test('processa BET e registra ledger e Outbox', async () => {
    const wallet = await openWallet();

    const result = await processBet(
      betInput(wallet, randomUUID(), '25.00'),
    );

    expect(result.status).toBe(
      WagerTransactionStatus.Processed,
    );

    expect(result.balance.amount).toBe('75.00');
    expect(result.idempotentReplay).toBe(false);

    const stored = await readBalance(wallet.id);

    expect(stored.balance).toBe('75.00');
    expect(stored.version).toBe(2);
    expect(await countDebits(wallet.id)).toBe(1);

    const events = await db.query(
      `SELECT event_type
       FROM outbox_messages
       WHERE aggregate_id = $1
       ORDER BY event_type`,
      [wallet.id],
    );

    expect(events.rows.map(row => row.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('rejeita BET sem saldo suficiente', async () => {
    const wallet = await openWallet();

    const result = await processBet(
      betInput(wallet, randomUUID(), '150.00'),
    );

    expect(result.status).toBe(
      WagerTransactionStatus.Rejected,
    );

    expect(result.failureCode).toBe(
      FailureCode.InsufficientFunds,
    );

    expect(result.balance.amount).toBe('100.00');
    expect(await countDebits(wallet.id)).toBe(0);

    const stored = await readBalance(wallet.id);

    expect(stored.version).toBe(1);

    const events = await db.query(
      `SELECT event_type FROM outbox_messages
       WHERE aggregate_id = $1`,
      [wallet.id],
    );

    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].event_type)
      .toBe('WagerTransactionRejected');
  });

  test('duas BET de 80 disputam o mesmo saldo', async () => {
    const wallet = await openWallet();

    const [first, second] = await Promise.all([
      processBet(betInput(wallet, randomUUID())),
      processBet(betInput(wallet, randomUUID())),
    ]);

    const results = [first, second];

    expect(
      results.filter(
        result =>
          result.status === WagerTransactionStatus.Processed,
      ),
    ).toHaveLength(1);

    expect(
      results.filter(
        result =>
          result.status === WagerTransactionStatus.Rejected,
      ),
    ).toHaveLength(1);

    const stored = await readBalance(wallet.id);

    expect(stored.balance).toBe('20.00');
    expect(stored.version).toBe(2);
    expect(await countDebits(wallet.id)).toBe(1);
  }, 30_000);

  test('50 BET idênticas geram somente um débito', async () => {
    const wallet = await openWallet();

    const input = betInput(wallet, randomUUID());

    const results = await Promise.all(
      Array.from({ length: 50 }, () => processBet(input)),
    );

    expect(
      new Set(results.map(r => r.transactionId)).size,
    ).toBe(1);

    expect(results.every(
      r => r.status === WagerTransactionStatus.Processed,
    )).toBe(true);

    expect(
      results.filter(r => !r.idempotentReplay),
    ).toHaveLength(1);

    expect(
      results.filter(r => r.idempotentReplay),
    ).toHaveLength(49);

    expect(results.every(
      r => r.balance.amount === '20.00',
    )).toBe(true);

    const stored = await readBalance(wallet.id);

    expect(stored.balance).toBe('20.00');
    expect(stored.version).toBe(2);
    expect(await countDebits(wallet.id)).toBe(1);

    const events = await db.query(
      `SELECT count(*)::int AS total
       FROM outbox_messages
       WHERE aggregate_id = $1`,
      [wallet.id],
    );

    expect(events.rows[0].total).toBe(2);
  }, 60_000);

  test('mesma key com payload diferente gera conflito', async () => {
    const wallet = await openWallet();

    const input = betInput(wallet, randomUUID(), '25.00');

    await processBet(input);

    await expect(
      processBet({
        ...input,
        money: {
          amount: '50.00',
          currency: 'BRL',
        },
      }),
    ).rejects.toThrow('Idempotency key conflict');

    const stored = await readBalance(wallet.id);

    expect(stored.balance).toBe('75.00');
    expect(await countDebits(wallet.id)).toBe(1);
  });
});
