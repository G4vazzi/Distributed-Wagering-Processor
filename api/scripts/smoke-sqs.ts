
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';

import ormConfig from '../src/mikro-orm.config';

import {
  ensureQueues,
  sqs,
} from '../src/infrastructure/messaging/sqs';

import { OpenWalletUseCase } from '../src/modules/wallet/application/open-wallet.use-case';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Snapshot {
  balance: string;
  debits: number;
  inbox: number;
  transactions: number;
  events: number;
  published: number;
}

async function snapshot(
  orm: MikroORM,
  walletId: string,
  messageId: string,
  idempotencyKey: string,
): Promise<Snapshot> {
  const em = orm.em.fork();

  const wallets = await em.execute<
    Array<{ balance: string }>
  >(
    'SELECT balance FROM wallets WHERE id = ?',
    [walletId],
  );

  const ledger = await em.execute<
    Array<{ total: number }>
  >(
    `SELECT count(*)::int AS total
     FROM wallet_ledger_entries
     WHERE wallet_id = ?
       AND direction = 'DEBIT'`,
    [walletId],
  );

  const inbox = await em.execute<
    Array<{ total: number }>
  >(
    `SELECT count(*)::int AS total
     FROM inbox_messages
     WHERE consumer_name = 'wagering-transactions-v1'
       AND message_id = ?
       AND processed_at IS NOT NULL`,
    [messageId],
  );

  const transactions = await em.execute<
    Array<{ total: number }>
  >(
    `SELECT count(*)::int AS total
     FROM wager_transactions
     WHERE idempotency_key = ?
       AND status = 'PROCESSED'`,
    [idempotencyKey],
  );

  const events = await em.execute<
    Array<{ total: number; published: number }>
  >(
    `SELECT
       count(*)::int AS total,
       count(published_at)::int AS published
     FROM outbox_messages
     WHERE aggregate_id = ?`,
    [walletId],
  );

  return {
    balance: wallets[0]?.balance ?? 'NOT_FOUND',
    debits: ledger[0]?.total ?? 0,
    inbox: inbox[0]?.total ?? 0,
    transactions: transactions[0]?.total ?? 0,
    events: events[0]?.total ?? 0,
    published: events[0]?.published ?? 0,
  };
}

async function main(): Promise<void> {
  if (
    !process.env.DATABASE_URL ||
    new URL(process.env.DATABASE_URL).pathname !==
      '/wagering_test'
  ) {
    throw new Error(
      'Smoke test must run against wagering_test',
    );
  }

  const orm = await MikroORM.init(ormConfig);

  try {
    const queues = await ensureQueues();

    const playerId = randomUUID();

    const wallet = await new OpenWalletUseCase(
      orm.em.fork(),
    ).execute({
      playerId,
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    });

    const betId = randomUUID();
    const messageId = randomUUID();
    const idempotencyKey = `sqs-smoke:${betId}`;

    const envelope = {
      messageId,
      transaction: {
        kind: 'BET',
        providerId: 'provider-sqs-smoke',
        externalTransactionId: betId,
        idempotencyKey,
        playerId,
        walletId: wallet.id,
        roundId: 'round-sqs-smoke',
        gameId: 'game-sqs-smoke',
        money: {
          amount: '80.00',
          currency: 'BRL',
        },
      },
    };

    const body = JSON.stringify(envelope);

    console.log('Wallet:', wallet.id);
    console.log('Sending duplicate messages...');

    await Promise.all([
      sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.transactions,
          MessageBody: body,
        }),
      ),
      sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.transactions,
          MessageBody: body,
        }),
      ),
    ]);

    let result: Snapshot | undefined;

    // Aguardar os workers processarem as mensagens.
    // Tempo máximo: 60 segundos.
    for (let attempt = 0; attempt < 120; attempt++) {
      result = await snapshot(
        orm,
        wallet.id,
        messageId,
        idempotencyKey,
      );

      const complete =
        result.balance === '20.00' &&
        result.debits === 1 &&
        result.inbox === 1 &&
        result.transactions === 1 &&
        result.events === 2 &&
        result.published === 2;

      if (complete) {
        break;
      }

      await sleep(500);
    }

    console.log('Database snapshot:', result);

    if (
      !result ||
      result.balance !== '20.00' ||
      result.debits !== 1 ||
      result.inbox !== 1 ||
      result.transactions !== 1 ||
      result.events !== 2 ||
      result.published !== 2
    ) {
      throw new Error(
        'SQS smoke test failed: check consumer and publisher',
      );
    }

    console.log('SQS SMOKE TEST PASSED');
  } finally {
    await orm.close(true);
    sqs.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('Smoke test failed:', error);
  process.exitCode = 1;
});
