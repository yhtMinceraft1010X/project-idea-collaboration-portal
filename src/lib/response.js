'use strict';

/**
 * API Gateway (proxy integration) response helpers. All app responses are JSON
 * and carry permissive CORS headers so the CloudFront-hosted SPA can call the
 * API. Auth is enforced by the Cognito authorizer, not by CORS.
 */

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

const ok = (body) => json(200, body);
const created = (body) => json(201, body);
const accepted = (body) => json(202, body);
const badRequest = (message, extra) => json(400, { error: message, ...(extra || {}) });
const forbidden = (message) => json(403, { error: message || 'Forbidden' });
const notFound = (message) => json(404, { error: message || 'Not found' });
const serverError = (message) => json(500, { error: message || 'Internal server error' });

/** Parse a JSON body from an API Gateway proxy event; tolerant of base64. */
function parseBody(event) {
  if (!event || !event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

/**
 * Extract the caller's identity and Cognito groups from the API Gateway
 * authorizer claims. Groups drive role-based authorization (Requirement 9).
 */
function getClaims(event) {
  const claims =
    (event &&
      event.requestContext &&
      event.requestContext.authorizer &&
      (event.requestContext.authorizer.claims ||
        (event.requestContext.authorizer.jwt &&
          event.requestContext.authorizer.jwt.claims))) ||
    {};
  const rawGroups = claims['cognito:groups'];
  let groups = [];
  if (Array.isArray(rawGroups)) groups = rawGroups;
  else if (typeof rawGroups === 'string' && rawGroups.length) {
    groups = rawGroups.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
  }
  return {
    userId: claims.sub || claims['cognito:username'] || 'anonymous',
    email: claims.email || null,
    username: claims['cognito:username'] || null,
    groups,
  };
}

/** True if the caller belongs to at least one of the required groups. */
function hasGroup(claims, required) {
  if (!required || required.length === 0) return true;
  const groups = (claims && claims.groups) || [];
  return required.some((g) => groups.includes(g));
}

module.exports = {
  CORS_HEADERS,
  json,
  ok,
  created,
  accepted,
  badRequest,
  forbidden,
  notFound,
  serverError,
  parseBody,
  getClaims,
  hasGroup,
};
