'use strict';

/** Amazon SQS send helper for decoupling ingestion and review workflows. */

const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { REGION } = require('./config');

let _client;
function client() {
  if (!_client) _client = new SQSClient({ region: REGION });
  return _client;
}

async function sendMessage(queueUrl, body, attributes) {
  await client().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      ...(attributes ? { MessageAttributes: attributes } : {}),
    })
  );
}

module.exports = { sendMessage };
