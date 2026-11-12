
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

describe('OpenWallet - PostgreSQL', () => {
  let orm: MikroORM;
  let db: Client;

  const createdWalletIds: string[] = [];

  beforeAll(async () => {
    orm = await MikroORM.init(ormConfig);

    db = new Client({
      connectionString: process.env.DATABASE_URL,
    });

    await db.connect();
  });

  afterAll(async () => {
    try {
      if (createdWalletIds.length > 0) {
        await db.query(
          `DELETE FROM wallet_ledger_entries
           WHERE wallet_id = ANY($1::uuid[])`,
          [createdWalletIds],
        );

        await db.query(
          `DELETE FROM wager_transactions
           WHERE wallet_id = ANY($1::uuid[])`,
          [createdWalletIds],
        );

        await db.query(
          `DELETE FROM wallets
           WHERE id = ANY($1::uuid[])`,
          [createdWalletIds],
        );
      }
    } finally {
      await db.end();
      await orm.close(true);
    }
  });

  const useCase = () =>
    new OpenWalletUseCase(orm.em.fork());

  test('cria wallet, OPENING e ledger juntos', async () => {
    const result = await useCase().execute({
      playerId: randomUUID(),
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    });

    createdWalletIds.push(result.id);

    expect(result.balance.amount).toBe('100.00');
    expect(result.version).toBe(1);
    expect(result.openingTransactionId).toBeDefined();

    const wallet = await db.query(
      'SELECT balance FROM wallets WHERE id = $1',
      [result.id],
    );

    expect(wallet.rows[0].balance).toBe('100.00');

    const transaction = await db.query(
      `SELECT kind, status
       FROM wager_transactions
       WHERE wallet_id = $1`,
      [result.id],
    );

    expect(transaction.rows).toHaveLength(1);
    expect(transaction.rows[0].kind).toBe('OPENING');
    expect(transaction.rows[0].status).toBe('PROCESSED');

    const ledger = await db.query(
      `SELECT direction, amount,
              balance_before, balance_after
       FROM wallet_ledger_entries
       WHERE wallet_id = $1`,
      [result.id],
    );

    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].direction).toBe('CREDIT');
    expect(ledger.rows[0].amount).toBe('100.00');
    expect(ledger.rows[0].balance_before).toBe('0.00');
    expect(ledger.rows[0].balance_after).toBe('100.00');
  });

  test('cria wallet zerada sem OPENING', async () => {
    const result = await useCase().execute({
      playerId: randomUUID(),
      initialBalance: {
        amount: '0.00',
        currency: 'BRL',
      },
    });

    createdWalletIds.push(result.id);

    expect(result.balance.amount).toBe('0.00');
    expect(result.openingTransactionId).toBeUndefined();

    const ledger = await db.query(
      `SELECT id
       FROM wallet_ledger_entries
       WHERE wallet_id = $1`,
      [result.id],
    );

    expect(ledger.rows).toHaveLength(0);
  });

  test('impede duas wallets do mesmo jogador', async () => {
    const playerId = randomUUID();

    const first = await useCase().execute({
      playerId,
      initialBalance: {
        amount: '50.00',
        currency: 'BRL',
      },
    });

    createdWalletIds.push(first.id);

    await expect(
      useCase().execute({
        playerId,
        initialBalance: {
          amount: '100.00',
          currency: 'BRL',
        },
      }),
    ).rejects.toThrow();

    const wallets = await db.query(
      `SELECT id, balance
       FROM wallets
       WHERE player_id = $1`,
      [playerId],
    );

    expect(wallets.rows).toHaveLength(1);
    expect(wallets.rows[0].balance).toBe('50.00');
  });
});
