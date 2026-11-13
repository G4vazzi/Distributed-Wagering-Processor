
# Distributed Wagering Processor

A distributed financial transaction processing backend built with
Bun, NestJS, TypeScript, MikroORM, PostgreSQL and SQS-compatible
messaging.

The project focuses on financial correctness, transaction
idempotency, per-wallet concurrency control, immutable ledger
entries and reliable asynchronous processing.

## Technology Stack

- **Runtime:** Bun 1.x
- **Backend:** NestJS 12 / TypeScript
- **ORM:** MikroORM 6
- **Database:** PostgreSQL 17
- **Messaging:** SQS-compatible MiniStack
- **Infrastructure:** Docker Compose and Redis
- **Financial arithmetic:** decimal.js
- **Testing:** Bun Test

## Architecture

The application separates financial domain rules, application
use cases, persistence and messaging infrastructure.

```text
api/
├── scripts/
│   ├── smoke-http.ps1
│   ├── smoke-sqs.ts
│   └── smoke-distributed.ts
├── src/
│   ├── infrastructure/
│   │   ├── database/
│   │   │   ├── entities/
│   │   │   └── migrations/
│   │   └── messaging/
│   │       └── sqs.ts
│   ├── modules/
│   │   ├── wallet/
│   │   │   ├── application/
│   │   │   └── domain/
│   │   └── wagering/
│   │       ├── application/
│   │       ├── domain/
│   │       └── http/
│   ├── shared/
│   │   └── domain/
│   ├── workers/
│   │   ├── sqs-consumer.ts
│   │   └── outbox-publisher.ts
│   ├── app.module.ts
│   ├── main.ts
│   └── mikro-orm.config.ts
└── test/
    ├── integration/
    └── unit/
```

### Processing Flow

```text
HTTP API / SQS
       |
       v
Application Use Cases
       |
       v
PostgreSQL Transaction
       |
       +-- Wallet balance
       +-- Wager transaction
       +-- Immutable ledger
       +-- Inbox (SQS processing)
       +-- Outbox events
                       |
                       v
                 Outbox Publisher
                       |
                       v
                  Events Queue
```

## Financial Operations

| Operation | Behavior |
|---|---|
| OPENING | Creates the initial wallet balance and ledger entry |
| BET | Debits the wallet if sufficient funds exist |
| WIN | Credits the wallet |
| LOSS | Records the result without another balance movement |
| REFUND | Reverses a processed BET by crediting the wallet |
| ROLLBACK | Reverses an eligible financial movement |

Refund and rollback operations validate the referenced
transaction, amount, currency, provider, player, wallet
and round.

An unresolved reference is stored with the
`PENDING_REFERENCE` status.

## Financial Integrity

### Decimal Precision

Financial calculations use `decimal.js` rather than
JavaScript floating-point arithmetic.

Amounts are represented with two decimal places.

### Concurrency Control

Financial operations acquire PostgreSQL pessimistic
row locks on the affected wallet.

This serializes concurrent changes to the same wallet
without globally locking unrelated wallets.

### Atomic Persistence

Balance changes, transaction records, ledger entries
and outbox events are committed within a PostgreSQL
transaction.

SQS processing additionally records Inbox state
transactionally.

### Immutable Ledger

PostgreSQL triggers prevent updates, deletes and
truncation of ledger entries.

Corrections are represented by new financial entries
rather than modifications to historical records.

### Idempotency

Transactions have persistent idempotency keys and
unique external transaction identifiers.

Identical requests return their stored result.
Conflicting payloads are rejected.

The Inbox also deduplicates SQS messages using
consumer name and message ID.

## Prerequisites

- Bun 1.x
- Docker Desktop with Docker Compose
- Git

## Local Setup

### 1. Start Infrastructure

From the repository root:

```powershell
docker compose up -d
docker compose ps
```

The Docker environment provides PostgreSQL, Redis
and MiniStack.

### 2. Install Dependencies

```powershell
cd api
bun install
```

### 3. Configure the Database

Create `api/.env` for local development:

```dotenv
DATABASE_URL=postgresql://wagering:wagering_dev@127.0.0.1:5432/wagering
PORT=3000
AWS_REGION=us-east-1
SQS_ENDPOINT=http://127.0.0.1:4566
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
```

These are local development credentials only.

### 4. Apply Migrations

```powershell
bunx mikro-orm migration:up
bunx mikro-orm migration:list
```

### 5. Start the API

```powershell
bun run start:dev
```

Check:

`http://localhost:3000/v1/health`

## HTTP API

| Method | Endpoint | Description |
|---|---|---|
| GET | `/v1/health` | Health and database check |
| POST | `/v1/wallets` | Open a wallet |
| GET | `/v1/wallets/:id` | Retrieve wallet balance |
| POST | `/v1/transactions` | Process a financial operation |
| GET | `/v1/transactions/:id` | Retrieve transaction details |

### Open Wallet

`POST /v1/wallets`

```json
{
  "playerId": "a-valid-player-uuid",
  "initialBalance": {
    "amount": "100.00",
    "currency": "BRL"
  }
}
```

### Process BET

`POST /v1/transactions`

Header:

```text
Idempotency-Key: provider-a:bet-001
```

Request:

```json
{
  "kind": "BET",
  "providerId": "provider-a",
  "externalTransactionId": "bet-001",
  "playerId": "a-valid-player-uuid",
  "walletId": "an-existing-wallet-uuid",
  "roundId": "round-001",
  "gameId": "game-001",
  "money": {
    "amount": "80.00",
    "currency": "BRL"
  }
}
```

A successful BET from an initial balance of 100.00
produces a balance of 20.00.

`WIN`, `LOSS`, `REFUND` and `ROLLBACK` use the same
transaction endpoint.

Reversals additionally require
`referenceExternalTransactionId`.

## SQS Messaging

MiniStack provides three local queues:

- `wagering-transactions`
- `wagering-transactions-dlq`
- `wagering-events`

### SQS Consumer

From the `api` directory:

```powershell
bun run src/workers/sqs-consumer.ts
```

The consumer receives messages, records Inbox entries,
dispatches the appropriate financial use case and deletes
messages only after successful database commit.

Failed messages remain eligible for SQS redelivery.
The transaction queue is configured with a DLQ.

### Outbox Publisher

In a separate terminal:

```powershell
bun run src/workers/outbox-publisher.ts
```

The publisher selects unpublished events using
`FOR UPDATE SKIP LOCKED`, sends them to SQS and updates
their publication status.

Failures are retried with exponential backoff.

Because delivery is at-least-once, downstream event
consumers must also handle duplicate events.

## Testing

### Isolated Test Database

Create the database once:

```powershell
docker compose -f ../compose.yaml exec postgres psql -U wagering -d postgres -c "CREATE DATABASE wagering_test OWNER wagering;"
```

Skip creation if it already exists.

Inside `api`, select the isolated database:

```powershell
$env:DATABASE_URL = "postgresql://wagering:wagering_dev@127.0.0.1:5432/wagering_test"
```

Apply migrations:

```powershell
bunx mikro-orm migration:up
```

### Automated Tests

```powershell
bun test ./test/unit ./test/integration
```

The financial test suite has been verified with
**81 passing tests**.

### Type Checking and Build

```powershell
bunx tsc --noEmit -p tsconfig.json
bun run build
```

### HTTP Smoke Test

With the API running:

```powershell
.\scripts\smoke-http.ps1
```

The script validates wallet creation, BET,
idempotent replay, REFUND and final balance.

### SQS Smoke Test

Start the SQS consumer and Outbox publisher in
separate terminals, both connected to `wagering_test`.

Then execute:

```powershell
bun run scripts/smoke-sqs.ts
```

Verified smoke-test scenario:

- Two deliveries of an identical BET
- One financial transaction
- One ledger debit
- One logical Inbox record
- Two Outbox events
- Final balance: 20.00

### Distributed Concurrency Test

Run three independent SQS consumer processes
and one Outbox publisher.

Then:

```powershell
bun run scripts/smoke-distributed.ts
```

The script sends 24 messages representing two
different BET operations competing for a wallet
with a balance of 100.00.

Expected invariants:

- Exactly one BET processed
- Exactly one BET rejected
- Exactly one debit
- Final wallet balance of 20.00
- No duplicate financial effects


### Verified Distributed Concurrency Results

The distributed concurrency test was successfully executed
with three independent SQS consumer processes and one
Outbox publisher.

Test scenario:
- Initial wallet balance: BRL 100.00
- 24 SQS messages representing two distinct BET operations
- Each BET amount: BRL 80.00

Verified results:
- 1 BET processed
- 1 BET rejected
- 1 ledger debit
- 2 logical Inbox records
- 3 Outbox events published
- Final wallet balance: BRL 20.00

Result: DISTRIBUTED CONCURRENCY TEST PASSED

The test demonstrates financial consistency under this
concurrent workload. It does not replace comprehensive
failure-injection or production load testing.


## Known Limitations

This implementation is a technical challenge
prototype rather than a production-ready gambling
or payment platform.

- HTTP provider authentication and authorization
  are not implemented.
- Automatic scheduling and expiry handling for
  `PENDING_REFERENCE` are not yet integrated.
- Outbox events that exhaust retry attempts require
  an operational recovery mechanism.
- The SQS emulator is intended for local development;
  production deployment and durability have not
  been validated.
- Full failure-injection and recovery testing is
  still required for production-level assurance.

## Design Decisions

**PostgreSQL as the source of truth:** Financial state
is persisted transactionally instead of relying on
in-memory locks or message ordering.

**Per-wallet locking:** Row-level locks protect a
wallet against lost updates during concurrent requests.

**Immutable ledger:** Historical financial records
cannot be silently changed.

**Inbox and Outbox:** These patterns address repeated
SQS deliveries and reliable event publication across
database and messaging boundaries.

**Independent workers:** Consumer and publisher
processes can be executed separately from the HTTP API.

## Project Status

The financial domain, PostgreSQL persistence,
HTTP interface, SQS consumer and Outbox publisher
have been implemented.

Automated financial tests and HTTP/SQS smoke tests
have been executed successfully in the local
development environment.

Additional distributed failure scenarios and
production hardening remain outside the verified scope.
