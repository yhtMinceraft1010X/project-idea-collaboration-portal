'use strict';

jest.mock('../src/lib/dynamo');
jest.mock('../src/lib/bedrock');
jest.mock('../src/lib/s3vectors');
jest.mock('../src/lib/sqs');
jest.mock('../src/lib/secrets');
jest.mock('../src/lib/audit');

const crypto = require('crypto');
const secrets = require('../src/lib/secrets');
const dynamo = require('../src/lib/dynamo');
const bedrock = require('../src/lib/bedrock');
const s3vectors = require('../src/lib/s3vectors');
const audit = require('../src/lib/audit');
const { _internal, handler } = require('../src/handlers/ingestion');

beforeEach(() => {
  dynamo.put.mockResolvedValue(undefined);
  bedrock.embed.mockResolvedValue([0.1, 0.2]);
  s3vectors.putVector.mockResolvedValue(undefined);
  audit.record.mockResolvedValue(undefined);
});

test('GitHub webhook HMAC validation accepts a correct signature and rejects a tampered body (Req 3.1)', async () => {
  secrets.getSecret.mockResolvedValue({ webhookSecret: 'topsecret' });
  const body = JSON.stringify({ pull_request: { id: 42, title: 'Fix', body: 'desc' } });
  const good = 'sha256=' + crypto.createHmac('sha256', 'topsecret').update(body).digest('hex');

  const okEvent = { headers: { 'X-Hub-Signature-256': good }, body };
  await expect(_internal.validateWebhook('github', okEvent)).resolves.toBe(true);

  const tampered = { headers: { 'X-Hub-Signature-256': good }, body: body + 'x' };
  await expect(_internal.validateWebhook('github', tampered)).resolves.toBe(false);
});

test('Jira webhook shared-secret validation rejects a wrong secret (Req 3.1)', async () => {
  secrets.getSecret.mockResolvedValue({ webhookSecret: 'jira-secret' });
  const good = { headers: { 'x-webhook-secret': 'jira-secret' }, body: '{}' };
  const bad = { headers: { 'x-webhook-secret': 'nope' }, body: '{}' };
  await expect(_internal.validateWebhook('jira', good)).resolves.toBe(true);
  await expect(_internal.validateWebhook('jira', bad)).resolves.toBe(false);
});

test('normalise maps a GitHub PR payload to an asset and rejects an empty payload', () => {
  const fields = _internal.normalise('github', { pull_request: { id: 7, title: 'Add cache', body: 'x' } });
  expect(fields.sourceSystem).toBe('github');
  expect(fields.externalId).toBe('7');
  expect(_internal.normalise('github', {})).toBeNull();
});

test('processing a valid queued item writes the entity and indexes it (Req 3.4)', async () => {
  const record = {
    eventSource: 'aws:sqs',
    messageId: 'm1',
    eventSourceARN: 'arn:aws:sqs:ap-southeast-1:1:app-193a359c-027ffd1c-q-ingestion-jira',
    body: JSON.stringify({ issue: { key: 'ABC-1', fields: { summary: 'Bug', description: 'detail' } } }),
  };
  const out = await handler({ Records: [record] });
  expect(out.batchItemFailures).toEqual([]);
  expect(dynamo.put).toHaveBeenCalled();
  expect(s3vectors.putVector).toHaveBeenCalled();
});

test('an invalid queued item is reported as a batch failure (Req 3.5)', async () => {
  const record = {
    eventSource: 'aws:sqs',
    messageId: 'm2',
    eventSourceARN: 'arn:aws:sqs:ap-southeast-1:1:app-193a359c-027ffd1c-q-ingestion-github',
    body: 'not-json',
  };
  const out = await handler({ Records: [record] });
  expect(out.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }]);
});
