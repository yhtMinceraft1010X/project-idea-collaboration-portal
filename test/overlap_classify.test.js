'use strict';

jest.mock('../src/lib/dynamo');
jest.mock('../src/lib/bedrock');
jest.mock('../src/lib/ssm');
jest.mock('../src/lib/audit');

const dynamo = require('../src/lib/dynamo');
const ssm = require('../src/lib/ssm');
const bedrock = require('../src/lib/bedrock');
const audit = require('../src/lib/audit');
const { handler } = require('../src/handlers/overlap_classify');

beforeEach(() => {
  dynamo.put.mockResolvedValue(undefined);
  ssm.getNumber.mockResolvedValue(0.75);
  bedrock.chat.mockResolvedValue('Partial');
  audit.record.mockResolvedValue(undefined);
});

test('every candidate is classified as Strong, Partial or Novel (Req 5.3)', async () => {
  const out = await handler({
    initiativeId: 'i-1',
    snippet: 'build caching initiative',
    candidates: [
      { initiativeId: 'c1', score: 0.95, snippet: 'distributed build cache' },
      { initiativeId: 'c2', score: 0.5, snippet: 'unrelated topic' },
      { initiativeId: 'c3', score: 0.78, snippet: 'ci pipeline speedups' },
    ],
  });
  expect(out.results).toHaveLength(3);
  for (const r of out.results) {
    expect(['Strong', 'Partial', 'Novel']).toContain(r.classification);
    expect(r).toHaveProperty('candidateInitiativeId');
    expect(r).toHaveProperty('overlapScore');
  }
  expect(dynamo.put).toHaveBeenCalledTimes(3);
});

test('persists each overlap result to the overlap-results table', async () => {
  await handler({ initiativeId: 'i-2', candidates: [{ initiativeId: 'c9', score: 0.9, snippet: 's' }] });
  const call = dynamo.put.mock.calls[0];
  expect(call[1].pk).toBe('INITIATIVE#i-2');
  expect(call[1].sk).toBe('OVERLAP#c9');
});
