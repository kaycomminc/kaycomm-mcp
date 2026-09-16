const test = require('node:test');
const assert = require('node:assert/strict');
const { buildImageEnhancementCreative: build, verifyImageEnhancements: verify } = require('../src/meta-image-enhancements');
const { validateOwnership } = require('../src/mcp/ownership');
const source = { id: '123', name: 'Image', object_story_spec: { page_id: '1', link_data: { image_hash: 'hash', link: 'https://example.com', message: 'Keep copy', call_to_action: { type: 'BOOK_TRAVEL' } } }, url_tags: 'utm_source=facebook', degrees_of_freedom_spec: { creative_features_spec: { image_uncrop: { enroll_status: 'OPT_OUT', customizations: { preserve: true } }, unrelated: { enroll_status: 'OPT_OUT' } } } };
test('replacement preserves source copy, tracking, nested settings and unrelated features', () => {
  const original = structuredClone(source);
  const result = build(source, { image_uncrop: 'OPT_IN' });
  assert.deepEqual(source, original);
  assert.deepEqual(result.object_story_spec, source.object_story_spec);
  assert.equal(result.url_tags, source.url_tags);
  assert.deepEqual(result.degrees_of_freedom_spec.creative_features_spec.image_uncrop, { enroll_status: 'OPT_IN', customizations: { preserve: true } });
  assert.deepEqual(result.degrees_of_freedom_spec.creative_features_spec.unrelated, { enroll_status: 'OPT_OUT' });
  assert.equal(result.id, undefined);
});
test('specialized creatives rejected instead of losing placement or post identity', () => {
  for (const changes of [{ asset_feed_spec: {} }, { object_story_id: '1_2' }, { product_set_id: '456' }, { object_story_spec: { video_data: {} } }, { object_story_spec: { link_data: { child_attachments: [], image_hash: 'h' } } }]) assert.throws(() => build({ ...source, ...changes }, { image_uncrop: 'OPT_IN' }), /Unsupported creative/);
});
test('invalid or empty enhancement changes rejected', () => {
  for (const change of [{}, { image_uncrop: true }, { arbitrary: 'OPT_IN' }]) assert.throws(() => build(source, change));
});
test('missing or mismatched readback cannot report verification success', () => {
  assert.equal(verify({}, { image_uncrop: 'OPT_IN' }).verified, false);
  assert.equal(verify(source, { image_uncrop: 'OPT_IN' }).verified, false);
  assert.equal(verify(build(source, { image_uncrop: 'OPT_IN' }), { image_uncrop: 'OPT_IN' }).verified, true);
});
test('ownership covers dry run and confirmed preparation', async () => {
  for (const confirm of [false, true]) {
    const result = await validateOwnership('prepare_meta_image_enhancements', { account_name: 'A', creative_id: '123', confirm }, { metaAccounts: { act_a: { name: 'A' } }, metaGet: async () => ({ id: '123', account_id: 'b' }) });
    assert.equal(result.ok, false);
  }
});
test('legacy bundle returned by Meta is omitted while individual settings remain', () => {
  const legacy = structuredClone(source);
  legacy.degrees_of_freedom_spec.creative_features_spec.standard_enhancements = { enroll_status:'OPT_IN' };
  const c=build(legacy,{image_uncrop:'OPT_IN'});
  assert.equal(c.degrees_of_freedom_spec.creative_features_spec.standard_enhancements,undefined);
  assert.deepEqual(c.degrees_of_freedom_spec.creative_features_spec.unrelated,{enroll_status:'OPT_OUT'});
  legacy.degrees_of_freedom_spec.creative_features_spec={standard_enhancements:{enroll_status:'OPT_IN'}};
  assert.throws(()=>build(legacy,{image_uncrop:'OPT_IN'}),/explicit migration/);
});
