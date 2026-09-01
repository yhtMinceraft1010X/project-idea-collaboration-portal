'use strict';

/**
 * Manual contribution + review/publish workflow (Requirement 2).
 *   POST /submissions               create a pending submission (status=pending)
 *   GET  /submissions               reviewer worklist (Reviewer group)
 *   POST /submissions/{id}/approve  approve/reject (Reviewer group)
 *   SQS  q-review                   async review-task consumer (handoff signal)
 *
 * On approval the content is written to its entity table, embedded via Bedrock
 * and indexed into S3 Vectors. On rejection nothing is indexed.
 */

const dynamo = require('../lib/dynamo');
const audit = require('../lib/audit');
const bedrock = require('../lib/bedrock');
const s3vectors = require('../lib/s3vectors');
const sqs = require('../lib/sqs');
const logger = require('../lib/logger');
const res = require('../lib/response');
const { tables, vectorIndexFor, ENTITY_TYPES, queues } = require('../lib/config');
const {
  entityKey,
  entityRef,
  buildEntityItem,
  textForEmbedding,
  vectorMetadata,
} = require('../lib/entities');
const { newId, nowIso } = require('../lib/ids');

const submissionKey = (id) => ({ pk: `REVIEW#${id}`, sk: 'METADATA' });

async function createSubmission(body, claims) {
  if (!ENTITY_TYPES.includes(body.entityType)) {
    return { error: 'entityType must be one of ' + ENTITY_TYPES.join(', ') };
  }
  if (!body.content || typeof body.content !== 'object') {
    return { error: 'content object is required' };
  }
  const submissionId = newId();
  const submittedAt = nowIso();
  const item = {
    ...submissionKey(submissionId),
    submissionId,
    entityType: body.entityType,
    content: body.content,
    contributionType: body.template ? 'template' : body.upload ? 'upload' : 'freeform',
    submitterId: claims.userId,
    status: 'pending',
    submittedAt,
  };
  await dynamo.put(tables.reviewQueue, item);

  // Enqueue an async review task (Requirement 2.2). Non-fatal if it fails; the
  // review-queue table is the durable worklist source of truth.
  if (queues.reviewUrl) {
    await sqs
      .sendMessage(queues.reviewUrl, { submissionId, entityType: body.entityType })
      .catch((err) => logger.warn('enqueue review task failed', { error: err.message }));
  }

  await audit.record({
    actorId: claims.userId,
    action: 'submit',
    entityRef: `REVIEW#${submissionId}`,
    details: { entityType: body.entityType },
  });
  return { submissionId, status: 'pending' };
}

async function listPending() {
  const { items } = await dynamo.query(tables.reviewQueue, {
    indexName: 'StatusIndex',
    keyConditionExpression: '#s = :s',
    expressionAttributeNames: { '#s': 'status' },
    expressionAttributeValues: { ':s': 'pending' },
    scanIndexForward: false,
    limit: 100,
  });
  return items;
}

async function decide(submissionId, body, claims) {
  const submission = await dynamo.get(tables.reviewQueue, submissionKey(submissionId));
  if (!submission) return { notFound: true };

  const approve = body.decision === 'approve' || body.decision === 'approved';
  if (!approve) {
    await dynamo.update(tables.reviewQueue, submissionKey(submissionId), {
      updateExpression: 'SET #s = :s, reviewerId = :r, reviewComments = :c, reviewedAt = :t',
      expressionAttributeNames: { '#s': 'status' },
      expressionAttributeValues: {
        ':s': 'rejected',
        ':r': claims.userId,
        ':c': body.comments || '',
        ':t': nowIso(),
      },
    });
    await audit.record({
      actorId: claims.userId,
      action: 'reject',
      entityRef: `REVIEW#${submissionId}`,
      details: { comments: body.comments || '' },
    });
    return { submissionId, status: 'rejected' };
  }

  // Approve: publish the entity, embed and index it.
  const entityType = submission.entityType;
  const entityId = newId();
  const fields = { ...submission.content, creatorId: submission.submitterId, sourceSystem: 'manual' };
  const item = buildEntityItem(entityType, entityId, fields);
  await dynamo.put(tables[entityType], item);

  try {
    const text = textForEmbedding(item);
    if (text) {
      const vector = await bedrock.embed(text, 'search_document');
      if (vector && vector.length) {
        await s3vectors.putVector(
          vectorIndexFor(entityType),
          entityId,
          vector,
          vectorMetadata(entityType, entityId, item)
        );
      }
    }
  } catch (err) {
    logger.warn('index on approve failed', { entityType, entityId, error: err.message });
  }

  await dynamo.update(tables.reviewQueue, submissionKey(submissionId), {
    updateExpression: 'SET #s = :s, reviewerId = :r, reviewComments = :c, reviewedAt = :t, publishedEntityId = :e',
    expressionAttributeNames: { '#s': 'status' },
    expressionAttributeValues: {
      ':s': 'approved',
      ':r': claims.userId,
      ':c': body.comments || '',
      ':t': nowIso(),
      ':e': entityId,
    },
  });

  await audit.record({
    actorId: claims.userId,
    action: 'approve',
    entityRef: entityRef(entityType, entityId),
    details: { submissionId },
  });
  return { submissionId, status: 'approved', publishedEntityId: entityId };
}

/** SQS consumer: review-task handoff signal. Ack all (worklist is in DynamoDB). */
async function handleReviewQueue(records) {
  for (const r of records) {
    logger.info('review task received', { messageId: r.messageId, body: r.body });
  }
  return { batchItemFailures: [] };
}

exports.handler = async (event) => {
  // SQS trigger
  if (event.Records && event.Records.length && event.Records[0].eventSource === 'aws:sqs') {
    return handleReviewQueue(event.Records);
  }

  const method = event.httpMethod;
  const resource = event.resource || '';
  const claims = res.getClaims(event);
  const body = res.parseBody(event);
  const params = event.pathParameters || {};

  try {
    if (method === 'POST' && resource === '/submissions') {
      const out = await createSubmission(body, claims);
      if (out.error) return res.badRequest(out.error);
      return res.accepted(out);
    }

    if (method === 'GET' && resource === '/submissions') {
      if (!res.hasGroup(claims, ['Reviewer', 'Ops'])) {
        return res.forbidden('Reviewer group required');
      }
      const items = await listPending();
      return res.ok({ items });
    }

    if (method === 'POST' && resource === '/submissions/{id}/approve') {
      if (!res.hasGroup(claims, ['Reviewer', 'Ops'])) {
        return res.forbidden('Reviewer group required');
      }
      const out = await decide(params.id, body, claims);
      if (out.notFound) return res.notFound('submission not found');
      return res.ok(out);
    }

    return res.badRequest(`Unsupported ${method} on ${resource}`);
  } catch (err) {
    logger.error('submissions handler error', { error: err.message, stack: err.stack });
    return res.serverError(err.message);
  }
};
