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
const { newId } = require('../lib/ids');

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

exports.handler = async (event) => {
  const claims = res.getClaims(event);
  const body = res.parseBody(event);
  const query = (body.query || '').trim();
  if (!query) return res.badRequest('query is required');

  const requestId = newId();

  try {
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
  } catch (err) {
    logger.error('guidance handler error', { error: err.message, stack: err.stack });
    return res.serverError(err.message);
  }
};

exports._internal = { availabilityScore };
