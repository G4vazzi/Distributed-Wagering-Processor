
import 'dotenv/config';

import { MikroORM } from '@mikro-orm/postgresql';

import ormConfig from '../mikro-orm.config';

import {
  processPendingReferenceBatch,
} from '../modules/wagering/application/pending-reference.processor';

const POLL_INTERVAL_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const orm = await MikroORM.init(ormConfig);

  let stopping = false;

  process.on('SIGINT', () => {
    stopping = true;
  });

  process.on('SIGTERM', () => {
    stopping = true;
  });

  console.log('[PendingReference] Worker started');

  try {
    do {
      const stats =
        await processPendingReferenceBatch(orm);

      const total =
        stats.processed +
        stats.rejected +
        stats.retryScheduled +
        stats.expired;

      if (total > 0) {
        console.log(
          '[PendingReference] Cycle completed:',
          stats,
        );
      }

      if (
        stopping ||
        process.argv.includes('--once')
      ) {
        break;
      }

      await sleep(POLL_INTERVAL_MS);
    } while (!stopping);
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(
    '[PendingReference] Fatal error:',
    error,
  );

  process.exitCode = 1;
});
