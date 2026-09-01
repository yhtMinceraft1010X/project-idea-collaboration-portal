'use strict';

/**
 * Thin DynamoDB DocumentClient wrapper. Handlers use only these helpers for
 * data access, which keeps the SDK dependency isolated and makes unit tests
 * simple (tests mock this module rather than the AWS SDK internals).
 *
 * All tables use a generic `pk` / `sk` key schema; GSIs use domain attributes.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  BatchGetCommand,
} = require('@aws-sdk/lib-dynamodb');

const { REGION } = require('./config');

let _doc;
function doc() {
  if (!_doc) {
    const base = new DynamoDBClient({ region: REGION });
    _doc = DynamoDBDocumentClient.from(base, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return _doc;
}

async function put(tableName, item, opts = {}) {
  await doc().send(
    new PutCommand({
      TableName: tableName,
      Item: item,
      ...(opts.conditionExpression
        ? {
            ConditionExpression: opts.conditionExpression,
            ExpressionAttributeNames: opts.expressionAttributeNames,
            ExpressionAttributeValues: opts.expressionAttributeValues,
          }
        : {}),
    })
  );
  return item;
}

async function get(tableName, key) {
  const res = await doc().send(new GetCommand({ TableName: tableName, Key: key }));
  return res.Item || null;
}

async function update(tableName, key, params) {
  const res = await doc().send(
    new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: params.updateExpression,
      ExpressionAttributeNames: params.expressionAttributeNames,
      ExpressionAttributeValues: params.expressionAttributeValues,
      ConditionExpression: params.conditionExpression,
      ReturnValues: params.returnValues || 'ALL_NEW',
    })
  );
  return res.Attributes || null;
}

async function query(tableName, params) {
  const res = await doc().send(
    new QueryCommand({
      TableName: tableName,
      IndexName: params.indexName,
      KeyConditionExpression: params.keyConditionExpression,
      FilterExpression: params.filterExpression,
      ExpressionAttributeNames: params.expressionAttributeNames,
      ExpressionAttributeValues: params.expressionAttributeValues,
      ScanIndexForward: params.scanIndexForward,
      Limit: params.limit,
      ExclusiveStartKey: params.exclusiveStartKey,
    })
  );
  return { items: res.Items || [], lastKey: res.LastEvaluatedKey || null };
}

async function scan(tableName, params = {}) {
  const res = await doc().send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: params.filterExpression,
      ExpressionAttributeNames: params.expressionAttributeNames,
      ExpressionAttributeValues: params.expressionAttributeValues,
      Limit: params.limit,
      ExclusiveStartKey: params.exclusiveStartKey,
    })
  );
  return { items: res.Items || [], lastKey: res.LastEvaluatedKey || null };
}

async function remove(tableName, key) {
  await doc().send(new DeleteCommand({ TableName: tableName, Key: key }));
}

async function batchGet(tableName, keys) {
  if (!keys || keys.length === 0) return [];
  const res = await doc().send(
    new BatchGetCommand({ RequestItems: { [tableName]: { Keys: keys } } })
  );
  return (res.Responses && res.Responses[tableName]) || [];
}

module.exports = { put, get, update, query, scan, remove, batchGet };
