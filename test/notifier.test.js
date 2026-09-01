'use strict';

jest.mock('../src/lib/secrets');
jest.mock('../src/lib/audit');

const secrets = require('../src/lib/secrets');
const audit = require('../src/lib/audit');
const { handler, _internal } = require('../src/handlers/notifier');

beforeEach(() => {
  audit.record.mockResolvedValue(undefined);
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
});

test('forwards a notification to the Slack webhook URL from Secrets Manager (Req 5.4)', async () => {
  secrets.getSecret.mockImplementation(async (id) => {
    if (String(id).includes('slack')) return { webhookUrl: 'https://hooks.slack.test/abc' };
    return { webhookUrl: '' };
  });
  const event = {
    Records: [
      { Sns: { Subject: 'Overlap detection results', Message: JSON.stringify({ initiativeId: 'i1', results: [{ classification: 'Strong' }] }) } },
    ],
  };
  const out = await handler(event);
  expect(out.processed).toBe(1);
  expect(global.fetch).toHaveBeenCalledWith('https://hooks.slack.test/abc', expect.objectContaining({ method: 'POST' }));
});

test('degrades gracefully when no webhook is configured', async () => {
  secrets.getSecret.mockResolvedValue({ webhookUrl: '' });
  const event = { Records: [{ Sns: { Subject: 'x', Message: '{}' } }] };
  const out = await handler(event);
  expect(out.processed).toBe(1);
  expect(global.fetch).not.toHaveBeenCalled();
});

test('summarise renders an SME routing message', () => {
  const text = _internal.summarise(JSON.stringify({ requestId: 'r1', matchedSmeIds: ['a', 'b'] }), 'SME');
  expect(text).toContain('a, b');
});
