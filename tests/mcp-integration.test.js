// Integration coverage for the registered MCP tools/call handler.  The server
// is compiled with synthetic accounts and all provider requests are mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');
const serverFilename = path.join(root, 'server.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaycomm-mcp-integration-'));
const stateDir = path.join(tempDir, 'write-state');
const writeLog = path.join(tempDir, 'write-log.jsonl');

const savedEnv = {};
for (const name of [
  'MCP_TEST', 'DIGEST_ENABLED', 'ARCHIVE_ENABLED', 'MCP_AUTH_TOKEN',
  'META_ACCESS_TOKEN', 'META_APP_ID', 'META_APP_SECRET', 'WRITE_LOG_FILE',
  'WRITE_STATE_DIR', 'MCP_TOOL_TIMEOUT_MS', 'PORT',
]) savedEnv[name] = process.env[name];
Object.assign(process.env, {
  MCP_TEST: '1',
  DIGEST_ENABLED: '0',
  ARCHIVE_ENABLED: '0',
  MCP_AUTH_TOKEN: 'synthetic-auth-token',
  META_ACCESS_TOKEN: 'synthetic-meta-token',
  META_APP_ID: 'synthetic-app-id',
  META_APP_SECRET: 'synthetic-app-secret',
  WRITE_LOG_FILE: writeLog,
  WRITE_STATE_DIR: stateDir,
  MCP_TOOL_TIMEOUT_MS: '35',
});
delete process.env.PORT;

const syntheticAccounts = {
  google: {},
  meta: { act_a: { name: 'Audit Client A', budget: 1000 } },
};
const fetches = [];
let failNextPost = false;
let httpHandler;

function response(payload, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => payload };
}

function requestBody(options) {
  if (typeof options.body !== 'string') return null;
  try { return JSON.parse(options.body); } catch (_) { return null; }
}

const realFetch = global.fetch;
global.fetch = async (input, options = {}) => {
  const url = new URL(input);
  const method = options.method || 'GET';
  const body = requestBody(options);
  fetches.push({ method, path: url.pathname, body });

  if (method === 'GET') {
    const id = url.pathname.split('/').filter(Boolean).at(-1);
    if (id === 'adcreatives') return response({data:[]});
    if (id === '901' || id === '902') return response({ id, account_id: 'act_a', name: 'Fixture image', object_story_spec: { page_id: '1', link_data: { image_hash: 'fixture', link: 'https://example.com', message: 'Original' } }, degrees_of_freedom_spec: { creative_features_spec: { image_uncrop: { enroll_status: id === '902' ? 'OPT_IN' : 'OPT_OUT' } } } });
    // Ads for retag_meta_ad: one with a clean destination, one already carrying inline UTMs.
    if (id === 'synthetic_ad' || id === 'synthetic_ad_inline') return response({ id, account_id: 'act_a', name: 'Fixture ad', status: 'ACTIVE', effective_status: 'ACTIVE', creative: { id: id === 'synthetic_ad_inline' ? '903' : '901' } });
    if (id === '903') return response({ id, account_id: 'act_a', name: 'Inline tagged', asset_feed_spec: { link_urls: [{ website_url: 'https://example.com/r/?utm_source=facebook&utm_medium=paidsocial' }] } });
    const accountId = id === 'synthetic_other' ? 'act_b' : 'act_a';
    return response({ id, account_id: accountId });
  }
  if (method === 'POST') {
    if (url.pathname.endsWith('/synthetic_timeout')) {
      return new Promise((resolve, reject) => {
        const signal = options.signal;
        const onAbort = () => reject(signal.reason || new Error('synthetic request aborted'));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (failNextPost) {
      failNextPost = false;
      throw new Error('synthetic upstream connection failure');
    }
    if (url.pathname.endsWith('/adcreatives')) return response({ id: '902' });
    if (url.pathname.endsWith('/adimages')) return response({ images: { uploaded: { hash: 'synthetic-image-hash' } } });
    return response({ success: true, num_received: 1, num_invalid_entries: 0 });
  }
  return response({ success: true });
};

const realHttp = require('node:http');
const fakeHttp = {
  ...realHttp,
  createServer(handler) {
    httpHandler = handler;
    return {
      requestTimeout: 0,
      headersTimeout: 0,
      listen(_port, callback) { if (callback) callback(); },
      close() {},
    };
  },
};

const fakeFs = {
  ...fs,
  readFileSync(file, ...args) {
    if (String(file) === path.join(root, 'accounts.json')) return JSON.stringify(syntheticAccounts);
    return fs.readFileSync(file, ...args);
  },
};

const serverModule = new Module(serverFilename, module);
serverModule.filename = serverFilename;
serverModule.paths = Module._nodeModulePaths(root);
const originalRequire = serverModule.require.bind(serverModule);
serverModule.require = name => {
  if (name === 'fs') return fakeFs;
  if (name === 'http') return fakeHttp;
  return originalRequire(name);
};
serverModule._compile(fs.readFileSync(serverFilename, 'utf8'), serverFilename);

const server = serverModule.exports;
const registeredServer = server.makeServer();
const callHandler = registeredServer._requestHandlers.get('tools/call');
const listHandler = registeredServer._requestHandlers.get('tools/list');

async function invoke(name, args) {
  const wire = await callHandler({ method: 'tools/call', params: { name, arguments: args } }, {});
  return { wire, value: JSON.parse(wire.content[0].text) };
}

function resetFetches() {
  fetches.length = 0;
  failNextPost = false;
}

function responseMock() {
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
  return { res, events };
}

async function flushHttp() {
  await new Promise(resolve => setImmediate(resolve));
}

test('registered catalog contains 81 tools with annotations and output schemas', async () => {
  const listed = await listHandler({ method: 'tools/list', params: {} }, {});
  assert.equal(listed.tools.length, 81);
  for (const tool of listed.tools) {
    assert.ok(tool.annotations, `${tool.name} is missing annotations`);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
    assert.equal(typeof tool.annotations.destructiveHint, 'boolean');
    assert.ok(tool.outputSchema, `${tool.name} is missing outputSchema`);
    assert.deepEqual(tool.outputSchema.properties._meta.required, [
      'status', 'request_id', 'duration_ms', 'errors',
    ]);
  }
});

test('registered tools reject string confirm false before any provider call', async () => {
  resetFetches();
  const result = await invoke('update_meta_object', {
    account_name: 'Audit Client A', object_id: 'synthetic_string_false', level: 'campaign',
    updates: { name: 'Should not run' }, confirm: 'false',
  });
  assert.equal(result.wire.isError, true);
  assert.equal(result.wire.structuredContent._meta.status, 'error');
  assert.equal(result.value._meta.errors[0].code, 'INVALID_ARGUMENT');
  assert.equal(fetches.length, 0);
});

test('valid confirm false performs an ownership preview but no mutation', async () => {
  resetFetches();
  const result = await invoke('update_meta_object', {
    account_name: 'Audit Client A', object_id: 'synthetic_preview', level: 'campaign',
    updates: { name: 'Preview only' }, confirm: false,
  });
  assert.equal(result.wire.isError, false);
  assert.equal(result.value.dry_run, true);
  assert.equal(fetches.filter(call => call.method === 'GET').length, 1);
  assert.equal(fetches.filter(call => call.method === 'POST').length, 0);
});

test('confirmed own-account object update is allowed and posts the intended object', async () => {
  resetFetches();
  const result = await invoke('update_meta_object', {
    account_name: 'Audit Client A', object_id: 'synthetic_owned', level: 'campaign',
    updates: { name: 'Allowed rename' }, confirm: true,
  });
  assert.equal(result.wire.isError, false);
  assert.equal(result.value.success, true);
  const post = fetches.find(call => call.method === 'POST');
  assert.ok(post);
  assert.equal(post.path, '/v25.0/synthetic_owned');
  assert.equal(post.body.name, 'Allowed rename');
});

test('cross-account object is rejected before any POST', async () => {
  resetFetches();
  const result = await invoke('update_meta_object', {
    account_name: 'Audit Client A', object_id: 'synthetic_other', level: 'campaign',
    updates: { name: 'Must not cross accounts' }, confirm: true,
  });
  assert.equal(result.wire.isError, true);
  assert.equal(result.value._meta.errors[0].code, 'TARGET_ACCOUNT_MISMATCH');
  assert.equal(fetches.filter(call => call.method === 'POST').length, 0);
});

test('negative nested budget is rejected before ownership or provider calls', async () => {
  resetFetches();
  const result = await invoke('update_meta_object', {
    account_name: 'Audit Client A', object_id: 'synthetic_negative', level: 'campaign',
    updates: { daily_budget: -1 }, budget_confirmed: true, confirm: true,
  });
  assert.equal(result.wire.isError, true);
  assert.equal(result.value._meta.errors[0].code, 'INVALID_ARGUMENT');
  assert.equal(fetches.length, 0);
});

test('concurrent confirmed updates reserve one write and issue only one POST', async () => {
  resetFetches();
  const args = {
    account_name: 'Audit Client A', object_id: 'synthetic_concurrent', level: 'campaign',
    updates: { name: 'One mutation' }, confirm: true,
  };
  const results = await Promise.all([invoke('update_meta_object', args), invoke('update_meta_object', args)]);
  assert.equal(fetches.filter(call => call.method === 'POST').length, 1);
  assert.equal(results.filter(result => result.value.success === true).length, 1);
  assert.equal(results.filter(result => result.value._meta.errors.some(error => error.code === 'DUPLICATE_WRITE_BLOCKED')).length, 1);
});

test('uncertain POST failure persists its reservation and blocks a retry', async () => {
  resetFetches();
  failNextPost = true;
  const args = {
    account_name: 'Audit Client A', object_id: 'synthetic_uncertain', level: 'campaign',
    updates: { name: 'Unknown outcome' }, confirm: true,
  };
  const first = await invoke('update_meta_object', args);
  const second = await invoke('update_meta_object', args);
  assert.equal(first.wire.isError, true);
  assert.equal(second.value._meta.errors[0].code, 'DUPLICATE_WRITE_BLOCKED');
  assert.equal(fetches.filter(call => call.method === 'POST').length, 1);
});

test('confirmed timeout is bounded, leaves an uncertain reservation, and blocks retry', async () => {
  resetFetches();
  const args = {
    account_name: 'Audit Client A', object_id: 'synthetic_timeout', level: 'campaign',
    updates: { name: 'Hanging mutation' }, confirm: true,
  };
  const started = Date.now();
  const first = await invoke('update_meta_object', args);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `timeout took ${elapsed}ms`);
  assert.equal(first.wire.isError, true);
  assert.equal(first.value._meta.errors[0].code, 'TOOL_TIMEOUT');
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = await invoke('update_meta_object', args);
  assert.equal(second.value._meta.errors[0].code, 'DUPLICATE_WRITE_BLOCKED');
  assert.equal(fetches.filter(call => call.method === 'POST').length, 1);
});

test('audit log excludes audience data, webhook verify token, and uploaded base64', async () => {
  resetFetches();
  const rawEmail = 'person@example.invalid';
  const rawAudienceData = 'raw-audience-marker';
  const verifyToken = 'verify-token-marker';
  const base64Data = Buffer.from('base64-upload-marker').toString('base64');

  await invoke('manage_meta_audience_users', {
    account_name: 'Audit Client A', audience_id: 'synthetic_audience', action: 'add',
    schema: ['EMAIL', 'FN'], data: [[rawEmail, rawAudienceData]], confirm: true,
  });
  await invoke('upload_meta_media', {
    account_name: 'Audit Client A', files: [{ name: 'pixel.png', base64_data: base64Data }], confirm: true,
  });
  await invoke('subscribe_meta_webhooks', {
    callback_url: 'https://example.invalid/webhook', verify_token: verifyToken, confirm: true,
  });

  const log = fs.readFileSync(writeLog, 'utf8');
  assert.equal(log.includes(rawEmail), false);
  assert.equal(log.includes(rawAudienceData), false);
  assert.equal(log.includes(verifyToken), false);
  assert.equal(log.includes(base64Data), false);
  assert.equal(log.includes('pixel.png'), false);
});

test('invalid custom dates return isError and structuredContent', async () => {
  resetFetches();
  const result = await invoke('get_meta_ad_performance', {
    account_name: 'Audit Client A', date_range: 'CUSTOM',
    start_date: '2025-02-29', end_date: '2025-03-01',
  });
  assert.equal(result.wire.isError, true);
  assert.equal(result.wire.structuredContent._meta.status, 'error');
  assert.equal(result.wire.structuredContent._meta.errors[0].code, 'INVALID_DATE_RANGE');
  assert.equal(fetches.length, 0);
});

test('main HTTP wrapper turns malformed /mcp path into 400 and unauthenticated requests into 401', async () => {
  process.env.PORT = '43123';
  await server.main();
  assert.equal(typeof httpHandler, 'function');

  const malformed = responseMock();
  httpHandler({ url: '/mcp/%', method: 'POST', headers: {} }, malformed.res);
  await flushHttp();
  assert.equal(malformed.events[0].status, 400);
  assert.equal(malformed.events[1].body, 'Invalid request');

  const unauthenticated = responseMock();
  httpHandler({ url: '/mcp/wrong-token', method: 'POST', headers: {} }, unauthenticated.res);
  await flushHttp();
  assert.equal(unauthenticated.events[0].status, 401);
  assert.equal(unauthenticated.events[1].body, 'Unauthorized');
});

test.after(() => {
  global.fetch = realFetch;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});


test('image enhancements dry run reads source without POST', async () => {
  resetFetches();
  const result = await invoke('prepare_meta_image_enhancements', { account_name: 'Audit Client A', creative_id: '901', enhancements: { image_uncrop: 'OPT_IN' } });
  assert.equal(result.value.dry_run, true);
  assert.equal(result.value.creative.object_story_spec.link_data.message, 'Original');
  assert.equal(fetches.filter(x => x.method === 'POST').length, 0);
});
test('image enhancements create an unattached creative and verify readback; retry blocked', async () => {
  resetFetches();
  const args = { account_name: 'Audit Client A', creative_id: '901', enhancements: { image_uncrop: 'OPT_IN' }, confirm: true, idempotency_key: 'fixture-image-creation' };
  const result = await invoke('prepare_meta_image_enhancements', args);
  assert.equal(result.value.creative_id, '902');
  assert.equal(result.value.verification.verified, true);
  assert.equal(result.value.live_ads_changed, false);
  assert.equal(fetches.filter(x => x.method === 'POST').length, 1);
  assert.ok(fetches.find(x => x.method === 'POST').path.endsWith('/act_a/adcreatives'));
  const retry = await invoke('prepare_meta_image_enhancements', args);
  assert.equal(retry.value._meta.errors[0].code, 'DUPLICATE_WRITE_BLOCKED');
  assert.equal(fetches.filter(x => x.method === 'POST').length, 1);
});
test('creative detail read exposes enhancement and crop fields', async () => {
  const result = await invoke('manage_meta', { account_name: 'Audit Client A', action: 'get_creative_details', creative_ids: ['901'] });
  assert.equal(result.value.creatives[0].degrees_of_freedom_spec.creative_features_spec.image_uncrop.enroll_status, 'OPT_OUT');
  assert.equal(result.value.creatives[0].image_crops, null);
});
test('creative listing supports reconciliation without requiring an ad attachment', async () => {
  const result = await invoke('manage_meta', { account_name:'Audit Client A', action:'list_creatives', target:'placement sizes' });
  assert.equal(result.value.error, undefined);
  assert.deepEqual(result.value.creatives, []);
});

const RETAG_TAGS = 'utm_source=Facebook&utm_medium=PPC&utm_campaign={{campaign.name}}&utm_content={{placement}}';

test('retag dry run plans the new tracking without writing to the provider', async () => {
  resetFetches();
  const { value } = await invoke('retag_meta_ad', {
    account_name: 'Audit Client A', ad_id: 'synthetic_ad', url_tags: RETAG_TAGS,
  });
  assert.equal(value.dry_run, true);
  assert.equal(value.live_ads_changed, false);
  assert.equal(value.creative.url_tags, RETAG_TAGS);
  assert.equal(value.new_url_tags, RETAG_TAGS);
  assert.equal(value.source_creative_id, '901');
  // The planned creative carries the source content forward, minus its identity.
  assert.equal(value.creative.object_story_spec.link_data.message, 'Original');
  assert.equal(value.creative.id, undefined);
  assert.equal(fetches.filter(f => f.method === 'POST').length, 0, 'dry run must not POST');
});

test('retag refuses to double-tag a URL that already carries the same parameters', async () => {
  resetFetches();
  const { value } = await invoke('retag_meta_ad', {
    account_name: 'Audit Client A', ad_id: 'synthetic_ad_inline', url_tags: RETAG_TAGS, confirm: true,
  });
  assert.equal(value.code, 'DUPLICATE_URL_PARAMS');
  assert.equal(value.live_ads_changed, false);
  assert.deepEqual(value.duplicate_param_warning[0].duplicate_params.sort(), ['utm_medium', 'utm_source']);
  assert.equal(fetches.filter(f => f.method === 'POST').length, 0, 'a blocked retag must not POST');
});

test('confirmed retag creates a tagged creative and repoints the ad at it', async () => {
  resetFetches();
  const { value } = await invoke('retag_meta_ad', {
    account_name: 'Audit Client A', ad_id: 'synthetic_ad', url_tags: RETAG_TAGS, confirm: true,
  });
  assert.equal(value.creative_id, '902');
  assert.equal(value.live_ads_changed, true);

  const posts = fetches.filter(f => f.method === 'POST');
  const create = posts.find(f => f.path.endsWith('/adcreatives'));
  assert.ok(create, 'expected a creative to be created');
  assert.equal(create.body.url_tags, RETAG_TAGS);

  const attach = posts.find(f => f.path.endsWith('/synthetic_ad'));
  assert.ok(attach, 'expected the ad to be repointed');
  assert.deepEqual(attach.body.creative, { creative_id: '902' });
});

test('retag rejects an ad outside the selected account before any write', async () => {
  resetFetches();
  const { value } = await invoke('retag_meta_ad', {
    account_name: 'Audit Client A', ad_id: 'synthetic_other', url_tags: RETAG_TAGS, confirm: true,
  });
  assert.equal(value._meta.errors[0].code, 'TARGET_ACCOUNT_MISMATCH');
  assert.equal(fetches.filter(f => f.method === 'POST').length, 0);
});
