'use strict';

jest.mock('../src/lib/bedrock');
jest.mock('../src/lib/s3vectors');
jest.mock('../src/lib/audit');

const bedrock = require('../src/lib/bedrock');
const s3vectors = require('../src/lib/s3vectors');
const audit = require('../src/lib/audit');
const { handler } = require('../src/handlers/search');

function apiEvent(body) {
  return {
    httpMethod: 'POST',
    resource: '/search',
    body: JSON.stringify(body),
    requestContext: { authorizer: { claims: { sub: 'u1' } } },
  };
}

beforeEach(() => {
  bedrock.embed.mockResolvedValue([0.1, 0.2, 0.3]);
  audit.record.mockResolvedValue(undefined);
  s3vectors.query.mockResolvedValue([
    { key: 'p1', similarity: 0.92, metadata: { entityId: 'p1', snippet: 'CI is slow', status: 'published' } },
  ]);
});

test('returns { results: [...] } with entityId/entityType/score (Req 4.1)', async () => {
  const resp = await handler(apiEvent({ query: 'slow ci builds', rerank: false }));
  expect(resp.statusCode).toBe(200);
  const out = JSON.parse(resp.body);
  expect(Array.isArray(out.results)).toBe(true);
  expect(out.results[0]).toHaveProperty('entityId');
  expect(out.results[0]).toHaveProperty('entityType');
  expect(out.results[0]).toHaveProperty('score');
});

test('rejects an empty query', async () => {
  const resp = await handler(apiEvent({ query: '' }));
  expect(resp.statusCode).toBe(400);
});
