# Architecture — Distributed Wagering Processor

## 1. Overview

The Distributed Wagering Processor is a financial transaction processing prototype designed for an at-least-once messaging environment.

The main architectural objective is to preserve financial correctness under concurrent requests, repeated message delivery, and asynchronous event publication.

PostgreSQL is the source of truth for wallet balances, transactions, ledger records, and message-processing state.

## 2. Technology Choices

| Technology | Responsibility |
|---|---|
| Bun 1.x | Runtime, dependency management and test runner |
| NestJS | HTTP application layer |
| TypeScript | Strictly typed application code |
| MikroORM 6 | Persistence, transaction management and row locking |
| PostgreSQL 17 | Financial state and database constraints |
| decimal.js | Exact decimal arithmetic |
| SQS / MiniStack | Asynchronous message transport |
| Docker Compose | Local infrastructure orchestration |

MikroORM was selected because it supports explicit database transactions and pessimistic locking while keeping domain rules separate from persistence entities.

## 3. Domain Boundaries

The application separates the Wallet and Wagering domains.

The Wallet domain is responsible for balances, debits, credits, wallet versions, and ledger consistency.

The Wagering domain is responsible for BET, WIN, LOSS, REFUND, and ROLLBACK transactions, including reference validation, status transitions, and idempotency.

Financial calculations use immutable Money value objects backed by decimal.js. Monetary values cross API and persistence boundaries as decimal strings rather than JavaScript floating-point numbers.

## 4. Financial Transaction Processing

Financial operations are executed inside PostgreSQL transactions.

Operations affecting a wallet acquire a pessimistic row-level lock. This serializes modifications to the same wallet without requiring a global lock across all wallets.

A successful balance-changing operation persists the wallet update, wagering transaction, ledger entry, and Outbox events as one atomic database operation.

For SQS requests, the Inbox record is included in the same database transaction.

A committed financial operation therefore remains recorded even if the messaging worker terminates before acknowledging the SQS message.

## 5. Financial Invariants

The following invariants guide the implementation:

- Wallet balances cannot become negative.
- A processed financial movement produces the corresponding ledger entry.
- Rejected transactions do not change balances or create financial ledger entries.
- The ledger is append-only and protected against UPDATE, DELETE, and TRUNCATE at the database level.
- Repeated operations do not generate additional financial effects.
- Reversals validate the referenced transaction, amount, currency, provider, player, wallet, and round.
- Wallet versions increase when the balance changes.

Database constraints provide an additional protection layer beyond domain validation.

## 6. Persistent Idempotency

Idempotency is enforced through persisted identifiers, payload hashes, and database uniqueness constraints.

When an identical financial request is replayed, its original recorded result is returned rather than applying another balance movement.

A conflicting request that reuses an idempotency key with different financial data is rejected.

SQS consumers additionally use an Inbox table with a composite key consisting of consumer name and message ID.

For the current SQS implementation, the Inbox payload hash is calculated from the serialized message body. The transport contract should be normalized to canonical business JSON for broader interoperability.

## 7. Inbox and SQS Processing

The SQS consumer follows these steps:

1. Receive a message.
2. Validate the message envelope.
3. Insert the Inbox record inside a database transaction.
4. Execute the corresponding financial use case.
5. Mark the Inbox record as processed.
6. Commit the database transaction.
7. Delete the SQS message after successful commit.

If a message is delivered again, the persisted Inbox state prevents duplicate processing.

The current implementation uses local standard SQS-compatible queues in MiniStack, with a transaction dead-letter queue and a maximum receive count.

## 8. Transactional Outbox

Financial operations persist integration events in an Outbox table before publication.

A separate publisher selects unpublished events using PostgreSQL `FOR UPDATE SKIP LOCKED`.

This allows independent publishers to compete for pending rows while avoiding simultaneous selection of the same locked event.

The publisher sends an event to SQS and then marks it as published in PostgreSQL.

Failed attempts are scheduled for retry using exponential backoff.

The publication model is at-least-once. If an event is sent successfully but the database transaction does not record publication, the event can be sent again. Downstream consumers must therefore deduplicate events using stable event identifiers.

Events that exhaust the current retry limit remain in the database for operational recovery; automatic redrive of exhausted Outbox events is not implemented.

## 9. Concurrency Testing

The financial domain was validated with 81 passing automated unit and integration tests.

A distributed smoke test was also executed using three independent SQS consumers and one Outbox publisher.

The test submitted 24 messages representing two distinct BET operations of BRL 80.00 each against a wallet initially containing BRL 100.00.

Verified results:

| Invariant | Observed result |
|---|---|
| Processed BET transactions | 1 |
| Rejected BET transactions | 1 |
| Ledger debit entries | 1 |
| Logical Inbox records | 2 |
| Published Outbox events | 3 |
| Final wallet balance | BRL 20.00 |

Result: **DISTRIBUTED CONCURRENCY TEST PASSED**.

These tests demonstrate correctness for the verified scenarios, not complete resilience to every possible infrastructure failure.

## 10. Authentication Decision

HTTP authentication is not implemented in the current prototype.

The intended extension is an external OpenID Connect identity provider, with token validation at the NestJS boundary and provider authorization derived from verified identity claims.

Health endpoints would remain unauthenticated.

Financial endpoints must not be exposed publicly without this integration and additional request protection.

## 11. Known Limitations and Next Steps

The following items remain incomplete or require additional verification:

- Automatic reprocessing and expiration of `PENDING_REFERENCE` transactions.
- Full reconciliation and ledger pagination endpoints.
- Exact compatibility with the challenge's FIFO queue names and message envelope.
- Separate liveness and readiness endpoints.
- Structured operational logging and required metrics.
- Explicit recovery tests for crashes between database commit and SQS acknowledgement.
- Automated integration tests for concurrent Outbox publishers and DLQ recovery.
- Production deployment, secret management, and authentication.

The implementation prioritizes persistent financial correctness, deterministic domain behavior, database-enforced invariants, and an independently executable messaging pipeline.

Further work should focus on completing these operational requirements without weakening the existing financial guarantees.