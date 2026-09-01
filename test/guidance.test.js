'use strict';

jest.mock('../src/lib/dynamo');
jest.mock('../src/lib/bedrock');
jest.mock('../src/lib/s3vectors');
jest.mock('../src/lib/sns');
jest.mock('../src/lib/audit');

const dynamo = require('../src/lib/dynamo');
const bedrock = require('../src/lib/bedrock');
const s3vectors = require('../src/lib/s3vectors');
const audit = require('../src/lib/audit');
const { handler } = require('../src/handlers/guidance');

function apiEvent(body) {
  return {
    httpMethod: 'POST',
    resource: '/guidance-requests',
    body: JSON.stringify(body),
    requestContext: { authorizer: { claims: { sub: 'u1' } } },
  };
}

beforeEach(() => {
  bedrock.embed.mockResolvedValue([0.1, 0.2, 0.3]);
  audit.record.mockResolvedValue(undefined);
  dynamo.get.mockResolvedValue({ pk: 'SME#x', availability: 'high', expertiseDomains: ['aws'] });
  // Return five candidate SMEs; the router must pick between 1 and 3.
  s3vectors.query.mockResolvedValue(
    ['u1', 'u2', 'u3', 'u4', 'u5'].map((id, i) => ({
      key: id,
      similarity: 0.9 - i * 0.1,
      metadata: { entityId: id },
    }))
  );
});

test('matches between 1 and 3 SMEs and returns a requestId (Req 7.1)', async () => {
  const resp = await handler(apiEvent({ query: 'How do I configure S3 Vectors?' }));
  expect(resp.statusCode).toBe(200);
  const out = JSON.parse(resp.body);
  expect(out.requestId).toBeTruthy();
  expect(out.matchedSmeIds.length).toBeGreaterThanOrEqual(1);
  expect(out.matchedSmeIds.length).toBeLessThanOrEqual(3);
});

test('rejects an empty query', async () => {
  const resp = await handler(apiEvent({ query: '' }));
  expect(resp.statusCode).toBe(400);
});
