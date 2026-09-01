'use strict';

/**
 * Overlap detection - step 2: classify each candidate pairing as Strong,
 * Partial or Novel and persist to the overlap-results table (Requirement 5.3).
 * Invoked by the overlap-detection Step Functions workflow.
 *
 * Input:  { initiativeId, candidates: [{ initiativeId, title, score, snippet }] }
 * Output: { results: [{ candidateInitiativeId, classification, overlapScore }] }
 */

const dynamo = require('../lib/dynamo');
const audit = require('../lib/audit');
const bedrock = require('../lib/bedrock');
const ssm = require('../lib/ssm');
const logger = require('../lib/logger');
const { tables, defaults, params } = require('../lib/config');
const { nowIso } = require('../lib/ids');

const CLASSES = ['Strong', 'Partial', 'Novel'];

/** Score-based fallback classification. */
function classifyByScore(score, threshold) {
  if (score >= Math.min(threshold + 0.1, 0.9)) return 'Strong';
  if (score >= threshold) return 'Partial';
  return 'Novel';
}

exports.handler = async (event) => {
  const initiativeId = event.initiativeId;
  const candidates = Array.isArray(event.candidates) ? event.candidates : [];
  if (!initiativeId) throw new Error('initiativeId missing');

  const threshold = await ssm.getNumber(params.overlapThreshold, defaults.overlapThreshold);
  const detectedAt = nowIso();
  const results = [];

  for (const cand of candidates) {
    const score = Number(cand.score) || 0;
    let classification = classifyByScore(score, threshold);

    // For borderline scores near the threshold, ask Bedrock to adjudicate.
    if (score >= threshold - 0.1 && score <= threshold + 0.1) {
      try {
        const prompt =
          `Two initiatives may overlap. Similarity score: ${score.toFixed(3)}.\n` +
          `Initiative A snippet: "${(event.snippet || '').slice(0, 300)}"\n` +
          `Initiative B snippet: "${(cand.snippet || '').slice(0, 300)}"\n` +
          `Classify their overlap as exactly one word: Strong, Partial, or Novel.`;
        const out = (await bedrock.chat(prompt, { maxTokens: 10 })).trim();
        const matched = CLASSES.find((c) => out.toLowerCase().startsWith(c.toLowerCase()));
        if (matched) classification = matched;
      } catch (err) {
        logger.warn('overlap classify LLM failed; using score', { error: err.message });
      }
    }

    await dynamo
      .put(tables.overlapResults, {
        pk: `INITIATIVE#${initiativeId}`,
        sk: `OVERLAP#${cand.initiativeId}`,
        initiativeId,
        candidateInitiativeId: cand.initiativeId,
        overlapScore: score,
        classification,
        detectedAt,
      })
      .catch((err) => logger.warn('overlap result put failed', { error: err.message }));

    results.push({
      candidateInitiativeId: cand.initiativeId,
      classification,
      overlapScore: score,
    });
  }

  await audit.record({
    actorId: 'system:overlap',
    action: 'overlap-detect',
    entityRef: `INITIATIVE#${initiativeId}`,
    details: { candidateCount: candidates.length, threshold },
  });

  logger.info('overlap classify complete', { initiativeId, results: results.length });
  return { initiativeId, results };
};
