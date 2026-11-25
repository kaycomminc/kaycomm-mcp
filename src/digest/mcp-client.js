/**
 * Minimal MCP tool caller.
 *
 * Two modes:
 *   1. In process. Pass a resolver function that maps a tool name to your
 *      existing handler. Fastest and skips the network entirely.
 *   2. Over HTTP. Uses the server's authenticated SSE transport and the MCP SDK.
 *
 * Mode 1 is preferred if this file lives inside kaycomm-mcp. Wire it up in
 * digest.js by passing { resolve: yourToolRegistry }.
 */

const DEFAULT_URL =
  process.env.KAYCOMM_MCP_URL ||
  'https://kaycomm-mcp-production.up.railway.app/mcp';

const DEFAULT_TIMEOUT_MS = 30000;

function unwrapResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (result.structuredContent) {
    return { ...result.structuredContent, _isError: result.isError === true };
  }
  const text = (result.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  if (!text) return result;
  try {
    const parsed = JSON.parse(text);
    return { ...parsed, _isError: result.isError === true };
  } catch {
    return { error: text, _isError: result.isError === true };
  }
}

function retryableResult(result) {
  if (!result || typeof result !== 'object') return false;
  const errors = result._meta?.errors || [];
  if (result._isError && errors.length) return errors.every(error => error.retryable === true);
  return result._meta?.status === 'error' && errors.length > 0 && errors.every(error => error.retryable === true);
}

function retryableTransportError(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.name === 'TypeError') return true;
  const status = Number(error?.code);
  return status === 429 || status >= 500;
}

function createClient({ resolve = null, url = DEFAULT_URL, token = process.env.KAYCOMM_MCP_TOKEN,
  timeoutMs = DEFAULT_TIMEOUT_MS, fetchFn = global.fetch, delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms)) } = {}) {
  let remoteClient = null;
  let remoteTransport = null;

  async function callTool(name, args = {}) {
    // In process path.
    if (resolve) {
      const handler = resolve(name);
      if (!handler) throw new Error(`Unknown tool: ${name}`);
      return unwrapResult(await handler(args));
    }

    if (!remoteClient) {
      const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
      const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
      remoteClient = new Client({ name: 'kaycomm-digest', version: '1.0.0' }, { capabilities: {} });
      const endpoint = new URL(url);
      if (endpoint.pathname === '/mcp') endpoint.pathname = '/sse';
      remoteTransport = new SSEClientTransport(endpoint, {
        requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
        fetch: (input, init = {}) => {
          const timeout = AbortSignal.timeout(timeoutMs);
          const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
          return fetchFn(input, { ...init, signal });
        },
        eventSourceInit: { fetch: (input, init = {}) => {
          const timeout = AbortSignal.timeout(timeoutMs);
          const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
          return fetchFn(input, { ...init, signal });
        } },
      });
      await remoteClient.connect(remoteTransport);
    }
    return unwrapResult(await remoteClient.callTool({ name, arguments: args }));
  }

  /** Retry wrapper. Google and Meta APIs blip more often than you would like. */
  async function callToolWithRetry(name, args = {}, attempts = 3) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        const result = await callTool(name, args);
        if (!retryableResult(result) || i >= attempts - 1) return result;
        lastErr = new Error(result._meta?.errors?.map(error => error.message).join('; ') || result.error || `${name} failed`);
      } catch (err) {
        lastErr = err;
        if (!retryableTransportError(err) || i >= attempts - 1) throw err;
      }
      if (i < attempts - 1) await delay(1000 * Math.pow(2, i));
    }
    throw lastErr;
  }

  async function close() {
    if (remoteClient) await remoteClient.close();
    remoteClient = null;
    remoteTransport = null;
  }

  return { callTool, callToolWithRetry, close };
}

module.exports = { createClient, unwrapResult, retryableResult, retryableTransportError };
