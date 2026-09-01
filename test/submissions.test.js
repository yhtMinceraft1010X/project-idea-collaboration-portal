'use strict';

jest.mock('../src/lib/dynamo');
jest.mock('../src/lib/bedrock');
jest.mock('../src/lib/s3vectors');
jest.mock('../src/lib/sqs');
jest.mock('../src/lib/audit');

const dynamo = require('../src/lib/dynamo');
const bedrock = require('../src/lib/bedrock');
const s3vectors = require('../src/lib/s3vectors');
const audit = require('../src/lib/audit');
const { handler } = require('../src/handlers/submissions');
const { tables } = require('../src/lib/config');

function apiEvent({ method, resource, body, params, groups }) {
  return {
    httpMethod: method,
    resource,
    body: body ? JSON.stringify(body) : null,
    pathParameters: params || null,
    requestContext: { authorizer: { claims: { sub: 'rev-1', 'cognito:groups': groups || [] } } },
  };
}

beforeEach(() => {
  dynamo.put.mockResolvedValue(undefined);
  dynamo.update.mockResolvedValue({});
  dynamo.query.mockResolvedValue({ items: [], lastKey: null });
  bedrock.embed.mockResolvedValue([0.1, 0.2, 0.3]);
  s3vectors.putVector.mockResolvedValue(undefined);
  audit.record.mockResolvedValue(undefined);
});

test('creating a submission stores a pending record (Req 2.1)', async () => {
  const resp = await handler(
    apiEvent({ method: 'POST', resource: '/submissions', body: { entityType: 'findings', content: { title: 'Lesson', content: 'body' } } })
  );
  expect(resp.statusCode).toBe(202);
  const call = dynamo.put.mock.calls[0];
  expect(call[0]).toBe(tables.reviewQueue);
  expect(call[1].status).toBe('pending');
  expect(JSON.parse(resp.body).status).toBe('pending');
});

test('approving a submission transitions status to approved and indexes it (Req 2.3)', async () => {
  dynamo.get.mockResolvedValue({
    pk: 'REVIEW#s1', sk: 'METADATA', submissionId: 's1', entityType: 'findings',
    content: { title: 'Lesson', content: 'body' }, submitterId: 'u1', status: 'pending',
  });
  const resp = await handler(
    apiEvent({ method: 'POST', resource: '/submissions/{id}/approve', params: { id: 's1' }, body: { decision: 'approve' }, groups: ['Reviewer'] })
  );
  expect(resp.statusCode).toBe(200);
  expect(JSON.parse(resp.body).status).toBe('approved');
  const updateCall = dynamo.update.mock.calls.find((c) => c[2].expressionAttributeValues[':s'] === 'approved');
  expect(updateCall).toBeDefined();
  expect(s3vectors.putVector).toHaveBeenCalled();
});

test('rejecting a submission sets status rejected and does NOT index (Req 2.4)', async () => {
  dynamo.get.mockResolvedValue({
    pk: 'REVIEW#s2', sk: 'METADATA', submissionId: 's2', entityType: 'findings',
    content: { title: 'x' }, submitterId: 'u1', status: 'pending',
  });
  const resp = await handler(
    apiEvent({ method: 'POST', resource: '/submissions/{id}/approve', params: { id: 's2' }, body: { decision: 'reject' }, groups: ['Reviewer'] })
  );
  expect(JSON.parse(resp.body).status).toBe('rejected');
  expect(s3vectors.putVector).not.toHaveBeenCalled();
});

test('non-reviewer cannot approve (Req 9.3)', async () => {
  const resp = await handler(
    apiEvent({ method: 'POST', resource: '/submissions/{id}/approve', params: { id: 's3' }, body: { decision: 'approve' }, groups: ['Lead'] })
  );
  expect(resp.statusCode).toBe(403);
});
