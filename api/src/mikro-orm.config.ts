
import 'dotenv/config';
import 'reflect-metadata';

import { ReflectMetadataProvider } from '@mikro-orm/core';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WagerTransactionRecord } from 
  './infrastructure/database/entities/wager-transaction-record.entity';

import { WalletLedgerEntryRecord } from
  './infrastructure/database/entities/wallet-ledger-entry-record.entity';

  import { WalletRecord } from
  './infrastructure/database/entities/wallet-record.entity';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is not configured');
}

export default defineConfig({
  clientUrl: databaseUrl,

  entities: [
    WalletRecord,
    WagerTransactionRecord,
    WalletLedgerEntryRecord
  ],

  metadataProvider: ReflectMetadataProvider,

  extensions: [Migrator],

  migrations: {
    path: './dist/infrastructure/database/migrations',
    pathTs: './src/infrastructure/database/migrations',
    transactional: true,
    allOrNothing: true,
  },

  debug: process.env.NODE_ENV === 'development',
});
