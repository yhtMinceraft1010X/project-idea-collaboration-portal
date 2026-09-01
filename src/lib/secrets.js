'use strict';

/**
 * AWS Secrets Manager helper with a simple in-memory cache (secrets are read
 * far more often than they rotate, and Lambda containers are reused).
 */

const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager');
const { REGION } = require('./config');

let _client;
function client() {
  if (!_client) _client = new SecretsManagerClient({ region: REGION });
  return _client;
}

const cache = new Map();

/**
 * Fetch a secret value. Returns the parsed JSON object when the secret is JSON,
 * otherwise the raw string. Returns null when the secret does not exist so
 * callers (e.g. the notifier with placeholder credentials) can degrade
 * gracefully instead of failing the pipeline.
 */
async function getSecret(secretId, { useCache = true } = {}) {
  if (useCache && cache.has(secretId)) return cache.get(secretId);
  try {
    const res = await client().send(new GetSecretValueCommand({ SecretId: secretId }));
    const raw = res.SecretString || '';
    let value;
    try {
      value = JSON.parse(raw);
    } catch (e) {
      value = raw;
    }
    cache.set(secretId, value);
    return value;
  } catch (err) {
    if (err && (err.name === 'ResourceNotFoundException' || err.$metadata?.httpStatusCode === 404)) {
      return null;
    }
    throw err;
  }
}

/** Clear the cache - used by tests. */
function _clearCache() {
  cache.clear();
}

module.exports = { getSecret, _clearCache };
