'use strict';

/**
 * Q&A between users and experts - a dedicated item type alongside problems and
 * initiatives. "Expert" maps to the existing Cognito `SME` group; no new role
 * concept is introduced.
 *
 * Routes (all Cognito-authenticated):
 *   POST /questions                 - any user asks a question
 *   GET  /questions                 - experts see every question; everyone else sees only their own
 *   GET  /questions/{id}            - the asker or any expert; includes all answers
 *   POST /questions/{id}/answers    - any expert answers a question
 */

const dynamo = require('../lib/dynamo');
const audit = require('../lib/audit');
const logger = require('../lib/logger');
const res = require('../lib/response');
const { tables } = require('../lib/config');
const { newId, nowIso } = require('../lib/ids');

const EXPERT_GROUPS = ['SME'];

const isExpert = (claims) => res.hasGroup(claims, EXPERT_GROUPS);
const creatorUsername = (claims) => claims.username || claims.email || claims.userId;
const questionKey = (id) => ({ pk: `QUESTION#${id}`, sk: 'METADATA' });

async function createQuestion(claims, body) {
  const title = (body.title || '').trim();
  const content = (body.content || body.description || '').trim();
  if (!title) return res.badRequest('title is required');

  const questionId = newId();
  const createdAt = nowIso();
  const item = {
    ...questionKey(questionId),
    entityType: 'questions',
    entityId: questionId,
    questionId,
    title,
    content,
    status: 'open',
    creatorId: claims.userId,
    creatorUsername: creatorUsername(claims),
    createdAt,
    updatedAt: createdAt,
  };
  await dynamo.put(tables.qa, item);
  await audit.record({
    actorId: claims.userId,
    action: 'question-create',
    entityRef: `QUESTION#${questionId}`,
    details: { title },
  });
  return res.created({ questionId, status: item.status });
}

async function listQuestions(claims) {
  if (isExpert(claims)) {
    const { items } = await dynamo.scan(tables.qa, { limit: 200 });
    const questions = items
      .filter((i) => i.sk === 'METADATA')
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return res.ok({ items: questions });
  }

  const { items } = await dynamo.query(tables.qa, {
    indexName: 'CreatorIndex',
    keyConditionExpression: '#c = :c',
    expressionAttributeNames: { '#c': 'creatorId' },
    expressionAttributeValues: { ':c': claims.userId },
    scanIndexForward: false,
    limit: 100,
  });
  const questions = items.filter((i) => i.sk === 'METADATA');
  return res.ok({ items: questions });
}

async function getQuestion(id, claims) {
  const { items } = await dynamo.query(tables.qa, {
    keyConditionExpression: '#pk = :pk',
    expressionAttributeNames: { '#pk': 'pk' },
    expressionAttributeValues: { ':pk': `QUESTION#${id}` },
  });
  const meta = items.find((i) => i.sk === 'METADATA');
  if (!meta) return res.notFound('question not found');

  const allowed = claims.userId === meta.creatorId || isExpert(claims);
  if (!allowed) return res.forbidden('Only the asker or an expert may view this question');

  const answers = items
    .filter((i) => i.sk !== 'METADATA')
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return res.ok({ ...meta, answers });
}

async function createAnswer(id, claims, body) {
  if (!isExpert(claims)) return res.forbidden('Only an expert may answer a question');

  const content = (body.content || '').trim();
  if (!content) return res.badRequest('content is required');

  const meta = await dynamo.get(tables.qa, questionKey(id));
  if (!meta) return res.notFound('question not found');

  const answerId = newId();
  const createdAt = nowIso();
  const answer = {
    pk: `QUESTION#${id}`,
    sk: `ANSWER#${answerId}`,
    answerId,
    questionId: id,
    content,
    creatorId: claims.userId,
    creatorUsername: creatorUsername(claims),
    createdAt,
  };
  await dynamo.put(tables.qa, answer);
  await dynamo.update(tables.qa, questionKey(id), {
    updateExpression: 'SET #s = :s, #u = :u',
    expressionAttributeNames: { '#s': 'status', '#u': 'updatedAt' },
    expressionAttributeValues: { ':s': 'answered', ':u': createdAt },
  });
  await audit.record({
    actorId: claims.userId,
    action: 'question-answer',
    entityRef: `QUESTION#${id}`,
    details: { answerId },
  });
  return res.created(answer);
}

function pathId(event) {
  if (event.pathParameters && event.pathParameters.id) return event.pathParameters.id;
  const path = event.path || event.resource || '';
  const m = path.match(/\/questions\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

exports.handler = async (event) => {
  const method = event.httpMethod;
  const resource = event.resource || event.path || '';
  const claims = res.getClaims(event);
  const body = res.parseBody(event);

  try {
    if (method === 'POST' && resource === '/questions') {
      return await createQuestion(claims, body);
    }
    if (method === 'GET' && resource === '/questions') {
      return await listQuestions(claims);
    }
    if (method === 'POST' && /\/questions\/[^/]+\/answers$/.test(resource)) {
      return await createAnswer(pathId(event), claims, body);
    }
    if (method === 'GET' && /\/questions\/[^/]+$/.test(resource)) {
      return await getQuestion(pathId(event), claims);
    }

    return res.badRequest(`Unsupported ${method} on ${resource}`);
  } catch (err) {
    logger.error('qa handler error', { error: err.message, stack: err.stack });
    return res.serverError(err.message);
  }
};
