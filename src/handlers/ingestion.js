'use strict';

/**
 * Automated ingestion from Jira, Confluence and GitHub (Requirement 3).
 * A single function serves three roles, distinguished by the incoming event:
 *   - API Gateway (webhook): POST /webhooks/jira | /webhooks/github
 *       Validates the shared-secret header (Jira) or HMAC signature (GitHub),
 *       then enqueues the payload on the source's SQS queue.
 *   - SQS: processes a queued item -> normalises to an entity -> writes to
 *       DynamoDB and indexes in S3 Vectors (no reviewer step, Requirement 3.4).
 *       Invalid items are flagged validation-failed and routed to the DLQ.
 *   - EventBridge schedule: {trigger:'poll', source:'confluence'|'jira'} -> the
 *       Confluence/Jira poll producer (fetches tagged content, enqueues it).
 */

const crypto = require('crypto');
const dynamo = require('../lib/dynamo');
const audit = require('../lib/audit');
const bedrock = require('../lib/bedrock');
const s3vectors = require('../lib/s3vectors');
const sqs = require('../lib/sqs');
const secrets = require('../lib/secrets');
const logger = require('../lib/logger');
const res = require('../lib/response');
const { tables, vectorIndexFor, queues, secrets: secretIds } = require('../lib/config');
const {
  buildEntityItem,
  entityRef,
  textForEmbedding,
  vectorMetadata,
} = require('../lib/entities');
const { deterministicId, nowIso } = require('../lib/ids');

const QUEUE_URL = {
  jira: queues.ingestionJiraUrl,
  confluence: queues.ingestionConfluenceUrl,
  github: queues.ingestionGithubUrl,
};

/** Which entity type each source maps to. */
const SOURCE_ENTITY = { jira: 'findings', confluence: 'findings', github: 'assets' };

function headerLookup(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Validate an inbound webhook. Returns true when the request is authentic. */
async function validateWebhook(source, event) {
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body || '';

  if (source === 'github') {
    const secret = await secrets.getSecret(secretIds.github);
    const configured = secret && secret.webhookSecret;
    if (!configured || configured === 'REPLACE_ME') {
      logger.warn('github webhook secret not configured; rejecting');
      return false;
    }
    const sig = headerLookup(event.headers, 'x-hub-signature-256');
    if (!sig) return false;
    const expected =
      'sha256=' + crypto.createHmac('sha256', configured).update(rawBody).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch (e) {
      return false;
    }
  }

  // Jira: shared-secret header.
  const secret = await secrets.getSecret(secretIds.jira);
  const configured = secret && secret.webhookSecret;
  if (!configured || configured === 'REPLACE_ME') {
    logger.warn('jira webhook secret not configured; rejecting');
    return false;
  }
  const provided = headerLookup(event.headers, 'x-webhook-secret');
  return provided === configured;
}

/** Normalise a source payload into entity fields. Returns null when unusable. */
function normalise(source, payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (source === 'jira') {
    const issue = payload.issue || payload;
    const fields = issue.fields || {};
    const externalId = issue.key || issue.id || payload.externalId;
    const title = fields.summary || payload.title;
    const content = fields.description || payload.resolutionSummary || payload.content || '';
    if (!externalId || (!title && !content)) return null;
    return {
      externalId,
      title: title || externalId,
      content,
      sourceSystem: 'jira',
      status: 'published',
      tags: (fields.labels || payload.tags || []),
      initiativeId: payload.initiativeId || null,
    };
  }
  if (source === 'confluence') {
    const externalId = payload.id || payload.pageId || payload.externalId;
    const title = payload.title;
    const content =
      (payload.body && (payload.body.storage ? payload.body.storage.value : payload.body)) ||
      payload.content ||
      '';
    if (!externalId || (!title && !content)) return null;
    return {
      externalId,
      title: title || externalId,
      content,
      sourceSystem: 'confluence',
      status: 'published',
      tags: payload.labels || payload.tags || [],
    };
  }
  // github
  const externalId =
    payload.externalId ||
    (payload.pull_request && payload.pull_request.id) ||
    (payload.repository && payload.repository.full_name && payload.number
      ? `${payload.repository.full_name}#${payload.number}`
      : null) ||
    payload.id;
  const title =
    (payload.pull_request && payload.pull_request.title) ||
    payload.title ||
    (payload.head_commit && payload.head_commit.message);
  const content =
    (payload.pull_request && payload.pull_request.body) ||
    payload.description ||
    payload.content ||
    '';
  if (!externalId || (!title && !content)) return null;
  return {
    externalId: String(externalId),
    title: title || String(externalId),
    content,
    assetType: 'code',
    sourceSystem: 'github',
    status: 'published',
    tags: payload.tags || [],
  };
}

async function flagValidationFailed(source, rawBody) {
  const id = deterministicId(source, rawBody).slice(0, 24);
  await dynamo
    .put(tables.reviewQueue, {
      pk: `REVIEW#ingest-${id}`,
      sk: 'METADATA',
      submissionId: `ingest-${id}`,
      entityType: SOURCE_ENTITY[source],
      status: 'validation-failed',
      sourceSystem: source,
      submittedAt: nowIso(),
      rawExcerpt: String(rawBody).slice(0, 500),
    })
    .catch((err) => logger.warn('flagValidationFailed put failed', { error: err.message }));
}

/** Process one queued ingestion item. Throws on validation failure (-> retry/DLQ). */
async function processItem(source, rawBody) {
  let payload;
  try {
    payload = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  } catch (e) {
    await flagValidationFailed(source, rawBody);
    throw new Error('invalid JSON payload');
  }
  const fields = normalise(source, payload);
  if (!fields) {
    await flagValidationFailed(source, rawBody);
    throw new Error('payload failed normalisation');
  }

  const entityType = SOURCE_ENTITY[source];
  const id = deterministicId(source, fields.externalId);
  const item = buildEntityItem(entityType, id, fields);
  await dynamo.put(tables[entityType], item);

  try {
    const text = textForEmbedding(item);
    if (text) {
      const vector = await bedrock.embed(text, 'search_document');
      if (vector && vector.length) {
        await s3vectors.putVector(
          vectorIndexFor(entityType),
          id,
          vector,
          vectorMetadata(entityType, id, item)
        );
      }
    }
  } catch (err) {
    logger.warn('ingestion index failed', { source, id, error: err.message });
  }

  await audit.record({
    actorId: `system:${source}`,
    action: 'ingest',
    entityRef: entityRef(entityType, id),
    details: { source, externalId: fields.externalId },
  });
}

function sourceFromArn(arn) {
  if (!arn) return null;
  if (arn.includes('q-ingestion-jira')) return 'jira';
  if (arn.includes('q-ingestion-confluence')) return 'confluence';
  if (arn.includes('q-ingestion-github')) return 'github';
  return null;
}

/** SQS consumer with partial-batch failure reporting. */
async function handleSqs(records) {
  const batchItemFailures = [];
  for (const record of records) {
    const source = sourceFromArn(record.eventSourceARN);
    try {
      if (!source) throw new Error('unknown source queue');
      await processItem(source, record.body);
    } catch (err) {
      logger.warn('ingestion item failed', { messageId: record.messageId, error: err.message });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

/**
 * Scheduled poll producer. In this MVP the external systems are not reachable,
 * so the poll enqueues nothing by default; the hook exists so a real Confluence/
 * Jira client can be dropped in without changing the pipeline shape.
 */
async function handlePoll(source) {
  logger.info('scheduled poll tick', { source });
  // A real implementation would fetch tagged pages/issues and enqueue each:
  //   await sqs.sendMessage(QUEUE_URL[source], item)
  return { polled: source, enqueued: 0 };
}

exports.handler = async (event) => {
  // SQS
  if (event.Records && event.Records.length && event.Records[0].eventSource === 'aws:sqs') {
    return handleSqs(event.Records);
  }

  // EventBridge scheduled poll
  if (event.trigger === 'poll') {
    return handlePoll(event.source);
  }

  // API Gateway webhook
  const resource = event.resource || '';
  const source = resource.includes('github') ? 'github' : resource.includes('jira') ? 'jira' : null;
  if (!source) return res.notFound('unknown webhook route');

  try {
    const authentic = await validateWebhook(source, event);
    if (!authentic) return res.forbidden('invalid webhook signature');

    const queueUrl = QUEUE_URL[source];
    if (!queueUrl) return res.serverError('ingestion queue not configured');

    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : event.body || '{}';
    await sqs.sendMessage(queueUrl, rawBody);
    return res.accepted({ status: 'queued', source });
  } catch (err) {
    logger.error('ingestion webhook error', { source, error: err.message });
    return res.serverError(err.message);
  }
};

// Exposed for unit testing.
exports._internal = { validateWebhook, normalise, processItem, sourceFromArn };
