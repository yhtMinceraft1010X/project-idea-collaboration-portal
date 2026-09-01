'use strict';

jest.mock('../src/lib/dynamo');
jest.mock('../src/lib/s3');
jest.mock('../src/lib/audit');

const dynamo = require('../src/lib/dynamo');
const s3 = require('../src/lib/s3');
const audit = require('../src/lib/audit');
const { handler } = require('../src/handlers/dashboard');

beforeEach(() => {
  dynamo.scan.mockResolvedValue({ items: [], lastKey: null });
  dynamo.get.mockResolvedValue(null);
  dynamo.put.mockResolvedValue(undefined);
  s3.putObject.mockResolvedValue(undefined);
  audit.record.mockResolvedValue(undefined);
});

test('scheduled run writes a snapshot with themes/overlapHotspots/reuseRate/gaps (Req 8.1)', async () => {
  const out = await handler({ trigger: 'schedule' });
  expect(out.week).toBeTruthy();
  const putCall = dynamo.put.mock.calls[0];
  const item = putCall[1];
  expect(item).toHaveProperty('themes');
  expect(item).toHaveProperty('overlapHotspots');
  expect(item).toHaveProperty('reuseRate');
  expect(item).toHaveProperty('gaps');
  expect(s3.putObject).toHaveBeenCalled();
});

test('GET /dashboard/portfolio requires Portfolio/Mgmt group (Req 9.3)', async () => {
  const resp = await handler({
    httpMethod: 'GET',
    resource: '/dashboard/portfolio',
    requestContext: { authorizer: { claims: { sub: 'u1', 'cognito:groups': ['Lead'] } } },
  });
  expect(resp.statusCode).toBe(403);
});

test('GET /dashboard/portfolio returns a snapshot for an authorised user (Req 8.2)', async () => {
  const resp = await handler({
    httpMethod: 'GET',
    resource: '/dashboard/portfolio',
    requestContext: { authorizer: { claims: { sub: 'u1', 'cognito:groups': ['Portfolio'] } } },
  });
  expect(resp.statusCode).toBe(200);
  const out = JSON.parse(resp.body);
  expect(out).toHaveProperty('themes');
});
