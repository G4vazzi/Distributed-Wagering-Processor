
import 'dotenv/config';

import { createHash } from 'node:crypto';

import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';

import {
  EntityManager,
  MikroORM,
} from '@mikro-orm/postgresql';

import ormConfig from '../mikro-orm.config';

import { Money } from '../shared/domain/money';

import { InboxMessageRecord } from '../infrastructure/database/entities/inbox-message-record.entity';

import {
  ensureQueues,
  sqs,
} from '../infrastructure/messaging/sqs';

import { ProcessBetUseCase } from '../modules/wagering/application/process-bet.use-case';

import { ProcessWinLossUseCase } from '../modules/wagering/application/process-win-loss.use-case';

import { ProcessReversalUseCase } from '../modules/wagering/application/process-reversal.use-case';

import {
  WagerTransactionKind as Kind,
} from '../modules/wagering/domain/wager-transaction';

const CONSUMER = 'wagering-transactions-v1';

type JsonObject = Record<string, unknown>;

function object(value: unknown, name: string): JsonObject {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new Error(`${name} must be an object`);
  }

  return value as JsonObject;
}

function string(
  value: unknown,
  name: string,
  maxLength = 128,
): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maxLength
  ) {
    throw new Error(`Invalid field: ${name}`);
  }

  return value.trim();
}

function parseMessage(body: string) {
  const envelope: unknown = JSON.parse(body);
  const data = object(envelope, 'envelope');

  const messageId = string(
    data.messageId,
    'messageId',
    160,
  );

  const transaction = object(
    data.transaction,
    'transaction',
  );

  const kind = string(
    transaction.kind,
    'kind',
    20,
  );

  const moneyInput = object(
    transaction.money,
    'money',
  );

  const money = Money.from({
    amount: string(moneyInput.amount, 'money.amount', 64),
    currency: string(
      moneyInput.currency,
      'money.currency',
      3,
    ),
  });

  if (!money.isPositive()) {
    throw new Error('Transaction amount must be positive');
  }

  const base = {
    providerId: string(
      transaction.providerId,
      'providerId',
    ),
    externalTransactionId: string(
      transaction.externalTransactionId,
      'externalTransactionId',
    ),
    idempotencyKey: string(
      transaction.idempotencyKey,
      'idempotencyKey',
      256,
    ),
    playerId: string(
      transaction.playerId,
      'playerId',
      36,
    ),
    walletId: string(
      transaction.walletId,
      'walletId',
      36,
    ),
    roundId: string(
      transaction.roundId,
      'roundId',
    ),
    gameId: string(
      transaction.gameId,
      'gameId',
    ),
    money: money.toJSON(),
  };

  if (
    kind !== Kind.Bet &&
    kind !== Kind.Win &&
    kind !== Kind.Loss &&
    kind !== Kind.Refund &&
    kind !== Kind.Rollback
  ) {
    throw new Error(`Unsupported transaction kind: ${kind}`);
  }

  const referenceExternalTransactionId =
    kind === Kind.Refund || kind === Kind.Rollback
      ? string(
          transaction.referenceExternalTransactionId,
          'referenceExternalTransactionId',
        )
      : undefined;

  return {
    messageId,
    kind,
    base,
    referenceExternalTransactionId,
    payloadHash: createHash('sha256')
      .update(body)
      .digest('hex'),
  };
}

async function dispatch(
  em: EntityManager,
  parsed: ReturnType<typeof parseMessage>,
): Promise<void> {
  if (parsed.kind === Kind.Bet) {
    await new ProcessBetUseCase(em).execute(parsed.base);
    return;
  }

  if (parsed.kind === Kind.Win || parsed.kind === Kind.Loss) {
    await new ProcessWinLossUseCase(em).execute({
      ...parsed.base,
      kind: parsed.kind,
    });
    return;
  }

  if (parsed.kind === Kind.Refund || parsed.kind === Kind.Rollback) {
    if (!parsed.referenceExternalTransactionId) {
      throw new Error('Missing reversal reference');
    }

    await new ProcessReversalUseCase(em).execute({
      ...parsed.base,
      kind: parsed.kind,
      referenceExternalTransactionId:
        parsed.referenceExternalTransactionId,
    });
  }
}

async function handleMessage(
  orm: MikroORM,
  message: Message,
  queueUrl: string,
): Promise<void> {
  if (!message.Body || !message.ReceiptHandle) {
    throw new Error('SQS message has no body or receipt');
  }

  const parsed = parseMessage(message.Body);

  // A Inbox e a operação financeira são confirmadas
  // na mesma transação PostgreSQL.
  await orm.em.fork().transactional(async (tx) => {
    const inserted = await tx.execute<
      Array<{ message_id: string }>
    >(
      `INSERT INTO inbox_messages
        (consumer_name, message_id, payload_hash, received_at)
       VALUES (?, ?, ?, NOW())
       ON CONFLICT (consumer_name, message_id)
       DO NOTHING
       RETURNING message_id`,
      [CONSUMER, parsed.messageId, parsed.payloadHash],
    );

    if (inserted.length === 0) {
      const previous = await tx.findOne(
        InboxMessageRecord,
        {
          consumerName: CONSUMER,
          messageId: parsed.messageId,
        },
      );

      if (!previous) {
        throw new Error('Inbox conflict without stored message');
      }

      if (previous.payloadHash !== parsed.payloadHash) {
        throw new Error(
          'Same messageId received with different payload',
        );
      }

      if (!previous.processedAt) {
        throw new Error(
          'Existing Inbox message is not completed',
        );
      }

      // Já processada: não executar transação novamente.
      return;
    }

    // Os casos de uso criam savepoints quando chamados
    // dentro da transação externa.
    await dispatch(tx, parsed);

    await tx.execute(
      `UPDATE inbox_messages
       SET processed_at = NOW()
       WHERE consumer_name = ?
         AND message_id = ?`,
      [CONSUMER, parsed.messageId],
    );
  }, { clear: true });

  // Remover do SQS somente após o commit SQL.
  await sqs.send(
    new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: message.ReceiptHandle,
    }),
  );
}

async function main(): Promise<void> {
  const orm = await MikroORM.init(ormConfig);

  try {
    const queues = await ensureQueues();

    console.log('[SQS] Consumer started');
    console.log('[SQS] Queue:', queues.transactions);

    let stopping = false;

    process.on('SIGINT', () => {
      stopping = true;
    });

    process.on('SIGTERM', () => {
      stopping = true;
    });

    do {
      const result = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.transactions,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 2,
          VisibilityTimeout: 60,
        }),
      );

      for (const message of result.Messages ?? []) {
        try {
          await handleMessage(
            orm,
            message,
            queues.transactions,
          );

          console.log(
            '[SQS] Message processed:',
            message.MessageId,
          );
        } catch (error) {
          // Sem DeleteMessage: SQS fará nova tentativa
          // e eventualmente encaminhará para a DLQ.
          console.error(
            '[SQS] Processing failed:',
            message.MessageId,
            error,
          );
        }
      }

      if (process.argv.includes('--once')) {
        break;
      }
    } while (!stopping);
  } finally {
    await orm.close(true);
    sqs.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('[SQS] Fatal error:', error);
  process.exitCode = 1;
});
