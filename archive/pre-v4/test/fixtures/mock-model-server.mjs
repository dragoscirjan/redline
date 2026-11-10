/**
 * Minimal OpenAI-compatible mock model server for harness integration
 * tests. Answers GET /v1/models and POST /v1/chat/completions (streaming
 * and non-streaming).
 *
 * The default response is a valid per-file clean review whose `fileId` is
 * extracted from the request body (the review prompt embeds the file id as
 * machine-readable JSON). Override with MOCK_RESPONSE_TEXT for a fixed
 * response.
 *
 * Usage: node test/fixtures/mock-model-server.mjs <port>
 * The chosen port is printed as JSON on stdout once listening.
 */

import http from 'node:http';

const port = Number(process.argv[2] ?? 0);
const FIXED_REPLY = process.env.MOCK_RESPONSE_TEXT ?? null;
// The file id appears inside the prompt text, which is itself JSON-escaped
// in the request body (\"fileId\":\"000001\"), so both forms are matched.
const FILE_ID_PATTERN = /\\?"fileId\\?"\s*:\s*\\?"(\d{6})\\?"/u;

function replyFor(body) {
  if (FIXED_REPLY !== null) return FIXED_REPLY;
  const match = FILE_ID_PATTERN.exec(body);
  const fileId = match === null ? '000000' : match[1];
  return process.env.MOCK_EXPECT_REVIEW_PROTOCOL === '1'
    ? JSON.stringify({ version: 4, fileId, outcome: 'clean', reason: 'No supported defects.', contextRequests: [], findings: [] })
    : JSON.stringify({ version: 2, fileId, outcome: 'clean', findings: [] });
}

function chunkString(value, size) {
  const chunks = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks.length > 0 ? chunks : [''];
}

const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    // Test-only expectation: never print supplied header values, even on failure.
    const expectedAuth = process.env.MOCK_EXPECT_AUTHORIZATION;
    const actualAuth = request.headers.authorization;
    const matchesAuth = expectedAuth === 'credential-less' ? actualAuth === undefined || actualAuth === 'Bearer redline-unauthenticated'
      : expectedAuth === 'absent' ? actualAuth === undefined : actualAuth === expectedAuth;
    if (expectedAuth !== undefined && !matchesAuth) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 401, message: actualAuth === undefined
        ? 'Missing Authentication header' : 'Incorrect Authentication header' } }));
      return;
    }
    if ((request.url ?? '').includes('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model' }] }));
      return;
    }
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      // fall through with defaults
    }
    const expectedTokens = process.env.MOCK_EXPECT_MAX_OUTPUT_TOKENS;
    if (expectedTokens !== undefined && (parsed.max_completion_tokens ?? parsed.max_tokens) !== Number(expectedTokens)) {
      process.stderr.write(`output-token cap mismatch: expected ${Number(expectedTokens)}, received ${Number(parsed.max_completion_tokens ?? parsed.max_tokens)}\n`);
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'unexpected output-token limit', type: 'invalid_request_error' } }));
      return;
    }
    if (process.env.MOCK_EXPECT_REVIEW_PROTOCOL === '1') {
      const format = parsed.response_format;
      if (parsed.reasoning !== undefined || parsed.reasoning_effort !== undefined || parsed.thinking !== undefined) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 400, message: 'Reasoning is mandatory for this endpoint and cannot be disabled.' } }));
        return;
      }
      if (parsed.provider?.require_parameters !== true
        || format?.type !== 'json_schema' || format.json_schema?.strict !== true
        || format.json_schema?.schema?.properties?.version?.const !== 4
        || !format.json_schema?.schema?.required?.includes('contextRequests')
        || format.json_schema?.schema?.additionalProperties !== false
        || (parsed.tools?.length ?? 0) !== 0) {
        process.stderr.write('review protocol request fields missing or incorrect\n');
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'unexpected review request protocol', type: 'invalid_request_error' } }));
        return;
      }
    }
    const reply = replyFor(body);
    if (parsed.stream === true) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const delta of chunkString(reply, 32)) {
        response.write(
          `data: ${JSON.stringify({
            id: 'cmpl-mock',
            object: 'chat.completion.chunk',
            model: 'test-model',
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          })}\n\n`,
        );
      }
      response.write(
        `data: ${JSON.stringify({
          id: 'cmpl-mock',
          object: 'chat.completion.chunk',
          model: 'test-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
      );
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'cmpl-mock',
        object: 'chat.completion',
        model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});
