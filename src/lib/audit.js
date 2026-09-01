'use strict';

/**
 * Append-only audit trail writer (Requirements 1.4, 6.3, 7.4, 10).
 *
 * For this MVP the audit trail is written directly to the audit-log DynamoDB
 * table via a single-purpose helper rather than a separate audit-logger
 * function. Every calling role is scoped to `dynamodb:PutItem` on the audit-log
 * table only, preserving least privilege. Records are keyed by day so the table
 * spreads write load and supports date-range queries; a 2-year TTL satisfies
 * the retention requirement.
 */

const dynamo = require('./dynamo');
const { tables } = require('./config');
const { dateKey, nowEpochMs, nowIso, newId } = require('./ids');

const TWO_YEARS_SECONDS = 2 * 365 * 24 * 60 * 60;

/**
 * @param {object} p
 * @param {string} p.actorId    - user id or system principal responsible
 * @param {string} p.action     - e.g. 'create', 'approve', 'route', 'search'
 * @param {string} [p.entityRef]- e.g. 'INITIATIVE#abc'
 * @param {object} [p.details]  - free-form structured context
 */
async function record({ actorId, action, entityRef, details }) {
  const eventId = newId();
  const epoch = nowEpochMs();
  const item = {
    pk: `AUDIT#${dateKey()}`,
    sk: `${epoch}#${eventId}`,
    eventId,
    actorId: actorId || 'system',
    action,
    entityRef: entityRef || null,
    details: details || {},
    createdAt: nowIso(),
    ttl: Math.floor(epoch / 1000) + TWO_YEARS_SECONDS,
  };
  await dynamo.put(tables.auditLog, item);
  return item;
}

module.exports = { record };
