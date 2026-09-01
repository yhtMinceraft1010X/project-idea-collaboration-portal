'use strict';

/** AWS Systems Manager Parameter Store helper with caching and safe defaults. */

const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { REGION } = require('./config');

let _client;
function client() {
  if (!_client) _client = new SSMClient({ region: REGION });
  return _client;
}

const cache = new Map();

/** Fetch a parameter value, falling back to `fallback` when unset/missing. */
async function getParam(name, fallback = null) {
  if (cache.has(name)) return cache.get(name);
  try {
    const res = await client().send(new GetParameterCommand({ Name: name }));
    const value = res.Parameter ? res.Parameter.Value : fallback;
    cache.set(name, value);
    return value;
  } catch (err) {
    return fallback;
  }
}

async function getNumber(name, fallback) {
  const v = await getParam(name, null);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _clearCache() {
  cache.clear();
}

module.exports = { getParam, getNumber, _clearCache };
