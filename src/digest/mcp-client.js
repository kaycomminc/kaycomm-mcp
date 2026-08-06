/**
 * Minimal MCP tool caller.
 *
 * Two modes:
 *   1. In process. Pass a resolver function that maps a tool name to your
 *      existing handler. Fastest and skips the network entirely.
 *   2. Over HTTP. Calls your Railway MCP endpoint with JSON-RPC 2.0.
 *
 * Mode 1 is preferred if this file lives inside kaycomm-mcp. Wire it up in
 * digest.js by passing { resolve: yourToolRegistry }.
 */

const DEFAULT_URL =
  process.env.KAYCOMM_MCP_URL ||
  'https://kaycomm-mcp-production.up.railway.app/mcp';

function createClient({ resolve = null, url = DEFAULT_URL, token = process.env.KAYCOMM_MCP_TOKEN } = {}) {
  let requestId = 0;

  async function callTool(name, args = {}) {
    // In process path.
    if (resolve) {
      const handler = resolve(name);
      if (!handler) throw new Error(`Unknown tool: ${name}`);
      return handler(args);
    }

    // HTTP path.
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++requestId,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });

    if (!res.ok) {
      throw new Error(`MCP ${name} failed: ${res.status} ${await res.text()}`);
    }

    const body = await res.json();
    if (body.error) throw new Error(`MCP ${name} error: ${body.error.message}`);

    // Tool results come back as content blocks. Pull the text and try JSON.
    const blocks = body.result?.content || [];
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** Retry wrapper. Google and Meta APIs blip more often than you would like. */
  async function callToolWithRetry(name, args = {}, attempts = 3) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        return await callTool(name, args);
      } catch (err) {
        lastErr = err;
        if (i < attempts - 1) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)));
        }
      }
    }
    throw lastErr;
  }

  return { callTool, callToolWithRetry };
}

module.exports = { createClient };
