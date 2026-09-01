'use strict';

/** Amazon SNS publish helper for notification fan-out. */

const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { REGION } = require('./config');

let _client;
function client() {
  if (!_client) _client = new SNSClient({ region: REGION });
  return _client;
}

async function publish(topicArn, message, subject) {
  await client().send(
    new PublishCommand({
      TopicArn: topicArn,
      Message: typeof message === 'string' ? message : JSON.stringify(message),
      ...(subject ? { Subject: subject.slice(0, 100) } : {}),
    })
  );
}

module.exports = { publish };
