'use strict';

/**
 * Core data API handler. Serves CRUD for all six entity types plus the
 * knowledge-graph read and the 1-click collaboration action. A single function
 * (routed by API Gateway path) keeps the infrastructure small while each route
 * maps to a focused operation.
 *
 * Routes (all Cognito-authenticated):
 *   POST   /problems | /initiatives | /solutions | /findings | /assets | /sme-profiles
 *   GET    /<entity>            list recent
 *   GET    /<entity>/{id}       fetch one
 *   PUT    /problems/{id} | /initiatives/{id}   update (status/fields)
 *   GET    /graph/{entityType}/{id}             knowledge-graph nodes+edges
 *   POST   /nudges/{id}/collaborate             link initiatives / log office-hours
 *
 * Requirements: 1 (CRUD + relationships + audit), 6 (collaboration), 8 (graph).
 */

const dynamo = require('../lib/dynamo');
const audit = require('../lib/audit');
const bedrock = require('../lib/bedrock');
const s3vectors = require('../lib/s3vectors');
const events = require('../lib/events');
const logger = require('../lib/logger');
const {
  ENTITY_TYPES,
  ENTITY_KIND,
  tables,
  vectorIndexFor,
} = require('../lib/config');
const {
  entityKey,
  entityRef,
  buildEntityItem,
  relationshipItem,
  textForEmbedding,
  vectorMetadata,
} = require('../lib/entities');
const { newId, nowIso } = require('../lib/ids');
const res = require('../lib/response');

/** Map the leading path segment to an entity type. */
function entityTypeFromPath(path) {
  const seg = (path || '').split('/').filter(Boolean)[0];
  return ENTITY_TYPES.includes(seg) ? seg : null;
}

/**
 * Best-effort semantic indexing. Never fails the request: search simply won't
 * find an item that could not be embedded, which is acceptable for the MVP.
 */
async function indexEntity(entityType, id, item) {
  try {
    const text = textForEmbedding(item);
    if (!text) return;
    const vector = await bedrock.embed(text, 'search_document');
    if (!vector || vector.length === 0) return;
    await s3vectors.putVector(
      vectorIndexFor(entityType),
      id,
      vector,
      vectorMetadata(entityType, id, item)
    );
  } catch (err) {
    logger.warn('indexEntity failed', { entityType, id, error: err.message });
  }
}

async function createEntity(entityType, body, claims) {
  const id = newId();
  const fields = { ...body };
  delete fields.pk;
  delete fields.sk;
  fields.creatorId = claims.userId;
  if (entityType === 'initiatives' && !fields.leadUserId) {
    fields.leadUserId = claims.userId;
  }
  if (entityType === 'sme-profiles') {
    // SME profile is keyed by the user id it describes.
    fields.userId = fields.userId || claims.userId;
  }
  const item = buildEntityItem(entityType, id, fields);
  await dynamo.put(tableFor(entityType), item);

  // Relationship edge + domain event for initiatives linked to a problem.
  if (entityType === 'initiatives' && body.linkedProblemId) {
    await dynamo.put(
      tables.relationships,
      relationshipItem('initiatives', id, 'problems', body.linkedProblemId, 'addresses')
    );
  }

  await indexEntity(entityType, id, item);

  await audit.record({
    actorId: claims.userId,
    action: 'create',
    entityRef: entityRef(entityType, id),
    details: { entityType },
  });

  if (entityType === 'initiatives') {
    // Fire the domain event that starts overlap detection (Requirement 5.1).
    await events.publish('initiative-registered', {
      initiativeId: id,
      title: item.title,
      description: item.description,
    });
  }

  return item;
}

function tableFor(entityType) {
  return tables[entityType];
}

async function getEntity(entityType, id) {
  return dynamo.get(tableFor(entityType), entityKey(entityType, id));
}

async function listEntities(entityType, limit) {
  // Scan is acceptable at MVP data volumes; list newest first.
  const { items } = await dynamo.scan(tableFor(entityType), { limit: limit || 50 });
  return items
    .filter((i) => i.sk === 'METADATA')
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function updateEntity(entityType, id, body, claims) {
  const existing = await getEntity(entityType, id);
  if (!existing) return null;
  const allowed = ['title', 'description', 'status', 'tags', 'techStack', 'content', 'summary'];
  const sets = [];
  const names = {};
  const values = { ':updatedAt': nowIso() };
  for (const field of allowed) {
    if (body[field] !== undefined) {
      sets.push(`#${field} = :${field}`);
      names[`#${field}`] = field;
      values[`:${field}`] = body[field];
    }
  }
  sets.push('#updatedAt = :updatedAt');
  names['#updatedAt'] = 'updatedAt';
  const updated = await dynamo.update(tableFor(entityType), entityKey(entityType, id), {
    updateExpression: `SET ${sets.join(', ')}`,
    expressionAttributeNames: names,
    expressionAttributeValues: values,
  });
  await indexEntity(entityType, id, updated);
  await audit.record({
    actorId: claims.userId,
    action: 'update',
    entityRef: entityRef(entityType, id),
    details: { fields: Object.keys(body || {}) },
  });
  return updated;
}

/** Knowledge-graph read: outgoing + incoming edges for a node. */
async function getGraph(entityType, id) {
  const kind = ENTITY_KIND[entityType];
  if (!kind) return null;
  const nodeRef = `ENTITY#${entityType}#${id}`;
  const outgoing = await dynamo.query(tables.relationships, {
    keyConditionExpression: '#pk = :pk',
    expressionAttributeNames: { '#pk': 'pk' },
    expressionAttributeValues: { ':pk': nodeRef },
  });
  const incoming = await dynamo.query(tables.relationships, {
    indexName: 'InvertedIndex',
    keyConditionExpression: '#sk = :sk',
    expressionAttributeNames: { '#sk': 'sk' },
    expressionAttributeValues: { ':sk': `REL#${entityType}#${id}` },
  });
  const nodes = new Map();
  nodes.set(`${entityType}#${id}`, { id, entityType });
  const edges = [];
  for (const e of outgoing.items) {
    nodes.set(`${e.relatedType}#${e.relatedId}`, { id: e.relatedId, entityType: e.relatedType });
    edges.push({ from: `${entityType}#${id}`, to: `${e.relatedType}#${e.relatedId}`, type: e.relationType });
  }
  for (const e of incoming.items) {
    nodes.set(`${e.sourceType}#${e.sourceId}`, { id: e.sourceId, entityType: e.sourceType });
    edges.push({ from: `${e.sourceType}#${e.sourceId}`, to: `${entityType}#${id}`, type: e.relationType });
  }
  return { nodes: Array.from(nodes.values()), edges };
}

/** 1-click collaboration on a smart nudge (Requirement 6). */
async function collaborate(initiativeId, body, claims) {
  const action = body.action;
  if (action === 'link') {
    if (!body.targetInitiativeId) {
      return { error: 'targetInitiativeId is required for action "link"' };
    }
    const edge = relationshipItem(
      'initiatives',
      initiativeId,
      'initiatives',
      body.targetInitiativeId,
      'collaborates-with'
    );
    await dynamo.put(tables.relationships, edge);
    await audit.record({
      actorId: claims.userId,
      action: 'collaborate-link',
      entityRef: entityRef('initiatives', initiativeId),
      details: { targetInitiativeId: body.targetInitiativeId },
    });
    return { status: 'linked', linkedRef: `${initiativeId}->${body.targetInitiativeId}` };
  }
  if (action === 'office-hours') {
    const edge = relationshipItem(
      'initiatives',
      initiativeId,
      'sme-profiles',
      body.smeId || 'unassigned',
      'office-hours'
    );
    await dynamo.put(tables.relationships, edge);
    await audit.record({
      actorId: claims.userId,
      action: 'collaborate-office-hours',
      entityRef: entityRef('initiatives', initiativeId),
      details: { smeId: body.smeId || null },
    });
    return { status: 'office-hours-booked', linkedRef: body.smeId || null };
  }
  return { error: 'action must be "link" or "office-hours"' };
}

exports.handler = async (event) => {
  const method = event.httpMethod;
  const resource = event.resource || event.path || '';
  const path = event.path || '';
  const claims = res.getClaims(event);
  const body = res.parseBody(event);
  const params = event.pathParameters || {};

  try {
    // /graph/{entityType}/{id}
    if (resource.startsWith('/graph/')) {
      const graph = await getGraph(params.entityType, params.id);
      if (!graph) return res.badRequest('Unknown entity type');
      return res.ok(graph);
    }

    // /nudges/{id}/collaborate
    if (resource.startsWith('/nudges/')) {
      const out = await collaborate(params.id, body, claims);
      if (out.error) return res.badRequest(out.error);
      return res.ok(out);
    }

    const entityType = entityTypeFromPath(resource) || entityTypeFromPath(path);
    if (!entityType) return res.notFound('Unknown route');

    if (method === 'POST') {
      if (!body.title && !body.name && entityType !== 'sme-profiles') {
        return res.badRequest('title is required');
      }
      const item = await createEntity(entityType, body, claims);
      return res.created({ entityId: item.entityId, entityType, status: item.status });
    }

    if (method === 'GET' && params.id) {
      const item = await getEntity(entityType, params.id);
      if (!item) return res.notFound(`${entityType} not found`);
      return res.ok(item);
    }

    if (method === 'GET') {
      const items = await listEntities(entityType);
      return res.ok({ items });
    }

    if (method === 'PUT' && params.id) {
      const updated = await updateEntity(entityType, params.id, body, claims);
      if (!updated) return res.notFound(`${entityType} not found`);
      return res.ok(updated);
    }

    return res.badRequest(`Unsupported ${method} on ${resource}`);
  } catch (err) {
    logger.error('crud handler error', { error: err.message, stack: err.stack, resource, method });
    return res.serverError(err.message);
  }
};
