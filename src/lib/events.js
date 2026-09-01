'use strict';

/** Amazon EventBridge helper for publishing domain events to the custom bus. */

const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge');
const { REGION, eventBus } = require('./config');

let _client;
function client() {
  if (!_client) _client = new EventBridgeClient({ region: REGION });
  return _client;
}

/**
 * Publish a single domain event.
 * @param {string} detailType e.g. 'initiative-registered'
 * @param {object} detail      structured payload
 * @param {string} [source]    event source, defaults to the app namespace
 */
async function publish(detailType, detail, source = 'digitalhub.portal') {
  await client().send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: eventBus,
          Source: source,
          DetailType: detailType,
          Detail: JSON.stringify(detail || {}),
        },
      ],
    })
  );
}

module.exports = { publish };
