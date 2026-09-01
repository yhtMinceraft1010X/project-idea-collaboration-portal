'use strict';

/**
 * Amazon Bedrock helpers. Two operations are used across the platform:
 *   - embed(): Cohere Embed Multilingual v3 (1024-dim) for semantic indexing
 *              and search. Invoked with its bare, region-local model id.
 *   - chat():  Claude Haiku 4.5 (default) or Sonnet 5 for classification and
 *              re-ranking. MUST use the `global.` cross-region inference
 *              profile id (enforced in config).
 */

const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require('@aws-sdk/client-bedrock-runtime');

const { REGION, MODELS } = require('./config');

let _client;
function client() {
  if (!_client) _client = new BedrockRuntimeClient({ region: REGION });
  return _client;
}

async function invoke(modelId, body) {
  const res = await client().send(
    new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    })
  );
  const text = Buffer.from(res.body).toString('utf8');
  return JSON.parse(text);
}

/**
 * Embed one or more texts. `inputType` should be 'search_document' when
 * indexing content and 'search_query' when embedding a query, per Cohere's
 * asymmetric embedding guidance.
 * @returns {Promise<number[][]>} one embedding vector per input text
 */
async function embedMany(texts, inputType = 'search_document') {
  const body = {
    texts: texts.map((t) => String(t || '').slice(0, 2048)),
    input_type: inputType,
    truncate: 'END',
  };
  const out = await invoke(MODELS.embed, body);
  // Cohere on Bedrock returns { embeddings: [[...]] } by default, or
  // { embeddings: { float: [[...]] } } when embedding_types is requested.
  const embeddings = Array.isArray(out.embeddings)
    ? out.embeddings
    : (out.embeddings && out.embeddings.float) || [];
  return embeddings;
}

/** Embed a single text and return its vector. */
async function embed(text, inputType = 'search_document') {
  const [vector] = await embedMany([text], inputType);
  return vector || [];
}

/**
 * Send a chat/classification prompt to Claude via the Bedrock Messages API.
 * @param {string} prompt
 * @param {object} [opts] { system, maxTokens, highQuality }
 * @returns {Promise<string>} the assistant's text output
 */
async function chat(prompt, opts = {}) {
  const modelId = opts.highQuality ? MODELS.chatHighQuality : MODELS.chat;
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: opts.maxTokens || 512,
    temperature: opts.temperature != null ? opts.temperature : 0,
    ...(opts.system ? { system: opts.system } : {}),
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  };
  const out = await invoke(modelId, body);
  if (Array.isArray(out.content)) {
    return out.content.map((c) => c.text || '').join('').trim();
  }
  return '';
}

module.exports = { embed, embedMany, chat, invoke };
