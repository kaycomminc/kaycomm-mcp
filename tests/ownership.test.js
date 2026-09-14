const test = require('node:test');
const assert = require('node:assert/strict');

const { validateOwnership } = require('../src/mcp/ownership');

const metaAccounts = {
  act_100: { name: 'Alpha' },
  act_200: { name: 'Beta' },
};
const googleAccounts = {
  '1000': { name: 'Alpha Google' },
};

function resolveAccount(store, search, { confirmed = false } = {}) {
  const entries = Object.entries(store).filter(([, info]) => info.name.toLowerCase() === String(search).toLowerCase());
  if (!entries.length) return { error: 'no account' };
  if (confirmed === true && entries.length !== 1) return { error: 'exact account required' };
  return { match: entries[0] };
}

function deps(metaGet, metaGetAll = async () => []) {
  return { metaAccounts, googleAccounts, resolveAccount, metaGet, metaGetAll };
}

test('update_meta_object blocks an object returned for another account', async () => {
  const result = await validateOwnership('update_meta_object', {
    account_name: 'Alpha', object_id: '999', level: 'campaign', updates: { status: 'PAUSED' },
  }, deps(async () => ({ id: '999', account_id: '200' })));

  assert.equal(result.ok, false);
  assert.equal(result.code, 'TARGET_ACCOUNT_MISMATCH');
  assert.match(result.error, /does not belong/);
});

test('update_meta_object allows a member on both preview and confirmation', async () => {
  const calls = [];
  const provider = async (id, params) => { calls.push([id, params]); return { id, account_id: '100' }; };
  const preview = await validateOwnership('update_meta_object', {
    account_name: 'Alpha', object_id: '999', level: 'campaign', updates: { name: 'Preview' },
  }, deps(provider));
  const confirmed = await validateOwnership('update_meta_object', {
    account_name: 'Alpha', object_id: '999', level: 'campaign', confirm: true, updates: { name: 'Apply' },
  }, deps(provider));

  assert.equal(preview.ok, true);
  assert.equal(confirmed.ok, true);
  assert.equal(calls.length, 2);
});

test('update_meta_object blocks relational campaign and audience references from another account', async () => {
  const result = await validateOwnership('update_meta_object', {
    account_name: 'Alpha', object_id: '999', level: 'campaign',
    updates: { campaign_id: '888', targeting: { custom_audiences: [{ id: '777' }] } },
  }, deps(async id => ({ id, account_id: id === '999' ? '100' : '200' })));

  assert.equal(result.ok, false);
  assert.equal(result.code, 'TARGET_ACCOUNT_MISMATCH');
});

test('update_meta_object rejects credential routing overrides and encoded relational fields', async () => {
  const unsafe = await validateOwnership('update_meta_object', {
    account_name: 'Alpha', object_id: '999', level: 'campaign',
    updates: { name: 'Safe-looking', access_token: 'secret' },
  }, deps(async () => ({ id: '999', account_id: '100' })));
  const encoded = await validateOwnership('update_meta_object', {
    account_name: 'Alpha', object_id: '999', level: 'ad',
    updates: { creative: '{"creative_id":"777"}', targeting: 'encoded-json' },
  }, deps(async () => ({ id: '999', account_id: '100' })));

  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.code, 'INVALID_ARGUMENT');
  assert.equal(encoded.ok, false);
  assert.equal(encoded.code, 'INVALID_ARGUMENT');
});

test('create_meta_campaign blocks an audience from another account in a dry run', async () => {
  const result = await validateOwnership('create_meta_campaign', {
    account_name: 'Alpha',
    ad_sets: [{ name: 'Prospecting', targeting: { custom_audiences: ['888'] } }],
  }, deps(async () => ({ id: '888', account_id: '200' })));

  assert.equal(result.ok, false);
  assert.equal(result.code, 'TARGET_ACCOUNT_MISMATCH');
});

test('create_meta_campaign allows an existing campaign and creative owned by account', async () => {
  const seen = [];
  const provider = async (id, params) => {
    seen.push([id, params]);
    return { id, account_id: '100' };
  };
  const result = await validateOwnership('create_meta_campaign', {
    account_name: 'Alpha', existing_campaign_id: '123',
    ad_sets: [{ name: 'Existing', existing_adset_id: '456', ads: [{ name: 'Ad', creative_id: '789' }] }],
  }, deps(provider));

  assert.equal(result.ok, true);
  assert.equal(seen.length, 3);
});

test('Google raw resource from another customer is blocked in preview', async () => {
  const result = await validateOwnership('populate_ad_group', {
    account_name: 'Alpha Google',
    ad_group_resource: 'customers/2000/adGroups/42',
  }, deps(undefined));

  assert.equal(result.ok, false);
  assert.equal(result.code, 'TARGET_ACCOUNT_MISMATCH');
});

test('Google ad resource rejects a geo constant instead of treating it as a resource', async () => {
  const result = await validateOwnership('update_ad_url', {
    account_name: 'Alpha Google',
    ad_resource_name: 'geoTargetConstants/2840',
  }, deps(undefined));

  assert.equal(result.ok, false);
  assert.equal(result.code, 'TARGET_ACCOUNT_MISMATCH');
});

test('Google asset resource for selected customer is allowed, including negative temp IDs', async () => {
  const result = await validateOwnership('create_pmax_campaign', {
    account_name: 'Alpha Google',
    business_name_asset: 'customers/1000/assets/-1',
    logo_asset: 'customers/1000/assets/22',
    marketing_images: ['customers/1000/assets/23'],
    square_marketing_images: ['customers/1000/assets/24'],
  }, deps(undefined));

  assert.equal(result.ok, true);
  assert.equal(result.platform, 'google');
});
