'use strict';

/**
 * Central configuration for the Digital Hub Knowledge & Collaboration Platform.
 *
 * Every AWS resource in this application is named with the platform-mandated
 * prefix (see CLAUDE.md). Resource names are derived from this prefix so that
 * handler code, tests, and the deploy scripts all agree on a single source of
 * truth. Where the SAM template injects an explicit name via an environment
 * variable, that value takes precedence.
 */

const PREFIX = 'app-193a359c-027ffd1c-';
const REGION = process.env.AWS_REGION || 'ap-southeast-1';

// The six core entity types. Order matters for cross-entity search fan-out.
const ENTITY_TYPES = [
  'problems',
  'initiatives',
  'solutions',
  'findings',
  'assets',
  'sme-profiles',
];

// Singular uppercase key namespace used for DynamoDB partition keys, e.g.
// PROBLEM#<id>. Keyed by the plural entity type.
const ENTITY_KIND = {
  problems: 'PROBLEM',
  initiatives: 'INITIATIVE',
  solutions: 'SOLUTION',
  findings: 'FINDING',
  assets: 'ASSET',
  'sme-profiles': 'SME',
};

const name = (suffix) => `${PREFIX}${suffix}`;

// Bedrock model ids. Claude models MUST use the `global.` cross-region
// inference profile; Cohere Embed is invoked with its bare, region-local id.
const MODELS = {
  embed: process.env.EMBED_MODEL_ID || 'cohere.embed-multilingual-v3',
  chat: process.env.CHAT_MODEL_ID || 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  chatHighQuality: process.env.CHAT_MODEL_ID_HQ || 'global.anthropic.claude-sonnet-5',
  embedDimension: 1024,
};

// One S3 Vectors index per entity type, all inside a single vector bucket.
const VECTOR_BUCKET = process.env.VECTOR_BUCKET || name('vectors');
const vectorIndexFor = (entityType) => entityType; // index name == entity type

// Table names: prefer an explicitly injected name, else derive from prefix.
const tableName = (envVar, suffix) => process.env[envVar] || name(suffix);

const config = {
  PREFIX,
  REGION,
  ENTITY_TYPES,
  ENTITY_KIND,
  MODELS,
  VECTOR_BUCKET,
  vectorIndexFor,
  name,

  // Per-invocation identity injected by the SAM template.
  ENTITY: process.env.ENTITY || null, // for the generic CRUD handler
  TABLE_NAME: process.env.TABLE_NAME || null, // for the generic CRUD handler

  tables: {
    problems: tableName('TABLE_PROBLEMS', 'problems'),
    initiatives: tableName('TABLE_INITIATIVES', 'initiatives'),
    solutions: tableName('TABLE_SOLUTIONS', 'solutions'),
    findings: tableName('TABLE_FINDINGS', 'findings'),
    assets: tableName('TABLE_ASSETS', 'assets'),
    'sme-profiles': tableName('TABLE_SME_PROFILES', 'sme-profiles'),
    relationships: tableName('TABLE_RELATIONSHIPS', 'relationships'),
    auditLog: tableName('TABLE_AUDIT_LOG', 'audit-log'),
    reviewQueue: tableName('TABLE_REVIEW_QUEUE', 'review-queue'),
    analyticsSnapshot: tableName('TABLE_ANALYTICS_SNAPSHOT', 'analytics-snapshot'),
    overlapResults: tableName('TABLE_OVERLAP_RESULTS', 'overlap-results'),
  },

  buckets: {
    spaAssets: process.env.BUCKET_SPA_ASSETS || name('spa-assets'),
    ingestionStaging: process.env.BUCKET_INGESTION_STAGING || name('ingestion-staging'),
    assets: process.env.BUCKET_ASSETS || name('assets'),
    dashboardSnapshots: process.env.BUCKET_DASHBOARD_SNAPSHOTS || name('dashboard-snapshots'),
  },

  queues: {
    reviewUrl: process.env.QUEUE_REVIEW_URL || null,
    ingestionJiraUrl: process.env.QUEUE_INGESTION_JIRA_URL || null,
    ingestionConfluenceUrl: process.env.QUEUE_INGESTION_CONFLUENCE_URL || null,
    ingestionGithubUrl: process.env.QUEUE_INGESTION_GITHUB_URL || null,
    notificationsUrl: process.env.QUEUE_NOTIFICATIONS_URL || null,
  },

  topics: {
    overlapNotifyArn: process.env.TOPIC_OVERLAP_NOTIFY_ARN || null,
    smeRoutingArn: process.env.TOPIC_SME_ROUTING_ARN || null,
    opsAlertsArn: process.env.TOPIC_OPS_ALERTS_ARN || null,
  },

  eventBus: process.env.EVENT_BUS_NAME || name('bus-events'),

  secrets: {
    jira: process.env.SECRET_JIRA || name('secret-jira'),
    confluence: process.env.SECRET_CONFLUENCE || name('secret-confluence'),
    github: process.env.SECRET_GITHUB || name('secret-github'),
    slackBot: process.env.SECRET_SLACK_BOT || name('secret-slack-bot'),
    teamsWebhook: process.env.SECRET_TEAMS_WEBHOOK || name('secret-teams-webhook'),
  },

  params: {
    overlapThreshold: process.env.PARAM_OVERLAP_THRESHOLD || `/${PREFIX.replace(/-$/, '')}/overlap-threshold`,
    syncSchedule: process.env.PARAM_SYNC_SCHEDULE || `/${PREFIX.replace(/-$/, '')}/sync-schedule`,
    featureFlags: process.env.PARAM_FEATURE_FLAGS || `/${PREFIX.replace(/-$/, '')}/feature-flags`,
  },

  // Tunables (overridable at runtime via SSM in the handlers that need them).
  defaults: {
    overlapThreshold: Number(process.env.OVERLAP_THRESHOLD || 0.75),
    searchTopK: Number(process.env.SEARCH_TOP_K || 10),
    smeMaxMatches: 3,
    smeMinMatches: 1,
  },
};

module.exports = config;
