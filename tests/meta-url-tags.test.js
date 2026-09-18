const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRetaggedCreative: build, validateUrlTags, destinationUrls, paramConflicts, verifyRetag,
} = require('../src/meta-url-tags');
const { validateOwnership } = require('../src/mcp/ownership');

const TAGS = 'utm_source=Facebook&utm_medium=PPC&utm_campaign={{campaign.name}}&utm_content={{placement}}';

const source = {
  id: '999', name: 'Breck After Dark',
  object_story_spec: {
    page_id: '1', instagram_user_id: '2',
    link_data: { image_hash: 'hash', link: 'http://summitexpress.com/', message: 'Body', name: 'Headline', call_to_action: { type: 'BOOK_TRAVEL' } },
  },
  degrees_of_freedom_spec: { creative_features_spec: { image_uncrop: { enroll_status: 'OPT_OUT' } } },
};

test('retagged copy keeps creative content and replaces only the tracking', () => {
  const original = structuredClone(source);
  const result = build(source, TAGS);
  assert.deepEqual(source, original, 'source must not be mutated');
  assert.equal(result.url_tags, TAGS);
  assert.deepEqual(result.object_story_spec, source.object_story_spec);
  assert.deepEqual(result.degrees_of_freedom_spec, source.degrees_of_freedom_spec);
  // Read-only identifiers must not be replayed into the create call.
  for (const field of ['id', 'object_story_id', 'effective_object_story_id', 'thumbnail_url']) {
    assert.equal(result[field], undefined, `${field} must not be copied`);
  }
  assert.equal(result.name, 'Breck After Dark - url tags');
});

test('retagging a copy twice does not stack name suffixes', () => {
  assert.equal(build({ ...source, name: 'X - url tags' }, TAGS).name, 'X - url tags');
});

test('existing-post and catalog creatives are refused rather than silently rebuilt', () => {
  assert.throws(() => build({ ...source, object_story_id: '1_2' }, TAGS), /existing Page post/);
  assert.throws(() => build({ ...source, product_set_id: '55' }, TAGS), /catalog/);
  assert.throws(() => build({ id: '1' }, TAGS), /no object_story_spec or asset_feed_spec/);
});

test('malformed url_tags are rejected before any provider call', () => {
  for (const bad of ['', '   ', '?utm_source=x', '&utm_source=x', 'utm_source', 'utm_source=', '=x',
    'utm_source=a b', 'utm_source=x#frag', 'utm_source=a&utm_source=b']) {
    assert.throws(() => validateUrlTags(bad), Error, `should reject: ${JSON.stringify(bad)}`);
  }
  assert.equal(validateUrlTags(`  ${TAGS}  `), TAGS, 'surrounding whitespace is trimmed');
});

test('destination URLs are found across link, CTA, carousel and asset-feed shapes', () => {
  const creative = {
    object_story_spec: {
      link_data: {
        link: 'https://a.example/',
        call_to_action: { value: { link: 'https://b.example/' } },
        child_attachments: [{ link: 'https://c.example/' }, { link: 'https://d.example/' }],
      },
      video_data: { call_to_action: { value: { link: 'https://e.example/' } } },
    },
    asset_feed_spec: { link_urls: [{ website_url: 'https://f.example/', deeplink_url: 'myapp://g' }] },
  };
  const found = destinationUrls(creative).map(x => x.url);
  for (const url of ['https://a.example/', 'https://b.example/', 'https://c.example/',
    'https://d.example/', 'https://e.example/', 'https://f.example/', 'myapp://g']) {
    assert.ok(found.includes(url), `missing ${url}`);
  }
});

test('inline parameters that url_tags would duplicate are reported with their location', () => {
  // The real Summit Express case: UTMs baked into the asset-feed URL.
  const inline = {
    asset_feed_spec: { link_urls: [{ website_url: 'https://x.example/r/?utm_source=facebook&utm_medium=paidsocial&utm_campaign=v9traffic' }] },
  };
  const [conflict] = paramConflicts(inline, TAGS);
  assert.deepEqual(conflict.duplicate_params.sort(), ['utm_campaign', 'utm_medium', 'utm_source']);
  assert.equal(conflict.path, 'asset_feed_spec.link_urls[0].website_url');

  // A clean URL, and one whose existing params do not overlap, are not conflicts.
  assert.deepEqual(paramConflicts(source, TAGS), []);
  assert.deepEqual(paramConflicts({ object_story_spec: { link_data: { link: 'https://x.example/?ref=partner' } } }, TAGS), []);
});

test('label IDs are stripped so the copy matches labels by name', () => {
  const labelled = {
    asset_feed_spec: {
      images: [{ hash: 'h', adlabels: [{ name: 'placement_original', id: '123' }] }],
      asset_customization_rules: [{ priority: 1, image_label: { name: 'placement_original', id: '123' }, customization_spec: {} }],
    },
  };
  const result = build(labelled, TAGS);
  assert.deepEqual(result.asset_feed_spec.images[0].adlabels, [{ name: 'placement_original' }]);
  assert.deepEqual(result.asset_feed_spec.asset_customization_rules[0].image_label, { name: 'placement_original' });
});

test('read-only asset feed keys and the legacy enhancement bundle are not replayed', () => {
  const withReadOnly = {
    asset_feed_spec: { optimization_type: 'PLACEMENT', additional_data: { multi_share_end_card: false } },
    degrees_of_freedom_spec: { creative_features_spec: { standard_enhancements: { enroll_status: 'OPT_IN' }, image_uncrop: { enroll_status: 'OPT_OUT' } } },
  };
  const result = build(withReadOnly, TAGS);
  assert.equal(result.asset_feed_spec.additional_data, undefined);
  assert.equal(result.asset_feed_spec.optimization_type, 'PLACEMENT');
  assert.equal(result.degrees_of_freedom_spec.creative_features_spec.standard_enhancements, undefined);
  assert.deepEqual(result.degrees_of_freedom_spec.creative_features_spec.image_uncrop, { enroll_status: 'OPT_OUT' });

  const legacyOnly = { asset_feed_spec: {}, degrees_of_freedom_spec: { creative_features_spec: { standard_enhancements: { enroll_status: 'OPT_IN' } } } };
  assert.throws(() => build(legacyOnly, TAGS), /explicit migration/);
});

test('verification fails on mismatched tracking, wrong creative or missing readback', () => {
  assert.equal(verifyRetag({ id: '5', url_tags: TAGS }, TAGS, '5').verified, true);
  assert.equal(verifyRetag({ id: '5', url_tags: 'utm_source=other' }, TAGS, '5').verified, false);
  assert.equal(verifyRetag({ id: '6', url_tags: TAGS }, TAGS, '5').verified, false);
  assert.equal(verifyRetag({}, TAGS, '5').verified, false);
  assert.equal(verifyRetag(null, TAGS, '5').verified, false);
});

test('ownership rejects an ad outside the selected account, on dry run and confirmed alike', async () => {
  for (const confirm of [false, true]) {
    const result = await validateOwnership('retag_meta_ad',
      { account_name: 'A', ad_id: '123', url_tags: TAGS, confirm },
      { metaAccounts: { act_a: { name: 'A' } }, resolveAccount: (store, search) => ({ match: ['act_a', { name: 'A' }] }), metaGet: async () => ({ id: '123', account_id: 'b' }) });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TARGET_ACCOUNT_MISMATCH');
  }
});

test('ownership accepts an ad in the selected account', async () => {
  const result = await validateOwnership('retag_meta_ad',
    { account_name: 'A', ad_id: '123', url_tags: TAGS, confirm: true },
    { metaAccounts: { act_a: { name: 'A' } }, resolveAccount: () => ({ match: ['act_a', { name: 'A' }] }), metaGet: async () => ({ id: '123', account_id: 'act_a' }) });
  assert.equal(result.ok, true);
});
