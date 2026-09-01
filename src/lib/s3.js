'use strict';

/** Minimal Amazon S3 helper used for dashboard snapshot exports. */

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { REGION } = require('./config');

let _client;
function client() {
  if (!_client) _client = new S3Client({ region: REGION });
  return _client;
}

async function putObject(bucket, key, body, contentType = 'application/json') {
  await client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: typeof body === 'string' ? body : JSON.stringify(body),
      ContentType: contentType,
    })
  );
}

async function getObjectText(bucket, key) {
  const res = await client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return res.Body.transformToString();
}

module.exports = { putObject, getObjectText };
