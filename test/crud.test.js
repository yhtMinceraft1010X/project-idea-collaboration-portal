'use strict';

jest.mock('../src/lib/dynamo');
jest.mock('../src/lib/bedrock');
jest.mock('../src/lib/s3vectors');
jest.mock('../src/lib/events');
jest.mock('../src/lib/audit');

const dynamo = require('../src/lib/dynamo');
const events = require('../src/lib/events');
const audit = require('../src/lib/audit');
const { handler } = require('../src/handlers/crud');
const { tables } = require('../src/lib/config');

function apiEvent({ method, resource, path, body, params, groups }) {
  return {
    httpMethod: method,
    resource: resource || path,
    path: path || resource,
    body: body ? JSON.stringify(body) : null,
    pathParameters: params || null,
    requestContext: { authorizer: { claims: { sub: 'user-1', 'cognito:groups': groups || [] } } },
  };
}

beforeEach(() => {
  dynamo.put.mockResolvedValue(undefined);
  dynamo.get.mockResolvedValue(null);
  dynamo.query.mockResolvedValue({ items: [], lastKey: null });
  dynamo.scan.mockResolvedValue({ items: [], lastKey: null });
  dynamo.update.mockResolvedValue({ pk: 'x', sk: 'METADATA' });
  events.publish.mockResolvedValue(undefined);
  audit.record.mockResolvedValue(undefined);
});

test('creates a Problem and persists it to the problems table (Req 1.1)', async () => {
  const resp = await handler(
    apiEvent({ method: 'POST', resource: '/problems', body: { title: 'Slow builds', description: 'CI is slow', tags: ['ci'] } })
  );
  expect(resp.statusCode).toBe(201);
  const putCalls = dynamo.put.mock.calls;
  expect(putCalls[0][0]).toBe(tables.problems);
  expect(putCalls[0][1].pk).toMatch(/^PROBLEM#/);
  expect(putCalls[0][1].sk).toBe('METADATA');
  const bodyOut = JSON.parse(resp.body);
  expect(bodyOut.entityType).toBe('problems');
  expect(bodyOut.entityId).toBeTruthy();
});

test('creating an Initiative with linkedProblemId writes a relationship edge and fires the event (Req 1.2, 5.1)', async () => {
  const resp = await handler(
    apiEvent({ method: 'POST', resource: '/initiatives', body: { title: 'Build cache', description: 'Speed up CI', linkedProblemId: 'p-123' } })
  );
  expect(resp.statusCode).toBe(201);
  const relCall = dynamo.put.mock.calls.find((c) => c[0] === tables.relationships);
  expect(relCall).toBeDefined();
  expect(relCall[1].pk).toMatch(/^ENTITY#initiatives#/);
  expect(relCall[1].sk).toBe('REL#problems#p-123');
  expect(events.publish).toHaveBeenCalledWith('initiative-registered', expect.objectContaining({ title: 'Build cache' }));
});

test('graph endpoint returns {nodes, edges} (Req 8.3)', async () => {
  dynamo.query.mockResolvedValue({ items: [], lastKey: null });
  const resp = await handler(
    apiEvent({ method: 'GET', resource: '/graph/{entityType}/{id}', params: { entityType: 'initiatives', id: 'i-1' } })
  );
  expect(resp.statusCode).toBe(200);
  const out = JSON.parse(resp.body);
  expect(Array.isArray(out.nodes)).toBe(true);
  expect(Array.isArray(out.edges)).toBe(true);
});

test('collaborate "link" writes a relationship edge and audit event (Req 6.1, 6.3)', async () => {
  const resp = await handler(
    apiEvent({ method: 'POST', resource: '/nudges/{id}/collaborate', params: { id: 'i-1' }, body: { action: 'link', targetInitiativeId: 'i-2' } })
  );
  expect(resp.statusCode).toBe(200);
  const relCall = dynamo.put.mock.calls.find((c) => c[0] === tables.relationships);
  expect(relCall[1].sk).toBe('REL#initiatives#i-2');
  expect(audit.record).toHaveBeenCalled();
  expect(JSON.parse(resp.body).status).toBe('linked');
});
