'use strict';

/**
 * Portfolio dashboard (Requirement 8).
 *   EventBridge weekly schedule -> aggregate stats -> analytics-snapshot table
 *      + dashboard-snapshots S3 bucket.
 *   GET /dashboard/portfolio -> latest snapshot (Portfolio/Mgmt/Ops group).
 *
 * Snapshot shape: { themes, overlapHotspots, reuseRate, gaps }.
 */

const dynamo = require('../lib/dynamo');
const s3 = require('../lib/s3');
const audit = require('../lib/audit');
const logger = require('../lib/logger');
const res = require('../lib/response');
const { tables, buckets } = require('../lib/config');
const { isoWeek, nowIso } = require('../lib/ids');

const snapshotKey = (week) => ({ pk: `SNAPSHOT#${week}`, sk: 'METADATA' });

function tally(items, extract) {
  const counts = {};
  for (const item of items) {
    for (const value of extract(item)) {
      if (!value) continue;
      counts[value] = (counts[value] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

async function aggregate() {
  const [initiatives, problems, solutions, overlaps] = await Promise.all([
    dynamo.scan(tables.initiatives, { limit: 500 }),
    dynamo.scan(tables.problems, { limit: 500 }),
    dynamo.scan(tables.solutions, { limit: 500 }),
    dynamo.scan(tables.overlapResults, { limit: 500 }),
  ]);

  const initiativeItems = initiatives.items.filter((i) => i.sk === 'METADATA');
  const problemItems = problems.items.filter((i) => i.sk === 'METADATA');
  const solutionItems = solutions.items.filter((i) => i.sk === 'METADATA');

  // Themes: most common tags/techStack across initiatives.
  const themes = tally(initiativeItems, (i) => [
    ...(Array.isArray(i.tags) ? i.tags : []),
    i.techStack,
  ]).slice(0, 10);

  // Overlap hotspots: initiatives with the most Strong/Partial overlaps.
  const hotspotCounts = {};
  for (const o of overlaps.items) {
    if (o.classification === 'Strong' || o.classification === 'Partial') {
      hotspotCounts[o.initiativeId] = (hotspotCounts[o.initiativeId] || 0) + 1;
    }
  }
  const overlapHotspots = Object.entries(hotspotCounts)
    .map(([initiativeId, count]) => ({ initiativeId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Reuse rate: fraction of initiatives that cite prior work (linkedProblemId
  // or a solution referencing them), approximated for the MVP.
  const citing = initiativeItems.filter((i) => i.linkedProblemId).length;
  const reuseRate = initiativeItems.length
    ? Number((citing / initiativeItems.length).toFixed(2))
    : 0;

  // Gaps: problem statuses still open with no linked initiative.
  const linkedProblemIds = new Set(initiativeItems.map((i) => i.linkedProblemId).filter(Boolean));
  const gaps = problemItems
    .filter((p) => (p.status === 'open' || p.status === 'in-progress') && !linkedProblemIds.has(p.entityId))
    .slice(0, 10)
    .map((p) => ({ problemId: p.entityId, title: p.title, status: p.status }));

  return {
    themes,
    overlapHotspots,
    reuseRate,
    gaps,
    totals: {
      initiatives: initiativeItems.length,
      problems: problemItems.length,
      solutions: solutionItems.length,
    },
    generatedAt: nowIso(),
  };
}

async function persistSnapshot() {
  const week = isoWeek();
  const snapshot = await aggregate();
  const item = { ...snapshotKey(week), week, ...snapshot };
  await dynamo.put(tables.analyticsSnapshot, item);
  await s3
    .putObject(buckets.dashboardSnapshots, `snapshots/${week}.json`, item)
    .catch((err) => logger.warn('snapshot S3 export failed', { error: err.message }));
  await audit.record({
    actorId: 'system:dashboard',
    action: 'snapshot',
    entityRef: `SNAPSHOT#${week}`,
    details: { totals: snapshot.totals },
  });
  return item;
}

exports.handler = async (event) => {
  // Scheduled aggregation
  if (event && (event.trigger === 'schedule' || event.source === 'aws.events')) {
    const item = await persistSnapshot();
    logger.info('weekly snapshot written', { week: item.week });
    return { week: item.week, totals: item.totals };
  }

  // API GET /dashboard/portfolio
  const claims = res.getClaims(event);
  if (!res.hasGroup(claims, ['Portfolio', 'Mgmt', 'Ops'])) {
    return res.forbidden('Portfolio or Mgmt group required');
  }

  try {
    const week = isoWeek();
    let snapshot = await dynamo.get(tables.analyticsSnapshot, snapshotKey(week));
    if (!snapshot) {
      // Compute (and persist) on demand if this week's snapshot is missing.
      snapshot = await persistSnapshot();
    }
    return res.ok(snapshot);
  } catch (err) {
    logger.error('dashboard handler error', { error: err.message, stack: err.stack });
    return res.serverError(err.message);
  }
};

exports._internal = { aggregate };
