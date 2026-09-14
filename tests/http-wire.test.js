const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { readJson, safeHttpHandler } = require('../src/mcp/http');

test('chunked oversized HTTP request receives 413 before its socket closes', async () => {
  const server = http.createServer(safeHttpHandler(async (req, res) => {
    await readJson(req, 8);
    res.end('unexpected success');
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
        res.on('error', reject);
      });
      req.setTimeout(2000, () => req.destroy(new Error('HTTP regression test timed out')));
      req.on('error', reject);
      req.write('123456789');
      req.end('more');
    });
    assert.equal(result.status, 413);
    assert.equal(result.body, 'Request body too large');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
