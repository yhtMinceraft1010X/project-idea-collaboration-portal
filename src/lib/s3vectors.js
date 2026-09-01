'use strict';

/**
 * Amazon S3 Vectors helper (semantic index + similarity search). One index per
 * entity type lives inside a single vector bucket. Vectors carry filterable
 * metadata (entityType, status, tags, entityId) plus a non-filterable `snippet`
 * declared at index-creation time in deploy.sh.
 */

const {
  S3VectorsClient,
  PutVectorsCommand,
  QueryVectorsCommand,
  DeleteVectorsCommand,
} = require('@aws-sdk/client-s3vectors');

const { REGION, VECTOR_BUCKET } = require('./config');

let _client;
function client() {
  if (!_client) _client = new S3VectorsClient({ region: REGION });
  return _client;
}

/**
 * Upsert a single vector into the given index. Re-using the same key overwrites
 * the previous vector, giving idempotent indexing.
 */
async function putVector(indexName, key, vector, metadata = {}) {
  await client().send(
    new PutVectorsCommand({
      vectorBucketName: VECTOR_BUCKET,
      indexName,
      vectors: [
        {
          key,
          data: { float32: vector },
          metadata,
        },
      ],
    })
  );
}

/**
 * Approximate nearest-neighbour search. Returns [{ key, distance, metadata }].
 * `filter` uses S3 Vectors' Mongo-style operators, e.g.
 *   { $and: [ { status: { $eq: 'published' } } ] }
 */
async function query(indexName, vector, opts = {}) {
  const res = await client().send(
    new QueryVectorsCommand({
      vectorBucketName: VECTOR_BUCKET,
      indexName,
      topK: opts.topK || 10,
      queryVector: { float32: vector },
      returnDistance: true,
      returnMetadata: true,
      ...(opts.filter ? { filter: opts.filter } : {}),
    })
  );
  return (res.vectors || []).map((v) => ({
    key: v.key,
    distance: typeof v.distance === 'number' ? v.distance : null,
    // For cosine distance, similarity ~= 1 - distance.
    similarity: typeof v.distance === 'number' ? 1 - v.distance : null,
    metadata: v.metadata || {},
  }));
}

async function deleteVector(indexName, key) {
  await client().send(
    new DeleteVectorsCommand({
      vectorBucketName: VECTOR_BUCKET,
      indexName,
      keys: [key],
    })
  );
}

module.exports = { putVector, query, deleteVector };
