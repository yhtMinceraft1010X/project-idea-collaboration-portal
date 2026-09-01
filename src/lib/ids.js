'use strict';

const { randomUUID, createHash } = require('crypto');

/** Generate a random entity id (uuid v4). */
function newId() {
  return randomUUID();
}

/** ISO-8601 timestamp for record metadata. */
function nowIso() {
  return new Date().toISOString();
}

/** Epoch milliseconds, used as the sortable component of audit-log sort keys. */
function nowEpochMs() {
  return Date.now();
}

/** ISO week string, e.g. 2026-W05 - used as the analytics snapshot key. */
function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** yyyy-mm-dd (UTC) partition key for the audit-log table. */
function dateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * Deterministic idempotency key derived from a source system and its native id.
 * Used so a webhook/poll re-delivery overwrites rather than duplicates.
 */
function deterministicId(...parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

module.exports = { newId, nowIso, nowEpochMs, isoWeek, dateKey, deterministicId };
