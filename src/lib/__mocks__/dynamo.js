'use strict';

// Manual Jest mock: replaces the DynamoDB wrapper so tests never load the SDK.
module.exports = {
  put: jest.fn(),
  get: jest.fn(),
  update: jest.fn(),
  query: jest.fn(),
  scan: jest.fn(),
  remove: jest.fn(),
  batchGet: jest.fn(),
};
