const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { createClient } = require('../src/digest/mcp-client');

test('digest HTTP client uses authenticated SSE with a local MCP server', async () => {
  const payload = { date: '2026-11-24', google: [], meta: [], _meta: { status: 'success' } };
  const transports = new Map();
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/sse') {
      assert.equal(req.headers.authorization, 'Bearer fixture-token');
      const transport = new SSEServerTransport('/messages', res);
      transports.set(transport.sessionId, transport);
      res.on('close', () => transports.delete(transport.sessionId));
      const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload,
      }));
      await server.connect(transport);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const transport = transports.get(url.searchParams.get('sessionId'));
      assert.ok(transport);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return transport.handlePostMessage(req, res, JSON.parse(Buffer.concat(chunks).toString()));
    }
    res.writeHead(404).end();
  });
  httpServer.listen(0, '127.0.0.1');
  await new Promise(resolve => httpServer.once('listening', resolve));

  const client = createClient({ url: `http://127.0.0.1:${httpServer.address().port}/mcp`, token: 'fixture-token' });
  try {
    const result = await client.callToolWithRetry('get_full_pacing', {});
    assert.equal(result.date, payload.date);
    assert.deepEqual(result.google, []);
    assert.equal(result._meta.status, 'success');
  } finally {
    await client.close();
    httpServer.closeAllConnections();
    await new Promise(resolve => httpServer.close(resolve));
  }
});

test('digest retries retryable MCP errors and returns permanent or partial errors directly', async () => {
  let calls = 0;
  const delay = async () => {};
  const retrying = createClient({
    resolve: () => async () => {
      calls++;
      return calls === 1
        ? { error: 'temporary', _meta: { status: 'error', errors: [{ message: 'temporary', retryable: true }] } }
        : { google: [], meta: [], _meta: { status: 'success' } };
    },
    delay,
  });
  assert.equal((await retrying.callToolWithRetry('get_full_pacing'))._meta.status, 'success');
  assert.equal(calls, 2);

  calls = 0;
  const permanent = createClient({
    resolve: () => async () => {
      calls++;
      return { error: 'bad arguments', _meta: { status: 'error', errors: [{ message: 'bad arguments', retryable: false }] } };
    },
    delay,
  });
  assert.equal((await permanent.callToolWithRetry('get_full_pacing')).error, 'bad arguments');
  assert.equal(calls, 1);

  calls = 0;
  const partial = createClient({
    resolve: () => async () => {
      calls++;
      return { google: [], meta: [], _meta: { status: 'partial_success', errors: [{ message: 'partial', retryable: true }] } };
    },
    delay,
  });
  assert.equal((await partial.callToolWithRetry('get_full_pacing'))._meta.status, 'partial_success');
  assert.equal(calls, 1);
});
