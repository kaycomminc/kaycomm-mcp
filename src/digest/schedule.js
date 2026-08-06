/**
 * Cron registration. Call registerDigest() once from your server entry point.
 *
 *   const { registerDigest } = require('./src/digest/schedule');
 *   const { handleToolCall } = require('./server');
 *   registerDigest({ resolve: (name) => (args) => handleToolCall(name, args) });
 *
 * server.js has no tool registry object — it dispatches through the
 * handleToolCall(name, args) if/else chain, which it exports. Wrapping it as
 * above is the in process path and skips the HTTP round trip and the MCP token.
 * Omit `resolve` to go over HTTP instead.
 *
 * Requires: npm install node-cron
 */

const cron = require('node-cron');
const { CONFIG } = require('./config');
const { runDigest } = require('./digest');

let task = null;

function registerDigest({ resolve = null, schedule = CONFIG.schedule } = {}) {
  if (task) task.stop();

  task = cron.schedule(
    schedule,
    async () => {
      const started = Date.now();
      try {
        await runDigest({ resolve });
        console.log(`[digest] delivered in ${Date.now() - started}ms`);
      } catch (err) {
        console.error('[digest] run failed:', err);
      }
    },
    { timezone: CONFIG.timezone }
  );

  console.log(`[digest] scheduled "${schedule}" (${CONFIG.timezone})`);
  return task;
}

/**
 * Optional manual trigger route. Handy for testing without waiting for 7am.
 * Protect it with a token so it is not open to the world.
 *
 *   app.post('/digest/run', digestRoute());
 */
function digestRoute({ resolve = null, token = process.env.DIGEST_TRIGGER_TOKEN } = {}) {
  return async (req, res) => {
    // Fails closed. An unset token must not mean "no auth required" — this
    // endpoint spends money (Anthropic call) and sends mail, so an open one is
    // a stranger's button. Same posture as MCP_AUTH_TOKEN on /sse.
    if (!token) {
      return res.status(503).json({ error: 'DIGEST_TRIGGER_TOKEN not configured' });
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      const result = await runDigest({
        resolve,
        dryRun: req.query.dry === '1',
      });
      res.json({ ok: true, subject: result.subject, text: result.text });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  };
}

/**
 * The same trigger for a raw node http server. server.js is not Express, so
 * digestRoute()'s req/res shape does not apply there.
 * Returns true if it handled the request.
 */
async function handleDigestRequest(req, res, url, { resolve = null, token = process.env.DIGEST_TRIGGER_TOKEN } = {}) {
  if (url.pathname !== '/digest/run') return false;

  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method !== 'POST') return send(405, { error: 'POST only' }), true;
  if (!token) return send(503, { error: 'DIGEST_TRIGGER_TOKEN not configured' }), true;

  const bearer = `Bearer ${token}`;
  const authed =
    req.headers.authorization === bearer || url.searchParams.get('token') === token;
  if (!authed) return send(401, { error: 'unauthorized' }), true;

  try {
    const result = await runDigest({ resolve, dryRun: url.searchParams.get('dry') === '1' });
    send(200, { ok: true, subject: result.subject, text: result.text, delivery: result.delivery ?? null });
  } catch (err) {
    send(500, { ok: false, error: err.message });
  }
  return true;
}

module.exports = { registerDigest, digestRoute, handleDigestRequest };
