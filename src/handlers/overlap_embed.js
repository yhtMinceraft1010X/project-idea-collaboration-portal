'use strict';

/**
 * Overlap detection - step 1: embed a newly registered initiative and search
 * the initiatives vector index for similar active initiatives (Requirement 5.2).
 * Invoked by the overlap-detection Step Functions workflow with the raw
 * EventBridge event (detail = { initiativeId, title, description }).
 *
 * Returns: { initiativeId, candidates: [{ initiativeId, title, score, snippet }] }
 */

const dynamo = require('../lib/dynamo');
const bedrock = require('../lib/bedrock');
const s3vectors = require('../lib/s3vectors');
const logger = require('../lib/logger');
const { tables, vectorIndexFor } = require('../lib/config');
const { entityKey, textForEmbedding, vectorMetadata } = require('../lib/entities');

exports.handler = async (event) => {
  const detail = (event && event.detail) || event || {};
  const initiativeId = detail.initiativeId;
  if (!initiativeId) throw new Error('initiativeId missing from event');

  // Prefer the record of truth for the text if fields were not on the event.
  let item = { title: detail.title, description: detail.description, status: 'published' };
  if (!detail.title || !detail.description) {
    const stored = await dynamo.get(tables.initiatives, entityKey('initiatives', initiativeId));
    if (stored) item = stored;
  }

  const text = textForEmbedding(item);
  const vector = await bedrock.embed(text || initiativeId, 'search_document');

  const index = vectorIndexFor('initiatives');
  // Upsert this initiative so future initiatives can find it too.
  await s3vectors
    .putVector(index, initiativeId, vector, vectorMetadata('initiatives', initiativeId, item))
    .catch((err) => logger.warn('overlap upsert failed', { error: err.message }));

  const hits = await s3vectors.query(index, vector, {
    topK: 10,
    filter: { status: { $eq: 'published' } },
  });

  const candidates = hits
    .filter((h) => (h.metadata.entityId || h.key) !== initiativeId)
    .map((h) => ({
      initiativeId: h.metadata.entityId || h.key,
      title: (h.metadata.snippet || '').slice(0, 80),
      snippet: h.metadata.snippet || '',
      score: h.similarity != null ? Number(h.similarity.toFixed(4)) : 0,
    }));

  logger.info('overlap embed complete', { initiativeId, candidateCount: candidates.length });
  return { initiativeId, candidates };
};
