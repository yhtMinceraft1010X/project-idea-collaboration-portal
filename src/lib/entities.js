'use strict';

/**
 * Domain helpers shared by every handler: DynamoDB key construction,
 * relationship (knowledge-graph) edges, and the text/metadata shapes used for
 * S3 Vectors indexing. Centralising these keeps CRUD, ingestion, review/publish,
 * search and overlap detection in agreement about record structure.
 */

const { ENTITY_KIND, tables } = require('./config');
const { nowIso } = require('./ids');

/** Partition/sort key for an entity metadata record. */
function entityKey(entityType, id) {
  const kind = ENTITY_KIND[entityType];
  if (!kind) throw new Error(`Unknown entity type: ${entityType}`);
  return { pk: `${kind}#${id}`, sk: 'METADATA' };
}

/** The "ENTITY#TYPE#id" reference string used in audit + relationship edges. */
function entityRef(entityType, id) {
  const kind = ENTITY_KIND[entityType];
  return `${kind}#${id}`;
}

/**
 * Build a complete entity item ready for DynamoDB. `fields` are merged on top
 * of the generated metadata; a caller-provided `status` wins over the default.
 */
function buildEntityItem(entityType, id, fields = {}) {
  const { pk, sk } = entityKey(entityType, id);
  const createdAt = fields.createdAt || nowIso();
  return {
    pk,
    sk,
    entityType,
    entityId: id,
    status: fields.status || 'published',
    createdAt,
    updatedAt: createdAt,
    ...fields,
  };
}

/**
 * A knowledge-graph edge. Stored in the relationships table with a generic
 * pk/sk; the InvertedIndex GSI (pk=sk, sk=pk) enables reverse traversal.
 */
function relationshipItem(sourceType, sourceId, relatedType, relatedId, relationType) {
  return {
    pk: `ENTITY#${sourceType}#${sourceId}`,
    sk: `REL#${relatedType}#${relatedId}`,
    relationType: relationType || 'related',
    sourceType,
    sourceId,
    relatedType,
    relatedId,
    createdAt: nowIso(),
  };
}

/** Table name for a given entity type. */
function tableFor(entityType) {
  return tables[entityType];
}

/**
 * Compose the text that represents an entity for embedding. Falls back
 * gracefully across the differing field names of the six entity types.
 */
function textForEmbedding(item = {}) {
  const parts = [
    item.title,
    item.name,
    item.description,
    item.content,
    item.body,
    item.summary,
    Array.isArray(item.tags) ? item.tags.join(' ') : item.tags,
    Array.isArray(item.expertiseDomains) ? item.expertiseDomains.join(' ') : null,
    item.techStack,
  ];
  return parts.filter(Boolean).join('\n').slice(0, 4000);
}

/**
 * Filterable + non-filterable metadata attached to each vector. `snippet` is
 * declared non-filterable at index creation (it can be large / free text).
 */
function vectorMetadata(entityType, id, item = {}) {
  const text = textForEmbedding(item);
  return {
    entityType,
    entityId: id,
    status: item.status || 'published',
    tags: Array.isArray(item.tags) ? item.tags.join(',') : String(item.tags || ''),
    snippet: text.slice(0, 500),
  };
}

module.exports = {
  entityKey,
  entityRef,
  buildEntityItem,
  relationshipItem,
  tableFor,
  textForEmbedding,
  vectorMetadata,
};
