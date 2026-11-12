
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

import { OpenWalletUseCase } from
  '../../src/modules/wallet/application/open-wallet.use-case';

import type { OpenWalletOutput } from
  '../../src/modules/wallet/application/open-wallet.use-case';

import { ProcessBetUseCase } from
  '../../src/modules/wagering/application/process-bet.use-case';

import {
  ProcessWinLossUseCase,
  type ProcessWinLossInput,
} from '../../src/modules/wagering/application/process-win-loss.use-case';

import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/modules/wagering/domain/wager-transaction';

const connectionString = process.env.DATABASE_URL;

describe('WIN e LOSS - PostgreSQL', () => {
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

  function input(
    wallet: OpenWalletOutput,
    kind: Kind.Win | Kind.Loss,
    amount = '25.00',
  ): ProcessWinLossInput {
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
    };
  }

  function process(inputData: ProcessWinLossInput) {
    return new ProcessWinLossUseCase(
      orm.em.fork(),
    ).execute(inputData);
  }

  async function readBalance(walletId: string) {
    const result = await db.query(
      `SELECT balance, version
       FROM wallets WHERE id = $1`,
      [walletId],
    );

    return result.rows[0];
  }

  async function countKindLedger(
    walletId: string,
    kind: Kind.Win | Kind.Loss,
  ): Promise<number> {
    const result = await db.query(
      `SELECT count(*)::int AS total
       FROM wallet_ledger_entries l
       JOIN wager_transactions t
         ON t.id = l.transaction_id
       WHERE l.wallet_id = $1 AND t.kind = $2`,
      [walletId, kind],
    );

    return result.rows[0].total as number;
  }

  async function countEvents(walletId: string) {
    const result = await db.query(
      `SELECT count(*)::int AS total
       FROM outbox_messages
       WHERE aggregate_id = $1`,
      [walletId],
    );

    return result.rows[0].total as number;
  }

  test('WIN credita saldo e gera ledger', async () => {
    const wallet = await openWallet();

    const result = await process(
      input(wallet, Kind.Win, '25.00'),
    );

    expect(result.status).toBe(Status.Processed);
    expect(result.balance.amount).toBe('125.00');
    expect(result.idempotentReplay).toBe(false);

    const stored = await readBalance(wallet.id);

    expect(stored.balance).toBe('125.00');
    expect(stored.version).toBe(2);
    expect(await countKindLedger(wallet.id, Kind.Win))
      .toBe(1);

    expect(await countEvents(wallet.id)).toBe(2);
  });

  test('LOSS não modifica saldo ou ledger', async () => {
    const wallet = await openWallet();

    const result = await process(
      input(wallet, Kind.Loss, '25.00'),
    );

    expect(result.status).toBe(Status.Processed);
    expect(result.balance.amount).toBe('100.00');

    const stored = await readBalance(wallet.id);

    expect(stored.balance).toBe('100.00');
    expect(stored.version).toBe(1);
    expect(await countKindLedger(wallet.id, Kind.Loss))
      .toBe(0);

    expect(await countEvents(wallet.id)).toBe(1);

    const events = await db.query(
      `SELECT event_type
       FROM outbox_messages
       WHERE aggregate_id = $1`,
      [wallet.id],
    );

    expect(events.rows[0].event_type)
      .toBe('WagerTransactionProcessed');
  });

  test('replay de WIN retorna o saldo original', async () => {
    const wallet = await openWallet();
    const win = input(wallet, Kind.Win);

    const first = await process(win);

    expect(first.balance.amount).toBe('125.00');

    // Outra operação modifica o saldo posteriormente.
    const betId = randomUUID();

    await new ProcessBetUseCase(orm.em.fork()).execute({
      providerId: 'provider-a',
      externalTransactionId: betId,
      idempotencyKey: `provider-a:${betId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-002',
      gameId: 'game-001',
      money: {
        amount: '10.00',
        currency: 'BRL',
      },
    });

    const replay = await process(win);

    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.amount).toBe('125.00');

    const stored = await readBalance(wallet.id);

    expect(stored.balance).toBe('115.00');
    expect(await countKindLedger(wallet.id, Kind.Win))
      .toBe(1);
    expect(await countEvents(wallet.id)).toBe(4);
  });

  test('replay de LOSS não duplica eventos', async () => {
    const wallet = await openWallet();
    const loss = input(wallet, Kind.Loss);

    const first = await process(loss);
    const replay = await process(loss);

    expect(first.transactionId).toBe(replay.transactionId);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.amount).toBe('100.00');

    expect(await countEvents(wallet.id)).toBe(1);
    expect(await countKindLedger(wallet.id, Kind.Loss))
      .toBe(0);
  });

  test('mesma key com payload diferente gera conflito', async () => {
    const wallet = await openWallet();
    const win = input(wallet, Kind.Win);

    await process(win);

    await expect(
      process({
        ...win,
        money: {
          amount: '50.00',
          currency: 'BRL',
        },
      }),
    ).rejects.toThrow('Idempotency key conflict');

    expect((await readBalance(wallet.id)).balance)
      .toBe('125.00');
    expect(await countEvents(wallet.id)).toBe(2);
  });

  test('duas WIN simultâneas creditam exatamente uma vez cada', async () => {
    const wallet = await openWallet();

    const [first, second] = await Promise.all([
      process(input(wallet, Kind.Win, '20.00')),
      process(input(wallet, Kind.Win, '15.00')),
    ]);

    expect(first.status).toBe(Status.Processed);
    expect(second.status).toBe(Status.Processed);

    const stored = await readBalance(wallet.id);

    expect(stored.balance).toBe('135.00');
    expect(stored.version).toBe(3);

    expect(await countKindLedger(wallet.id, Kind.Win))
      .toBe(2);

    expect(await countEvents(wallet.id)).toBe(4);
  }, 30_000);
});
