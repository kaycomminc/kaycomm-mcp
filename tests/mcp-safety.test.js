const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const {
  decorateTool,
  validateArgs,
  uniqueName,
  writeIdentity,
  annotateResult,
} = require('../src/mcp/contracts.js');
const { FileWriteStore } = require('../src/mcp/write-guard.js');
const { sameSecret, readJson, safeHttpHandler } = require('../src/mcp/http.js');

function assertInvalidArguments(fn) {
  assert.throws(fn, error => error && error.code === 'INVALID_ARGUMENT');
}

function assertInvalidDateRange(fn) {
  assert.throws(fn, error => error && error.code === 'INVALID_DATE_RANGE');
}

function requestFrom(chunks, headers = {}) {
  return {
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

test('write schemas keep confirm strict, allow optional false, and reject unknown properties', () => {
  const tool = decorateTool({
    name: 'write_budget',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean' },
        account_name: { type: 'string' },
        nested: { type: 'object', properties: { known: { type: 'string' } } },
      },
    },
  });

  assert.doesNotThrow(() => validateArgs(tool, {}));
  assert.doesNotThrow(() => validateArgs(tool, { confirm: false }));
  assert.doesNotThrow(() => validateArgs(tool, { confirm: false, idempotency_key: 'request-1' }));
  for (const confirm of ['false', 1, null]) {
    assertInvalidArguments(() => validateArgs(tool, { confirm }));
  }
  assertInvalidArguments(() => validateArgs(tool, { unknown: true }));
  assertInvalidArguments(() => validateArgs(tool, { nested: { unknown: true } }));
});

test('selectors reject empty names, and uniqueName rejects empty and ambiguous matches', () => {
  const tool = decorateTool({
    name: 'read_accounts',
    inputSchema: { type: 'object', properties: { account_name: { type: 'string' } } },
  });
  assertInvalidArguments(() => validateArgs(tool, { account_name: '   ' }));
  assert.throws(() => uniqueName([{ name: 'Alpha', id: '1' }], '  '), error => error.code === 'INVALID_ARGUMENT');
  assert.throws(
    () => uniqueName([{ name: 'Alpha', id: '1' }, { name: 'Alpha Beta', id: '2' }], 'a'),
    error => error.code === 'AMBIGUOUS_TARGET',
  );
});

test('date validation rejects impossible, inverted, and mismatched custom ranges', () => {
  const tool = decorateTool({
    name: 'date_report',
    inputSchema: {
      type: 'object',
      properties: {
        date_range: { type: 'string' },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
      },
    },
  });

  assertInvalidDateRange(() => validateArgs(tool, {
    date_range: 'CUSTOM', start_date: '2025-02-29', end_date: '2025-03-01',
  }));
  assertInvalidDateRange(() => validateArgs(tool, {
    date_range: 'CUSTOM', start_date: '2025-04-02', end_date: '2025-04-01',
  }));
  assertInvalidDateRange(() => validateArgs(tool, {
    date_range: 'LAST_7_DAYS', start_date: '2025-04-01', end_date: '2025-04-02',
  }));
  assert.doesNotThrow(() => validateArgs(tool, {
    date_range: 'CUSTOM', start_date: '2024-02-29', end_date: '2024-03-01',
  }));
});

test('date validation permits independent start and end dates when no date_range selector exists', () => {
  const tool = decorateTool({
    name: 'meta_breakdown',
    inputSchema: {
      type: 'object',
      properties: {
        account_name: { type: 'string' },
        breakdown: { type: 'string' },
        date_preset: { type: 'string' },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
      },
    },
  });
  assert.doesNotThrow(() => validateArgs(tool, {
    account_name: 'Audit Client A', breakdown: 'campaign', date_preset: 'last_30d',
    start_date: '2025-04-01', end_date: '2025-04-30',
  }));
});

test('financial validation rejects negative values at top level and in nested inputs', () => {
  const tool = decorateTool({
    name: 'budget_write',
    inputSchema: {
      type: 'object',
      properties: {
        budget: { type: 'number' },
        campaign: {
          type: 'object',
          properties: { daily_budget: { type: 'number' } },
        },
      },
    },
  });

  assertInvalidArguments(() => validateArgs(tool, { budget: -0.01 }));
  assertInvalidArguments(() => validateArgs(tool, { campaign: { daily_budget: -10 } }));
  assertInvalidArguments(() => validateArgs(tool, { budget: Number.POSITIVE_INFINITY }));
});

test('writeIdentity canonicalizes nested object keys and supports explicit idempotency keys', () => {
  const first = writeIdentity('update_campaign', {
    account_name: 'Acme',
    confirm: true,
    nested: { z: [{ b: 2, a: 1 }], a: { y: 2, x: 1 } },
  });
  const reordered = writeIdentity('update_campaign', {
    nested: { a: { x: 1, y: 2 }, z: [{ a: 1, b: 2 }] },
    confirm: false,
    account_name: 'Acme',
  });
  assert.deepEqual(reordered, first);

  const explicit = writeIdentity('update_campaign', {
    account_name: 'Acme', confirm: true, idempotency_key: 'retry-7', nested: { value: 1 },
  });
  const explicitWithChangedPayload = writeIdentity('update_campaign', {
    account_name: 'Acme', confirm: false, idempotency_key: 'retry-7', nested: { value: 999 },
  });
  assert.equal(explicit.key, explicitWithChangedPayload.key);
  assert.notEqual(explicit.payloadHash, explicitWithChangedPayload.payloadHash);
  assert.notEqual(explicit.key, explicit.payloadHash);
});

test('annotateResult reports top-level errors, nested partial failures, and all-failed coverage', () => {
  const context = { requestId: 'request-123', started: Date.now() - 5 };
  const topLevel = annotateResult({ error: 'provider unavailable' }, context);
  assert.equal(topLevel._meta.status, 'error');
  assert.equal(topLevel._meta.request_id, 'request-123');
  assert.equal(topLevel._meta.errors.length, 1);
  assert.equal(topLevel._meta.errors[0].path, '$');

  const partial = annotateResult({
    results: [
      { account: 'good-account', clicks: 12 },
      { account: 'bad-account', error: 'rate limited', code: 'RATE_LIMIT' },
    ],
  }, context);
  assert.equal(partial._meta.status, 'partial_success');
  assert.deepEqual(partial._meta.coverage, { total: 2, succeeded: 1, failed: 1 });
  assert.equal(partial._meta.errors[0].account, 'bad-account');
  assert.equal(partial._meta.errors[0].code, 'RATE_LIMIT');
  assert.equal(partial._meta.errors[0].path, '$.results.1');

  const allFailed = annotateResult({
    accounts: [
      { account: 'one', error: 'failed one' },
      { account: 'two', error: 'failed two' },
    ],
  }, context);
  assert.equal(allFailed._meta.status, 'error');
  assert.deepEqual(allFailed._meta.coverage, { total: 2, succeeded: 0, failed: 2 });
  assert.equal(allFailed._meta.errors.length, 2);

  const nestedErrors = annotateResult({
    account: 'nested-account',
    errors: [
      { code: 'RATE_LIMIT', message: 'retry later' },
      { error: 'row failed' },
    ],
  }, context);
  assert.equal(nestedErrors._meta.status, 'partial_success');
  assert.equal(nestedErrors._meta.errors.length, 2);
  assert.equal(nestedErrors._meta.errors[0].path, '$.errors.0');
  assert.equal(nestedErrors._meta.errors[0].account, 'nested-account');
  assert.equal(nestedErrors._meta.errors[0].code, 'RATE_LIMIT');
  assert.equal(nestedErrors._meta.errors[1].path, '$.errors.1');
});

test('FileWriteStore permits only one concurrent reservation for a key', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaycomm-write-store-'));
  try {
    const store = new FileWriteStore(directory);
    const reservations = await Promise.all([
      store.reserve('same-key', 'hash-a'),
      store.reserve('same-key', 'hash-a'),
    ]);
    assert.equal(reservations.filter(result => result.acquired).length, 1);
    const duplicate = await store.reserve('same-key', 'hash-b');
    assert.equal(duplicate.acquired, false);
    assert.equal(duplicate.state, 'pending');
    assert.equal(duplicate.payloadHash, 'hash-a');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('FileWriteStore removes rejected requests but persists failed and uncertain outcomes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaycomm-write-store-'));
  try {
    const store = new FileWriteStore(directory);

    await store.reserve('rejected-key', 'hash-rejected');
    await store.finish('rejected-key', 'rejected');
    assert.equal((await store.reserve('rejected-key', 'hash-rejected')).acquired, true);

    await store.reserve('failed-key', 'hash-failed');
    await store.finish('failed-key', 'failed');
    assert.equal(fs.existsSync(path.join(directory, 'failed-key.json')), true);
    const failed = await store.reserve('failed-key', 'hash-failed');
    assert.equal(failed.acquired, false);
    assert.equal(failed.state, 'failed');

    await store.reserve('uncertain-key', 'hash-uncertain');
    await store.finish('uncertain-key', 'uncertain');
    assert.equal(fs.existsSync(path.join(directory, 'uncertain-key.json')), true);
    const uncertain = await store.reserve('uncertain-key', 'hash-uncertain');
    assert.equal(uncertain.acquired, false);
    assert.equal(uncertain.state, 'uncertain');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('sameSecret compares equal non-empty strings without throwing on mismatched types or lengths', () => {
  assert.equal(sameSecret('shared-secret', 'shared-secret'), true);
  assert.equal(sameSecret('shared-secret', 'different'), false);
  assert.equal(sameSecret('short', 'much-longer'), false);
  assert.equal(sameSecret('shared-secret', ''), false);
  assert.equal(sameSecret(Buffer.from('shared-secret'), 'shared-secret'), false);
});

test('readJson enforces declared and streamed byte limits and rejects invalid JSON', async () => {
  await assert.rejects(
    readJson(requestFrom([Buffer.from('{}')], { 'content-length': '101' }), 100),
    error => error.statusCode === 413,
  );
  await assert.rejects(
    readJson(requestFrom([Buffer.from('12345')]), 4),
    error => error.statusCode === 413,
  );
  await assert.rejects(
    readJson(requestFrom([Buffer.from('{not-json}')]), 100),
    error => error.statusCode === 400,
  );
  assert.deepEqual(
    await readJson(requestFrom([Buffer.from('{"ok":'), Buffer.from('true}')]), 100),
    { ok: true },
  );
});

test('safeHttpHandler returns 413 for byte overflow from a real Readable request stream', async () => {
  const req = Readable.from([Buffer.from('12345')]);
  req.headers = {};
  const events = [];
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.headersSent = true;
      events.push({ type: 'head', status, headers });
    },
    end(body) {
      this.writableEnded = true;
      events.push({ type: 'end', body });
    },
  };
  safeHttpHandler(async request => readJson(request, 4))(req, res);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events[0].status, 413);
  assert.equal(events[1].body, 'Request body too large');
});

test('safeHttpHandler turns malformed URI failures into a non-leaky 400 response', async () => {
  const events = [];
  const response = {
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) { events.push({ type: 'writeHead', status, headers }); },
    end(body) { this.writableEnded = true; events.push({ type: 'end', body }); },
  };
  safeHttpHandler(() => decodeURIComponent('%not-a-uri'))({}, response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events[0].status, 400);
  assert.equal(events[1].body, 'Invalid request');
  assert.equal(events.some(event => String(event.body || '').includes('not-a-uri')), false);
});
