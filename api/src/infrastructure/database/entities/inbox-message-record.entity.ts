
import {
  Entity,
  PrimaryKey,
  Property,
} from '@mikro-orm/core';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageRecord {
  @PrimaryKey({ length: 128 })
  consumerName!: string;

  @PrimaryKey({ length: 160 })
  messageId!: string;

  @Property({ length: 64 })
  payloadHash!: string;

  @Property({ columnType: 'timestamptz' })
  receivedAt!: Date;

  @Property({
    columnType: 'timestamptz',
    nullable: true,
  })
  processedAt?: Date;
}
