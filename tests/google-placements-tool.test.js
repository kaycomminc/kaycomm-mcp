const test = require('node:test');
const assert = require('node:assert/strict');
const { tool, handleGetPlacements } = require('../src/google-placements-tool');

test('placement tool module keeps the report schema and returns a placement report', async () => {
  const calls = [];
  const result = await handleGetPlacements({ account_name: 'Acme', top_n: 12, min_impressions: 50 }, {
    googleAccounts: { '123': { name: 'Acme Media', mcc: '456' } },
    getGoogleAccessToken: async id => ({ token: `token-${id}` }),
    resolveGaqlDateClause: range => `range:${range}`,
    fetchPlacementPerformance: async (...args) => { calls.push(args); return { placements: [], totals: { placements_total: 0 } }; },
    clampTopN: (value, fallback) => Math.min(value || fallback, 500),
    placementViews: { channel: {}, detail: {} },
  });
  assert.equal(tool.name, 'get_placements');
  assert.deepEqual(tool.inputSchema.required, ['account_name']);
  assert.equal(calls[0][0], 'token-123');
  assert.equal(calls[0][6], 12);
  assert.equal(calls[0][7], 50);
  assert.equal(result.account, 'Acme Media');
  assert.equal(result.note.startsWith('No placement data'), true);
});

test('placement tool returns validation and authentication errors without fetching', async () => {
  const deps = {
    googleAccounts: { '123': { name: 'Acme Media', mcc: '456' } },
    getGoogleAccessToken: async () => ({ error: 'expired' }),
    resolveGaqlDateClause: () => 'range',
    fetchPlacementPerformance: async () => assert.fail('unexpected fetch'),
    clampTopN: value => value,
    placementViews: { channel: {}, detail: {} },
  };
  assert.match((await handleGetPlacements({ account_name: 'Acme', date_range: 'CUSTOM' }, deps)).error, /requires both/);
  assert.match((await handleGetPlacements({ account_name: 'Acme' }, deps)).error, /Auth failed/);
});
