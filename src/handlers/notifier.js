'use strict';

/**
 * Notification delivery (Requirements 5.4, 7.3). Subscribed to both the
 * overlap-notify and SME-routing SNS topics; forwards each message to Slack
 * and/or Microsoft Teams via incoming-webhook URLs held in Secrets Manager.
 *
 * Degrades gracefully: when a webhook URL is not configured (placeholder), the
 * notification is logged and the invocation still succeeds, so an unconfigured
 * integration never fails the pipeline.
 */

const secrets = require('../lib/secrets');
const audit = require('../lib/audit');
const logger = require('../lib/logger');
const { secrets: secretIds } = require('../lib/config');

function summarise(message, subject) {
  let payload = message;
  try {
    payload = typeof message === 'string' ? JSON.parse(message) : message;
  } catch (e) {
    payload = { text: message };
  }
  if (payload.results && Array.isArray(payload.results)) {
    const strong = payload.results.filter((r) => r.classification === 'Strong').length;
    return `${subject || 'Overlap detection'}: ${payload.results.length} candidate overlap(s), ${strong} strong. Initiative ${payload.initiativeId || ''}.`;
  }
  if (payload.matchedSmeIds) {
    return `SME guidance request ${payload.requestId || ''} routed to: ${payload.matchedSmeIds.join(', ')}.`;
  }
  return subject || 'Notification';
}

async function postWebhook(url, text) {
  if (!url || url === '' || url === 'REPLACE_ME') return false;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return resp.ok;
  } catch (err) {
    logger.warn('webhook post failed', { error: err.message });
    return false;
  }
}

exports.handler = async (event) => {
  const records = (event && event.Records) || [];
  const slack = await secrets.getSecret(secretIds.slackBot).catch(() => null);
  const teams = await secrets.getSecret(secretIds.teamsWebhook).catch(() => null);
  const slackUrl = slack && slack.webhookUrl;
  const teamsUrl = teams && teams.webhookUrl;

  for (const record of records) {
    const sns = record.Sns || {};
    const text = summarise(sns.Message, sns.Subject);
    const deliveredSlack = await postWebhook(slackUrl, text);
    const deliveredTeams = await postWebhook(teamsUrl, text);

    logger.info('notification processed', {
      subject: sns.Subject,
      deliveredSlack,
      deliveredTeams,
      configured: Boolean(slackUrl || teamsUrl),
    });

    await audit
      .record({
        actorId: 'system:notifier',
        action: 'notify',
        details: { subject: sns.Subject || null, deliveredSlack, deliveredTeams },
      })
      .catch((err) => logger.warn('notifier audit failed', { error: err.message }));
  }

  return { processed: records.length };
};

exports._internal = { summarise };
