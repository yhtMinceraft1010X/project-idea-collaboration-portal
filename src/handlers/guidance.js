'use strict';

/**
 * SME guidance routing (Requirement 7).
 *   POST /guidance-requests { query, context? }
 * Matches the request to 1-3 SMEs by expertise (vector similarity) weighted
 * with availability (70/30 per OED-3), publishes the match to the SME-routing
 * SNS topic, and logs the routing event for credibility tracking.
 *
 * Returns: { requestId, matchedSmeIds: [] }
 */

const dynamo = require('../lib/dynamo');
const audit = require('../lib/audit');
const bedrock = require('../lib/bedrock');
const s3vectors = require('../lib/s3vectors');
const sns = require('../lib/sns');
const logger = require('../lib/logger');
const res = require('../lib/response');
const { tables, vectorIndexFor, topics, defaults } = require('../lib/config');
const { newId, nowIso } = require('../lib/ids');

const TOPIC_ARN = process.env.TOPIC_SME_ROUTING_ARN || topics.smeRoutingArn;

/** Map an availability descriptor to a 0..1 score. */
function availabilityScore(availability) {
  if (typeof availability === 'number') return Math.max(0, Math.min(1, availability));
  const map = { high: 1, medium: 0.6, low: 0.3, unavailable: 0 };
  return map[String(availability || '').toLowerCase()] ?? 0.5;
}

function smeUserId(profile, fallbackKey) {
  return profile.userId || profile.entityId || fallbackKey;
}

async function matchByVector(query) {
  const vector = await bedrock.embed(query, 'search_query');
  if (!vector || !vector.length) return [];
  const hits = await s3vectors.query(vectorIndexFor('sme-profiles'), vector, { topK: 5 });
  const matches = [];
  for (const h of hits) {
    const userId = h.metadata.entityId || h.key;
    const profile = await dynamo
      .get(tables['sme-profiles'], { pk: `SME#${userId}`, sk: 'METADATA' })
      .catch(() => null);
    const similarity = h.similarity != null ? h.similarity : 0;
    const avail = availabilityScore(profile && profile.availability);
    matches.push({
      smeId: userId,
      score: 0.7 * similarity + 0.3 * avail,
      similarity,
      profile: profile || null,
    });
  }
  return matches;
}

/** Fallback: keyword overlap against expertise domains when no vectors exist. */
async function matchByScan(query) {
  const { items } = await dynamo.scan(tables['sme-profiles'], { limit: 100 });
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  return items
    .filter((p) => p.sk === 'METADATA')
    .map((p) => {
      const domains = (Array.isArray(p.expertiseDomains) ? p.expertiseDomains : []).join(' ').toLowerCase();
      const overlap = terms.filter((t) => domains.includes(t)).length;
      return {
        smeId: smeUserId(p, p.pk),
        score: overlap + 0.3 * availabilityScore(p.availability),
        profile: p,
      };
    })
    .filter((m) => m.score > 0);
}

const guidanceMetaKey = (id) => ({ pk: `GUIDANCE#${id}`, sk: 'METADATA' });

/**
 * POST /guidance-requests — match the request to 1-3 SMEs, persist it (so the
 * requester can later see the response and SMEs can pick it up), publish the
 * routing event and audit the routing.
 */
async function routeGuidance(event, claims, body) {
  const query = (body.query || '').trim();
  if (!query) return res.badRequest('query is required');

  const requestId = newId();

  let matches = await matchByVector(query).catch((err) => {
    logger.warn('vector SME match failed; falling back to scan', { error: err.message });
    return [];
  });
  if (matches.length === 0) {
    matches = await matchByScan(query);
  }

  matches.sort((a, b) => b.score - a.score);
  const selected = matches.slice(0, defaults.smeMaxMatches);
  const matchedSmeIds = selected.map((m) => m.smeId);

  const createdAt = nowIso();

  // Persist the request metadata row so the round-trip is durable.
  await dynamo.put(tables.guidanceRequests, {
    ...guidanceMetaKey(requestId),
    requestId,
    query,
    context: body.context || null,
    requesterId: claims.userId,
    matchedSmeIds,
    status: 'routed',
    responderId: null,
    responseComments: null,
    respondedAt: null,
    createdAt,
  });

  // One assignee edge per matched SME so an SME can list requests routed to them.
  await Promise.all(
    matchedSmeIds.map((smeId) =>
      Promise.resolve(
        dynamo.put(tables.guidanceRequests, {
          pk: `GUIDANCE#${requestId}`,
          sk: `ASSIGNEE#${smeId}`,
          assigneeId: smeId,
          requestId,
          createdAt,
        })
      ).catch((err) => logger.warn('assignee edge write failed', { smeId, error: err.message }))
    )
  );

  if (matchedSmeIds.length > 0 && TOPIC_ARN) {
    await sns
      .publish(
        TOPIC_ARN,
        {
          requestId,
          query,
          context: body.context || null,
          requesterId: claims.userId,
          matchedSmeIds,
        },
        'SME guidance routing'
      )
      .catch((err) => logger.warn('SME routing publish failed', { error: err.message }));
  }

  await audit.record({
    actorId: claims.userId,
    action: 'guidance-route',
    entityRef: `GUIDANCE#${requestId}`,
    details: { query, matchedSmeIds },
  });

  return res.ok({ requestId, matchedSmeIds });
}

/** GET /guidance-requests — the caller's own requests (newest first). */
async function listMyRequests(claims) {
  const { items } = await dynamo.query(tables.guidanceRequests, {
    indexName: 'RequesterIndex',
    keyConditionExpression: '#r = :r',
    expressionAttributeNames: { '#r': 'requesterId' },
    expressionAttributeValues: { ':r': claims.userId },
    scanIndexForward: false,
    limit: 100,
  });
  return res.ok({ items });
}

/** GET /guidance-requests/{id} — requester, an assignee, or SME/Ops. */
async function getOne(id, claims) {
  const item = await dynamo.get(tables.guidanceRequests, guidanceMetaKey(id));
  if (!item) return res.notFound('guidance request not found');
  const matched = Array.isArray(item.matchedSmeIds) ? item.matchedSmeIds : [];
  const allowed =
    claims.userId === item.requesterId ||
    matched.includes(claims.userId) ||
    res.hasGroup(claims, ['SME', 'Ops']);
  if (!allowed) return res.forbidden('Not authorised to view this request');
  return res.ok(item);
}

/** GET /guidance-requests/assigned — requests routed to the calling SME. */
async function listAssigned(claims) {
  const { items: edges } = await dynamo.query(tables.guidanceRequests, {
    indexName: 'AssigneeIndex',
    keyConditionExpression: '#a = :a',
    expressionAttributeNames: { '#a': 'assigneeId' },
    expressionAttributeValues: { ':a': claims.userId },
    scanIndexForward: false,
    limit: 100,
  });
  const items = [];
  for (const edge of edges) {
    const meta = await dynamo
      .get(tables.guidanceRequests, guidanceMetaKey(edge.requestId))
      .catch(() => null);
    if (meta) items.push(meta);
  }
  return res.ok({ items });
}

/** POST /guidance-requests/{id}/respond — SME accept/reject + comments. */
async function respond(id, claims, body) {
  const item = await dynamo.get(tables.guidanceRequests, guidanceMetaKey(id));
  if (!item) return res.notFound('guidance request not found');

  const matched = Array.isArray(item.matchedSmeIds) ? item.matchedSmeIds : [];
  const allowed = matched.includes(claims.userId) || res.hasGroup(claims, ['SME', 'Ops']);
  if (!allowed) return res.forbidden('Only a matched SME may respond');

  const decision = body.decision;
  const status =
    decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : null;
  if (!status) return res.badRequest("decision must be 'accept' or 'reject'");

  const respondedAt = nowIso();
  const updated = await dynamo.update(tables.guidanceRequests, guidanceMetaKey(id), {
    updateExpression:
      'SET #s = :s, responderId = :rid, responseComments = :c, respondedAt = :t',
    expressionAttributeNames: { '#s': 'status' },
    expressionAttributeValues: {
      ':s': status,
      ':rid': claims.userId,
      ':c': body.comments || null,
      ':t': respondedAt,
    },
  });

  await audit.record({
    actorId: claims.userId,
    action: 'guidance-respond',
    entityRef: `GUIDANCE#${id}`,
    details: { decision, status },
  });

  return res.ok(updated);
}

/** Resolve the {id} path param, falling back to parsing resource/path. */
function pathId(event) {
  if (event.pathParameters && event.pathParameters.id) return event.pathParameters.id;
  const path = event.path || event.resource || '';
  const m = path.match(/\/guidance-requests\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

exports.handler = async (event) => {
  const method =
    event.httpMethod || (event.requestContext && event.requestContext.http && event.requestContext.http.method);
  const resource = event.resource || event.path || '';
  const claims = res.getClaims(event);
  const body = res.parseBody(event);

  try {
    if (method === 'POST' && resource === '/guidance-requests') {
      return await routeGuidance(event, claims, body);
    }
    if (method === 'GET' && resource === '/guidance-requests') {
      return await listMyRequests(claims);
    }
    if (method === 'GET' && resource === '/guidance-requests/assigned') {
      return await listAssigned(claims);
    }
    if (method === 'POST' && /\/guidance-requests\/[^/]+\/respond$/.test(resource)) {
      return await respond(pathId(event), claims, body);
    }
    if (method === 'GET' && /\/guidance-requests\/[^/]+$/.test(resource)) {
      return await getOne(pathId(event), claims);
    }

    return res.badRequest(`Unsupported ${method} on ${resource}`);
  } catch (err) {
    logger.error('guidance handler error', { error: err.message, stack: err.stack });
    return res.serverError(err.message);
  }
};

exports._internal = { availabilityScore, routeGuidance, listMyRequests, getOne, listAssigned, respond };
