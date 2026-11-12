
import 'dotenv/config';

import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/modules/wagering/domain/wager-transaction';

import {
  LedgerDirection,
} from '../../src/modules/wallet/domain/wallet-ledger-entry';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { randomUUID } from 'node:crypto';
import {
  EntityManager,
  MikroORM,
} from '@mikro-orm/postgresql';

import ormConfig from '../../src/mikro-orm.config';

import { OpenWalletUseCase } from
  '../../src/modules/wallet/application/open-wallet.use-case';

import { WalletRecord } from
  '../../src/infrastructure/database/entities/wallet-record.entity';

import { WagerTransactionRecord } from
  '../../src/infrastructure/database/entities/wager-transaction-record.entity';

import { WalletLedgerEntryRecord } from
  '../../src/infrastructure/database/entities/wallet-ledger-entry-record.entity';

class TestRollback extends Error {}

describe('OpenWallet - PostgreSQL', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(ormConfig);
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  async function withRollback(
    callback: (em: EntityManager) => Promise<void>,
  ): Promise<void> {
    const em = orm.em.fork();

    try {
      await em.transactional(async (tx) => {
        await callback(tx);

        // Desfaz todos os registros criados pelo teste.
        throw new TestRollback();
      });
    } catch (error) {
      if (!(error instanceof TestRollback)) {
        throw error;
      }
    }
  }

  test('cria wallet, OPENING e ledger juntos', async () => {
    await withRollback(async (em) => {
      const result = await new OpenWalletUseCase(em)
        .execute({
          playerId: randomUUID(),
          initialBalance: {
            amount: '100.00',
            currency: 'BRL',
          },
        });

      expect(result.balance.amount).toBe('100.00');
      expect(result.version).toBe(1);
      expect(result.openingTransactionId).toBeDefined();

      const wallet = await em.findOneOrFail(
        WalletRecord,
        { id: result.id },
      );

      expect(wallet.balance).toBe('100.00');

      const transactions = await em.find(
        WagerTransactionRecord,
        { walletId: result.id },
      );

      expect(transactions).toHaveLength(1);
      expect(transactions[0].kind).toBe(WagerTransactionKind.Opening);
      expect(transactions[0].status).toBe(WagerTransactionStatus.Processed);

      const ledger = await em.find(
        WalletLedgerEntryRecord,
        { walletId: result.id },
      );

      expect(ledger).toHaveLength(1);
      expect(ledger[0].direction).toBe(LedgerDirection.Credit);
      expect(ledger[0].amount).toBe('100.00');
      expect(ledger[0].balanceBefore).toBe('0.00');
      expect(ledger[0].balanceAfter).toBe('100.00');
    });
  });

  test('cria wallet zerada sem OPENING', async () => {
    await withRollback(async (em) => {
      const result = await new OpenWalletUseCase(em)
        .execute({
          playerId: randomUUID(),
          initialBalance: {
            amount: '0.00',
            currency: 'BRL',
          },
        });

      expect(result.balance.amount).toBe('0.00');
      expect(result.openingTransactionId).toBeUndefined();

      const ledger = await em.find(
        WalletLedgerEntryRecord,
        { walletId: result.id },
      );

      expect(ledger).toHaveLength(0);
    });
  });

  test('impede duas wallets do mesmo jogador', async () => {
    await withRollback(async (em) => {
      const playerId = randomUUID();

      const useCase = new OpenWalletUseCase(em);

      const first = await useCase.execute({
        playerId,
        initialBalance: {
          amount: '50.00',
          currency: 'BRL',
        },
      });

      expect(first.balance.amount).toBe('50.00');

      await expect(
        useCase.execute({
          playerId,
          initialBalance: {
            amount: '100.00',
            currency: 'BRL',
          },
        }),
      ).rejects.toThrow();

      const wallets = await em.find(
        WalletRecord,
        { playerId },
      );

      expect(wallets).toHaveLength(1);
      expect(wallets[0].balance).toBe('50.00');
    });
  });
});
