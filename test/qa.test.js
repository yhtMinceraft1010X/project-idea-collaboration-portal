'use strict';

jest.mock('../src/lib/dynamo');
jest.mock('../src/lib/audit');

const dynamo = require('../src/lib/dynamo');
const audit = require('../src/lib/audit');
const { handler } = require('../src/handlers/qa');

function apiEvent({ method, resource, body, pathParameters, sub, groups, email }) {
  const claims = { sub: sub || 'u1' };
  if (groups) claims['cognito:groups'] = groups;
  if (email) claims.email = email;
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
  audit.record.mockResolvedValue(undefined);
  dynamo.put.mockResolvedValue(undefined);
  dynamo.update.mockResolvedValue(undefined);
});

test('POST /questions creates a question owned by the caller', async () => {
  const resp = await handler(
    apiEvent({
      method: 'POST',
      resource: '/questions',
      body: { title: 'How do I size an S3 Vectors index?', content: 'What dimension should I use?' },
      sub: 'u1',
      email: 'asker@example.com',
    })
  );
  expect(resp.statusCode).toBe(201);
  const out = JSON.parse(resp.body);
  expect(out.questionId).toBeTruthy();
  expect(out.status).toBe('open');
  const putItem = dynamo.put.mock.calls[0][1];
  expect(putItem.creatorId).toBe('u1');
  expect(putItem.creatorUsername).toBe('asker@example.com');
  expect(audit.record).toHaveBeenCalled();
});

test('POST /questions rejects a missing title', async () => {
  const resp = await handler(
    apiEvent({ method: 'POST', resource: '/questions', body: { content: 'x' }, sub: 'u1' })
  );
  expect(resp.statusCode).toBe(400);
  expect(dynamo.put).not.toHaveBeenCalled();
});

test('GET /questions returns only the caller\'s own questions for a non-expert', async () => {
  dynamo.query.mockResolvedValue({
    items: [{ pk: 'QUESTION#q1', sk: 'METADATA', creatorId: 'u1' }],
  });
  const resp = await handler(apiEvent({ method: 'GET', resource: '/questions', sub: 'u1' }));
  expect(resp.statusCode).toBe(200);
  const out = JSON.parse(resp.body);
  expect(out.items).toHaveLength(1);
  expect(dynamo.query).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ indexName: 'CreatorIndex' })
  );
  expect(dynamo.scan).not.toHaveBeenCalled();
});

test('GET /questions returns every question for an expert (SME group)', async () => {
  dynamo.scan.mockResolvedValue({
    items: [
      { pk: 'QUESTION#q1', sk: 'METADATA', creatorId: 'u1', createdAt: '2026-01-01T00:00:00.000Z' },
      { pk: 'QUESTION#q2', sk: 'METADATA', creatorId: 'u2', createdAt: '2026-01-02T00:00:00.000Z' },
    ],
  });
  const resp = await handler(
    apiEvent({ method: 'GET', resource: '/questions', sub: 'expert-1', groups: ['SME'] })
  );
  expect(resp.statusCode).toBe(200);
  const out = JSON.parse(resp.body);
  expect(out.items).toHaveLength(2);
  expect(dynamo.scan).toHaveBeenCalled();
});

test('GET /questions/{id} is visible to the asker and includes answers', async () => {
  dynamo.query.mockResolvedValue({
    items: [
      { pk: 'QUESTION#q1', sk: 'METADATA', creatorId: 'u1', title: 'Q' },
      { pk: 'QUESTION#q1', sk: 'ANSWER#a1', content: 'A', creatorId: 'expert-1' },
    ],
  });
  const resp = await handler(
    apiEvent({ method: 'GET', resource: '/questions/{id}', pathParameters: { id: 'q1' }, sub: 'u1' })
  );
  expect(resp.statusCode).toBe(200);
  const out = JSON.parse(resp.body);
  expect(out.answers).toHaveLength(1);
});

test('GET /questions/{id} is visible to an expert who did not ask it', async () => {
  dynamo.query.mockResolvedValue({
    items: [{ pk: 'QUESTION#q1', sk: 'METADATA', creatorId: 'u1', title: 'Q' }],
  });
  const resp = await handler(
    apiEvent({
      method: 'GET',
      resource: '/questions/{id}',
      pathParameters: { id: 'q1' },
      sub: 'expert-1',
      groups: ['SME'],
    })
  );
  expect(resp.statusCode).toBe(200);
});

test('GET /questions/{id} is forbidden for a stranger who is not an expert', async () => {
  dynamo.query.mockResolvedValue({
    items: [{ pk: 'QUESTION#q1', sk: 'METADATA', creatorId: 'u1' }],
  });
  const resp = await handler(
    apiEvent({ method: 'GET', resource: '/questions/{id}', pathParameters: { id: 'q1' }, sub: 'stranger' })
  );
  expect(resp.statusCode).toBe(403);
});

test('GET /questions/{id} returns 404 for an unknown question', async () => {
  dynamo.query.mockResolvedValue({ items: [] });
  const resp = await handler(
    apiEvent({ method: 'GET', resource: '/questions/{id}', pathParameters: { id: 'missing' }, sub: 'u1' })
  );
  expect(resp.statusCode).toBe(404);
});

test('POST /questions/{id}/answers by an expert creates an answer and marks the question answered', async () => {
  dynamo.get.mockResolvedValue({ pk: 'QUESTION#q1', sk: 'METADATA', creatorId: 'u1', status: 'open' });
  const resp = await handler(
    apiEvent({
      method: 'POST',
      resource: '/questions/{id}/answers',
      pathParameters: { id: 'q1' },
      body: { content: 'Use 1024 dimensions with cosine distance.' },
      sub: 'expert-1',
      groups: ['SME'],
      email: 'expert@example.com',
    })
  );
  expect(resp.statusCode).toBe(201);
  const out = JSON.parse(resp.body);
  expect(out.content).toBe('Use 1024 dimensions with cosine distance.');
  expect(out.creatorUsername).toBe('expert@example.com');
  expect(dynamo.update).toHaveBeenCalled();
  const updateArgs = dynamo.update.mock.calls[0];
  expect(updateArgs[2].expressionAttributeValues[':s']).toBe('answered');
  expect(audit.record).toHaveBeenCalled();
});

test('POST /questions/{id}/answers by a non-expert is forbidden', async () => {
  const resp = await handler(
    apiEvent({
      method: 'POST',
      resource: '/questions/{id}/answers',
      pathParameters: { id: 'q1' },
      body: { content: 'x' },
      sub: 'u2',
    })
  );
  expect(resp.statusCode).toBe(403);
  expect(dynamo.get).not.toHaveBeenCalled();
});

test('POST /questions/{id}/answers by an expert returns 404 for an unknown question', async () => {
  dynamo.get.mockResolvedValue(null);
  const resp = await handler(
    apiEvent({
      method: 'POST',
      resource: '/questions/{id}/answers',
      pathParameters: { id: 'missing' },
      body: { content: 'x' },
      sub: 'expert-1',
      groups: ['SME'],
    })
  );
  expect(resp.statusCode).toBe(404);
  expect(dynamo.put).not.toHaveBeenCalled();
});
