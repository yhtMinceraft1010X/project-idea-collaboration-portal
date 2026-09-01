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

function apiEvent({ method, resource, body, pathParameters, sub, groups }) {
  const claims = { sub: sub || 'u1' };
  if (groups) claims['cognito:groups'] = groups;
  return {
    httpMethod: method,
    resource,
    pathParameters: pathParameters || {},
    body: body ? JSON.stringify(body) : undefined,
    requestContext: { authorizer: { claims } },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  bedrock.embed.mockResolvedValue([0.1, 0.2, 0.3]);
  audit.record.mockResolvedValue(undefined);
  dynamo.put.mockResolvedValue(undefined);
  dynamo.get.mockResolvedValue({ pk: 'SME#x', availability: 'high', expertiseDomains: ['aws'] });
  dynamo.query.mockResolvedValue({ items: [] });
  s3vectors.query.mockResolvedValue(
    ['u2', 'u3', 'u4'].map((id, i) => ({
      key: id,
      similarity: 0.9 - i * 0.1,
      metadata: { entityId: id },
    }))
  );
});

test('POST /guidance-requests returns requestId and persists the METADATA row (Req 7)', async () => {
  const resp = await handler(
    apiEvent({ method: 'POST', resource: '/guidance-requests', body: { query: 'S3 Vectors?' }, sub: 'u1' })
  );
  expect(resp.statusCode).toBe(200);
  const out = JSON.parse(resp.body);
  expect(out.requestId).toBeTruthy();
  const metaWrite = dynamo.put.mock.calls.find(
    (c) => c[1] && c[1].sk === 'METADATA'
  );
  expect(metaWrite).toBeTruthy();
  expect(metaWrite[1].status).toBe('routed');
  expect(metaWrite[1].requesterId).toBe('u1');
});

test('GET /guidance-requests returns the caller\'s requests from RequesterIndex', async () => {
  dynamo.query.mockResolvedValue({
    items: [{ requestId: 'r1', requesterId: 'u1', status: 'routed' }],
  });
  const resp = await handler(apiEvent({ method: 'GET', resource: '/guidance-requests', sub: 'u1' }));
  expect(resp.statusCode).toBe(200);
  const out = JSON.parse(resp.body);
  expect(out.items).toHaveLength(1);
  expect(out.items[0].requestId).toBe('r1');
  expect(dynamo.query).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ indexName: 'RequesterIndex' })
  );
});

test('POST /guidance-requests/{id}/respond by an assignee sets status accepted', async () => {
  dynamo.get.mockResolvedValue({
    pk: 'GUIDANCE#r1',
    sk: 'METADATA',
    requestId: 'r1',
    requesterId: 'u2',
    matchedSmeIds: ['u1'],
    status: 'routed',
  });
  dynamo.update.mockImplementation((table, key, params) => {
    return Promise.resolve({
      requestId: 'r1',
      requesterId: 'u2',
      matchedSmeIds: ['u1'],
      status: params.expressionAttributeValues[':s'],
      responderId: params.expressionAttributeValues[':rid'],
      responseComments: params.expressionAttributeValues[':c'],
      respondedAt: params.expressionAttributeValues[':t'],
    });
  });

  const resp = await handler(
    apiEvent({
      method: 'POST',
      resource: '/guidance-requests/{id}/respond',
      pathParameters: { id: 'r1' },
      body: { decision: 'accept', comments: 'Glad to help' },
      sub: 'u1',
    })
  );
  expect(resp.statusCode).toBe(200);
  const out = JSON.parse(resp.body);
  expect(out.status).toBe('accepted');
  expect(out.responderId).toBe('u1');
  expect(dynamo.update).toHaveBeenCalled();
});

test('POST /guidance-requests/{id}/respond by a non-assignee non-SME is forbidden', async () => {
  dynamo.get.mockResolvedValue({
    pk: 'GUIDANCE#r1',
    sk: 'METADATA',
    requestId: 'r1',
    requesterId: 'u2',
    matchedSmeIds: ['u1'],
    status: 'routed',
  });
  const resp = await handler(
    apiEvent({
      method: 'POST',
      resource: '/guidance-requests/{id}/respond',
      pathParameters: { id: 'r1' },
      body: { decision: 'accept' },
      sub: 'stranger',
    })
  );
  expect(resp.statusCode).toBe(403);
  expect(dynamo.update).not.toHaveBeenCalled();
});
