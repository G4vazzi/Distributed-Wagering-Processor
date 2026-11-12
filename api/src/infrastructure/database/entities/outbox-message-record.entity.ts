
import {
  Check,
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/core';

@Entity({ tableName: 'outbox_messages' })
@Index({
  name: 'outbox_pending_idx',
  properties: [
    'publishedAt',
    'nextAttemptAt',
    'occurredAt',
  ],
})
@Check({
  name: 'outbox_attempts_nonnegative_check',
  expression: 'attempts >= 0',
})
export class OutboxMessageRecord {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid' })
  aggregateId!: string;

  @Property({ length: 100 })
  eventType!: string;

  @Property({
    type: 'json',
    columnType: 'jsonb',
  })
  payload!: Record<string, unknown>;

  @Property({ columnType: 'timestamptz' })
  occurredAt!: Date;

  @Property({ default: 0 })
  attempts: number = 0;

  @Property({
    columnType: 'timestamptz',
    nullable: true,
  })
  nextAttemptAt?: Date;

  @Property({
    columnType: 'timestamptz',
    nullable: true,
  })
  publishedAt?: Date;
}
