
import 'dotenv/config';

import { SendMessageCommand } from '@aws-sdk/client-sqs';

import { MikroORM } from '@mikro-orm/postgresql';

import ormConfig from '../mikro-orm.config';

import {
  ensureQueues,
  sqs,
} from '../infrastructure/messaging/sqs';

const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 30;

interface PendingEvent {
  id: string;
  payload: Record<string, unknown>;
  attempts: number;
}

function retryDelay(attempts: number): number {
  return Math.min(
    1000 * Math.pow(2, Math.min(attempts, 6)),
    60_000,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PublishResult = 'published' | 'retry' | 'empty';

async function publishOne(
  orm: MikroORM,
  queueUrl: string,
): Promise<PublishResult> {
  return orm.em.fork().transactional(async (tx) => {
    // Bloqueio exclusivo do evento selecionado.
    // Outras instâncias ignoram linhas já bloqueadas.
    const rows = await tx.execute<PendingEvent[]>(
      `SELECT id, payload, attempts
       FROM outbox_messages
       WHERE published_at IS NULL
         AND attempts < ?
         AND (
           next_attempt_at IS NULL
           OR next_attempt_at <= NOW()
         )
       ORDER BY occurred_at ASC, id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [MAX_ATTEMPTS],
    );

    const event = rows[0];

    if (!event) {
      return 'empty';
    }

    try {
      // Primeiro o SQS confirma o recebimento.
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(event.payload),
        }),
      );

      // Depois registramos a publicação no PostgreSQL.
      await tx.execute(
        `UPDATE outbox_messages
         SET published_at = NOW(),
             next_attempt_at = NULL,
             attempts = attempts + 1
         WHERE id = ?`,
        [event.id],
      );

      console.log('[Outbox] Published:', event.id);

      return 'published';
    } catch (error) {
      const delay = retryDelay(event.attempts);

      // Em caso de falha, manter o evento no banco.
      await tx.execute(
        `UPDATE outbox_messages
         SET attempts = attempts + 1,
             next_attempt_at =
               NOW() + (? * INTERVAL '1 millisecond')
         WHERE id = ?`,
        [delay, event.id],
      );

      console.error(
        '[Outbox] Failed; retry scheduled:',
        event.id,
        error,
      );

      return 'retry';
    }
  }, { clear: true });
}

async function runCycle(
  orm: MikroORM,
  queueUrl: string,
): Promise<void> {
  for (let index = 0; index < BATCH_SIZE; index++) {
    const result = await publishOne(orm, queueUrl);

    if (result === 'empty') {
      break;
    }
  }
}

async function main(): Promise<void> {
  const orm = await MikroORM.init(ormConfig);

  try {
    const queues = await ensureQueues();

    console.log('[Outbox] Publisher started');
    console.log('[Outbox] Destination:', queues.events);

    let stopping = false;

    process.on('SIGINT', () => {
      stopping = true;
    });

    process.on('SIGTERM', () => {
      stopping = true;
    });

    do {
      await runCycle(orm, queues.events);

      if (process.argv.includes('--once') || stopping) {
        break;
      }

      await sleep(1_000);
    } while (!stopping);
  } finally {
    await orm.close(true);
    sqs.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('[Outbox] Fatal error:', error);
  process.exitCode = 1;
});
