'use strict';

/**
 * Minimal structured JSON logger. Emitting JSON to stdout lets CloudWatch Logs
 * Insights query fields directly, and keeps the audit/observability story
 * (Requirement 10) consistent across every function.
 */

function emit(level, message, fields) {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(fields || {}),
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

module.exports = {
  info: (message, fields) => emit('INFO', message, fields),
  warn: (message, fields) => emit('WARN', message, fields),
  error: (message, fields) => emit('ERROR', message, fields),
  debug: (message, fields) => {
    if (process.env.LOG_LEVEL === 'DEBUG') emit('DEBUG', message, fields);
  },
};
