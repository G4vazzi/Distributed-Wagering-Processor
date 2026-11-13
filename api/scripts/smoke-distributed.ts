
import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { MikroORM } from '@mikro-orm/postgresql';
import { SendMessageCommand } from '@aws-sdk/client-sqs';

import ormConfig from '../src/mikro-orm.config';

import {
  ensureQueues,
  sqs,
} from '../src/infrastructure/messaging/sqs';

import { OpenWalletUseCase } from '../src/modules/wallet/application/open-wallet.use-case';

// ==========================================
// CONFIGURAÇÃO
// ==========================================

const PROVIDER = 'provider-distributed-smoke';
const DUPLICATES_PER_BET = 12;
const TIMEOUT_MS = 90_000;

interface Snapshot {
  balance: string;
  version: number;
  processed: number;
  rejected: number;
  debits: number;
  inbox: number;
  events: number;
  published: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==========================================
// CONSULTAR RESULTADOS DO POSTGRESQL
// ==========================================

async function snapshot(
  db: Client,
  walletId: string,
  messageIds: string[],
): Promise<Snapshot> {
  const wallet = await db.query<{
    balance: string;
    version: number;
  }>(
    `SELECT balance, version
     FROM wallets
     WHERE id = $1`,
    [walletId],
  );

  const transactions = await db.query<{
    status: string;
    total: number;
  }>(
    `SELECT status, count(*)::int AS total
     FROM wager_transactions
     WHERE wallet_id = $1
       AND provider_id = $2
       AND kind = 'BET'
     GROUP BY status`,
    [walletId, PROVIDER],
  );

  const ledger = await db.query<{ total: number }>(
    `SELECT count(*)::int AS total
     FROM wallet_ledger_entries
     WHERE wallet_id = $1
       AND direction = 'DEBIT'`,
    [walletId],
  );

  const inbox = await db.query<{ total: number }>(
    `SELECT count(*)::int AS total
     FROM inbox_messages
     WHERE consumer_name = 'wagering-transactions-v1'
       AND message_id = ANY($1::text[])
       AND processed_at IS NOT NULL`,
    [messageIds],
  );

  const events = await db.query<{
    total: number;
    published: number;
  }>(
    `SELECT
       count(*)::int AS total,
       count(published_at)::int AS published
     FROM outbox_messages
     WHERE aggregate_id = $1`,
    [walletId],
  );

  const countStatus = (status: string): number =>
    transactions.rows
      .filter((row) => row.status === status)
      .reduce((total, row) => total + row.total, 0);

  return {
    balance: wallet.rows[0]?.balance ?? 'NOT_FOUND',
    version: wallet.rows[0]?.version ?? -1,
    processed: countStatus('PROCESSED'),
    rejected: countStatus('REJECTED'),
    debits: ledger.rows[0]?.total ?? 0,
    inbox: inbox.rows[0]?.total ?? 0,
    events: events.rows[0]?.total ?? 0,
    published: events.rows[0]?.published ?? 0,
  };
}

function isValid(result: Snapshot): boolean {
  return (
    result.balance === '20.00' &&
    result.version === 2 &&
    result.processed === 1 &&
    result.rejected === 1 &&
    result.debits === 1 &&
    result.inbox === 2 &&
    result.events === 3 &&
    result.published === 3
  );
}

// ==========================================
// EXECUTAR TESTE DISTRIBUÍDO
// ==========================================

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;

  if (
    !connectionString ||
    new URL(connectionString).pathname !== '/wagering_test'
  ) {
    throw new Error(
      'Distributed smoke test requires wagering_test',
    );
  }

  const orm = await MikroORM.init(ormConfig);
  const db = new Client({ connectionString });

  try {
    await db.connect();

    const queues = await ensureQueues();

    // ======================================
    // 1. CRIAR CARTEIRA
    // ======================================

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

    console.log('\n=== DISTRIBUTED CONCURRENCY TEST ===');
    console.log('Wallet:', wallet.id);
    console.log('Initial balance: 100.00');

    // ======================================
    // 2. CRIAR DUAS APOSTAS DISTINTAS
    // ======================================

    function createBetEnvelope() {
      const messageId = randomUUID();
      const transactionId = randomUUID();

      return {
        messageId,
        transaction: {
          kind: 'BET',
          providerId: PROVIDER,
          externalTransactionId: transactionId,
          idempotencyKey: `${PROVIDER}:${transactionId}`,
          playerId,
          walletId: wallet.id,
          roundId: 'round-distributed',
          gameId: 'game-distributed',
          money: {
            amount: '80.00',
            currency: 'BRL',
          },
        },
      };
    }

    const first = createBetEnvelope();
    const second = createBetEnvelope();

    const firstBody = JSON.stringify(first);
    const secondBody = JSON.stringify(second);

    // ======================================
    // 3. ENVIAR 24 MENSAGENS
    // ======================================

    // 12 cópias de cada operação.
    // As duas operações disputam o mesmo saldo.
    const bodies = [
      ...Array<string>(DUPLICATES_PER_BET).fill(firstBody),
      ...Array<string>(DUPLICATES_PER_BET).fill(secondBody),
    ];

    console.log(
      `Sending ${bodies.length} SQS messages...`,
    );

    await Promise.all(
      bodies.map((body) =>
        sqs.send(
          new SendMessageCommand({
            QueueUrl: queues.transactions,
            MessageBody: body,
          }),
        ),
      ),
    );

    // ======================================
    // 4. AGUARDAR PROCESSAMENTO
    // ======================================

    const messageIds = [
      first.messageId,
      second.messageId,
    ];

    const deadline = Date.now() + TIMEOUT_MS;

    let result = await snapshot(
      db,
      wallet.id,
      messageIds,
    );

    while (
      !isValid(result) &&
      Date.now() < deadline
    ) {
      await sleep(500);

      result = await snapshot(
        db,
        wallet.id,
        messageIds,
      );
    }

    console.log('\nDatabase snapshot:', result);

    if (!isValid(result)) {
      throw new Error(
        'Distributed concurrency test failed',
      );
    }

    // ======================================
    // 5. VERIFICAR ESTABILIDADE
    // ======================================

    // Permite que eventuais mensagens duplicadas
    // ainda em processamento sejam consumidas.
    await sleep(3_000);

    const finalResult = await snapshot(
      db,
      wallet.id,
      messageIds,
    );

    if (!isValid(finalResult)) {
      console.error(
        'Final snapshot:',
        finalResult,
      );

      throw new Error(
        'Financial state changed after duplicate delivery',
      );
    }

    console.log('\n=== TEST RESULTS ===');
    console.log('Processed BET:', finalResult.processed);
    console.log('Rejected BET:', finalResult.rejected);
    console.log('Ledger debits:', finalResult.debits);
    console.log('Inbox records:', finalResult.inbox);
    console.log('Outbox events:', finalResult.events);
    console.log('Published events:', finalResult.published);
    console.log('Final balance:', finalResult.balance);

    console.log(
      '\nDISTRIBUTED CONCURRENCY TEST PASSED',
    );
  } finally {
    await db.end();
    await orm.close(true);
    sqs.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('Test failed:', error);
  process.exitCode = 1;
});
