
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint:
    process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey:
      process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  },
});

export interface WageringQueues {
  transactions: string;
  events: string;
  dlq: string;
}

async function createQueue(
  name: string,
  attributes?: Record<string, string>,
): Promise<string> {
  const result = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: attributes,
    }),
  );

  if (!result.QueueUrl) {
    throw new Error(`Queue URL not returned: ${name}`);
  }

  return result.QueueUrl;
}

export async function ensureQueues(): Promise<WageringQueues> {
  const dlq = await createQueue('wagering-transactions-dlq');

  const attributes = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlq,
      AttributeNames: ['QueueArn'],
    }),
  );

  const dlqArn = attributes.Attributes?.QueueArn;

  if (!dlqArn) {
    throw new Error('DLQ ARN was not returned by SQS');
  }

  const transactions = await createQueue(
    'wagering-transactions',
    {
      VisibilityTimeout: '60',
      ReceiveMessageWaitTimeSeconds: '2',
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: '5',
      }),
    },
  );

  const events = await createQueue('wagering-events');

  return {
    transactions,
    events,
    dlq,
  };
}
