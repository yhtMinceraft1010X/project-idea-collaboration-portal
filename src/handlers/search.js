'use strict';

/**
 * Semantic + hybrid search across entity types (Requirement 4).
 *   POST /search  { query, entityTypes?, filters?, topK? }
 * Flow: embed query (Bedrock) -> similarity search each relevant S3 Vectors
 * index -> apply metadata filters -> optional Bedrock re-rank -> return.
 */

const bedrock = require('../lib/bedrock');
const s3vectors = require('../lib/s3vectors');
const audit = require('../lib/audit');
const logger = require('../lib/logger');
const res = require('../lib/response');
const { ENTITY_TYPES, vectorIndexFor, defaults } = require('../lib/config');

/** Build an S3 Vectors metadata filter from a simple {key: value|[values]} map. */
function buildFilter(filters) {
  if (!filters || typeof filters !== 'object') return undefined;
  const clauses = [];
  for (const [key, value] of Object.entries(filters)) {
    if (Array.isArray(value)) clauses.push({ [key]: { $in: value } });
    else clauses.push({ [key]: { $eq: value } });
  }
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

exports.handler = async (event) => {
  const claims = res.getClaims(event);
  const body = res.parseBody(event);
  const query = (body.query || '').trim();
  if (!query) return res.badRequest('query is required');

  const requested = Array.isArray(body.entityTypes) && body.entityTypes.length
    ? body.entityTypes.filter((t) => ENTITY_TYPES.includes(t))
    : ENTITY_TYPES;
  const topK = Math.min(Number(body.topK) || defaults.searchTopK, 25);
  const filter = buildFilter(body.filters);

  try {
    const queryVector = await bedrock.embed(query, 'search_query');
    if (!queryVector || queryVector.length === 0) {
      return res.ok({ results: [], note: 'query could not be embedded' });
    }

    const perIndex = await Promise.all(
      requested.map(async (entityType) => {
        try {
          const hits = await s3vectors.query(vectorIndexFor(entityType), queryVector, {
            topK,
            filter,
          });
          return hits.map((h) => ({
            entityId: h.metadata.entityId || h.key,
            entityType,
            score: h.similarity != null ? h.similarity : 0,
            snippet: h.metadata.snippet || '',
            status: h.metadata.status,
            tags: h.metadata.tags,
          }));
        } catch (err) {
          logger.warn('search index query failed', { entityType, error: err.message });
          return [];
        }
      })
    );

    let results = perIndex.flat().sort((a, b) => b.score - a.score).slice(0, topK);

    // Optional lightweight LLM re-rank of the top candidates. Failure is
    // non-fatal - we fall back to vector-similarity ordering.
    if (results.length > 1 && body.rerank !== false) {
      results = await rerank(query, results).catch(() => results);
    }

    await audit.record({
      actorId: claims.userId,
      action: 'search',
      details: { query, entityTypes: requested, resultCount: results.length },
    });

    return res.ok({ results });
  } catch (err) {
    logger.error('search handler error', { error: err.message, stack: err.stack });
    return res.serverError(err.message);
  }
};

async function rerank(query, results) {
  const candidates = results
    .map((r, i) => `${i}: [${r.entityType}] ${r.snippet}`)
    .join('\n');
  const prompt =
    `Rank the following candidate results by relevance to the query.\n` +
    `Query: "${query}"\n\nCandidates:\n${candidates}\n\n` +
    `Respond with ONLY a JSON array of the candidate indices, most relevant first, e.g. [2,0,1].`;
  const out = await bedrock.chat(prompt, { maxTokens: 100 });
  const match = out.match(/\[[\d,\s]*\]/);
  if (!match) return results;
  const order = JSON.parse(match[0]);
  const reordered = [];
  for (const idx of order) {
    if (results[idx]) reordered.push(results[idx]);
  }
  // Append any not mentioned by the model, preserving similarity order.
  results.forEach((r, i) => {
    if (!order.includes(i)) reordered.push(r);
  });
  return reordered;
}
