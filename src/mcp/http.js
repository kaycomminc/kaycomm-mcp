const { timingSafeEqual } = require('node:crypto');
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
async function readJson(req, maxBytes = 10 * 1024 * 1024) {
  if (Number(req.headers?.['content-length']) > maxBytes) throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
  const chunks = []; let size = 0;
  // IncomingMessage's default iterator destroys the socket on early exit.
  // Keep it writable long enough to deliver the 413; the handler closes it.
  const stream = typeof req.iterator === 'function' ? req.iterator({ destroyOnReturn: false }) : req;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch (_) { throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }); }
}
function safeHttpHandler(handler) {
  return (req, res) => Promise.resolve().then(() => handler(req, res)).catch(error => {
    const status = error instanceof URIError ? 400 : error.statusCode || 500;
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'text/plain', 'Connection': 'close' });
    if (!res.writableEnded) res.end(status === 400 ? 'Invalid request' : status === 413 ? 'Request body too large' : 'Internal server error');
    // Avoid emitting URLs, body content, tokens, or provider payloads.
    if (status >= 500) console.error('[mcp-http] request failed', { code: error.code || 'INTERNAL_ERROR' });
  });
}
module.exports = { sameSecret, readJson, safeHttpHandler };
