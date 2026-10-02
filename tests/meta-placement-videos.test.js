const test = require('node:test');
const assert = require('node:assert/strict');
const { aspectRatio, videoDimensions, validateVideoVariants, placementVideoCreative, preparePlacementVideos, DEFAULT_LABEL } = require('../src/meta-placement-videos');
const { validateAdSetCreatives } = require('../src/meta-campaign-build');
const { validateOwnership } = require('../src/mcp/ownership');

// Copy deliberately has a curly apostrophe, double space and trailing space to prove byte-for-byte copying.
const BODY = 'Ready for a job with strong pay?  You’ll get perks. ';
const source = { id: '501', name: 'Reel', instagram_user_id: '17841', url_tags: 'utm_source=facebook&utm_content={{ad.name}}',
  degrees_of_freedom_spec: { creative_features_spec: { advantage_plus_creative: { enroll_status: 'OPT_OUT' } } },
  object_story_spec: { page_id: '180', video_data: { video_id: '916', title: 'Apply Today', message: BODY, link_description: 'Join the team!',
    image_url: 'https://www.facebook.com/ads/image/?d=x', image_hash: 'a'.repeat(32), call_to_action: { type: 'APPLY_NOW', value: { link: 'https://example.com/jobs/' } } } } };
const fmt = (w, h) => [{ filter: '130x130', width: 130, height: Math.round(130 * h / w) }, { filter: 'native', width: w, height: h }];
const ready = { video_status: 'ready', processing_phase: { status: 'complete' } };
const VIDEOS = {
  '916': { id: '916', title: '9x16', status: ready, format: fmt(1080, 1920), thumbnails: { data: [{ uri: 'https://scontent.fbcdn.net/t916', is_preferred: true }] } },
  '45': { id: '45', title: '4x5', status: ready, format: fmt(1080, 1350), thumbnails: { data: [{ uri: 'https://scontent.fbcdn.net/t45', is_preferred: true }] } },
  '777001': { id: '777001', title: 'BM', status: ready, format: fmt(1080, 1350), thumbnails: { data: [] } },
  '888': { id: '888', status: { video_status: 'processing', processing_phase: { status: 'in_progress' } } },
};
const variants = [
  { video_id: '45', placements: ['facebook_feed', 'instagram_feed', 'instagram_explore', 'facebook_marketplace'] },
  { video_id: '916', placements: ['facebook_stories', 'instagram_stories', 'facebook_reels', 'instagram_reels'] },
];
function deps({ library = ['916', '45', '888'] } = {}) {
  const posts = []; let saved;
  return { posts, accountId: 'act_a',
    get: async (id) => {
      if (id === '501') return structuredClone(source);
      if (id === 'act_a/adimages') return { data: [{ hash: 'a'.repeat(32) }, { hash: 'b'.repeat(32) }] };
      if (id === '777') return { id, ...saved };
      if (VIDEOS[id]) return structuredClone(VIDEOS[id]);
      throw new Error("Unsupported get request. Object with ID '" + id + "' does not exist");
    },
    getAll: async () => library.map(id => ({ id })),
    uploadThumbnail: async (videoId) => { posts.push({ path: 'act_a/adimages', videoId }); return 'thumb' + videoId; },
    post: async (path, body) => { posts.push({ path, body }); saved = body; return { id: '777' }; },
  };
}

test('happy path dry run builds the placement rules with exact copy and makes no writes', async () => {
  const d = deps();
  const r = await preparePlacementVideos({ creative_id: '501', variants }, d);
  assert.equal(r.dry_run, true); assert.equal(r.error, undefined); assert.equal(d.posts.length, 0);
  const afs = r.creative.asset_feed_spec;
  assert.equal(afs.bodies[0].text, BODY);
  assert.equal(afs.titles[0].text, 'Apply Today');
  assert.equal(afs.descriptions[0].text, 'Join the team!');
  assert.deepEqual(afs.link_urls, [{ website_url: 'https://example.com/jobs/' }]);
  assert.deepEqual(afs.call_to_action_types, ['APPLY_NOW']);
  assert.deepEqual(afs.ad_formats, ['SINGLE_VIDEO']);
  assert.equal(afs.optimization_type, 'PLACEMENT');
  assert.equal(r.creative.url_tags, source.url_tags);
  assert.deepEqual(r.creative.object_story_spec, { page_id: '180', instagram_user_id: '17841' });
  assert.equal(r.creative.contextual_multi_ads.enroll_status, 'OPT_OUT');
  assert.deepEqual(afs.asset_customization_rules[0], { priority: 1, video_label: { name: 'placement_video_0' },
    customization_spec: { publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['feed', 'marketplace'], instagram_positions: ['stream', 'explore'] } });
  assert.deepEqual(afs.asset_customization_rules[1].customization_spec, { publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['story', 'facebook_reels'], instagram_positions: ['story', 'reels'] });
  // Source video is reused by variant 2 and the default: one entry, both labels, source thumbnail kept.
  const v916 = afs.videos.find(v => v.video_id === '916');
  assert.deepEqual(v916.adlabels.map(l => l.name), ['placement_video_1', DEFAULT_LABEL]);
  assert.equal(v916.thumbnail_hash, 'a'.repeat(32));
  assert.equal(afs.videos.find(v => v.video_id === '45').thumbnail_hash, '<auto thumbnail of 45>');
  assert.equal(r.thumbnails.find(t => t.video_id === '45').will_upload_from, 'https://scontent.fbcdn.net/t45');
  assert.deepEqual(r.videos.map(v => [v.video_id, v.aspect_ratio]), [['916', '9:16'], ['45', '4:5']]);
  assert.deepEqual(r.creative.degrees_of_freedom_spec, { creative_features_spec: { advantage_plus_creative: { enroll_status: 'OPT_OUT' } } }, 'enhancement opt-out is kept');
  assert.equal(source.object_story_spec.video_data.message, BODY, 'source untouched');
});

test('confirmed run uploads only the missing thumbnail, creates an unattached creative and verifies readback', async () => {
  const d = deps();
  const r = await preparePlacementVideos({ creative_id: '501', variants, confirm: true }, d);
  assert.equal(r.error, undefined);
  assert.equal(r.creative_id, '777'); assert.equal(r.verified, true); assert.equal(r.live_ads_changed, false);
  assert.deepEqual(r.uploaded_thumbnails, [{ video_id: '45', hash: 'thumb45' }]);
  assert.deepEqual(d.posts.map(p => p.path), ['act_a/adimages', 'act_a/adcreatives']);
  assert.ok(!d.posts.some(p => /\/ads$|^\d+$/.test(p.path)), 'never touches an ad');
  assert.equal(d.posts[1].body.asset_feed_spec.videos.find(v => v.video_id === '45').thumbnail_hash, 'thumb45');
});

test('explicit thumbnail is used and must exist in the account', async () => {
  const d = deps();
  const ok = await preparePlacementVideos({ creative_id: '501', variants: [{ ...variants[0], image_hash: 'b'.repeat(32) }, variants[1]], confirm: true }, d);
  assert.equal(ok.uploaded_thumbnails.length, 0);
  const bad = await preparePlacementVideos({ creative_id: '501', variants: [{ ...variants[0], image_hash: 'c'.repeat(32) }, variants[1]] }, deps());
  assert.match(bad.validation_errors.join(), /not in this ad account's image library/);
});

test('missing video fails validation with an explanation, even with confirm', async () => {
  const d = deps();
  const r = await preparePlacementVideos({ creative_id: '501', variants: [{ video_id: '404', placements: ['facebook_feed'] }], confirm: true }, d);
  assert.match(r.error, /Validation failed/);
  assert.match(r.validation_errors[0], /Video 404 was not found in this ad account's library, and a direct lookup also failed/);
  assert.equal(d.posts.length, 0);
});

test('video outside the ad account library but readable by ID passes with a Business Manager warning', async () => {
  const r = await preparePlacementVideos({ creative_id: '501', variants: [{ video_id: '777001', placements: ['facebook_feed'] }] }, deps({ library: ['916'] }));
  assert.equal(r.error, undefined);
  assert.equal(r.videos.find(v => v.video_id === '777001').library, 'business_or_shared');
  assert.match(r.warnings.join('\n'), /Video 777001 isn't in this ad account's video library .* Business Manager/);
  // The source video is also missing from the library here, and it is flagged as already accepted.
  const r2 = await preparePlacementVideos({ creative_id: '501', variants }, deps({ library: ['45'] }));
  assert.match(r2.warnings.join('\n'), /Video 916 .*source creative already uses it/);
});

test('still-processing video is rejected', async () => {
  const d = deps();
  const r = await preparePlacementVideos({ creative_id: '501', variants: [{ video_id: '888', placements: ['instagram_reels'] }], confirm: true }, d);
  assert.match(r.validation_errors.join(), /Video 888 is still processing \(status: processing; processing: in_progress\)/);
  assert.equal(d.posts.length, 0);
});

test('a placement assigned to two variants is rejected', async () => {
  const overlap = [variants[0], { video_id: '916', placements: ['facebook_feed', 'instagram_reels'] }];
  assert.match(validateVideoVariants(overlap).errors[0], /'facebook_feed' is assigned twice \(variants\[0\] and variants\[1\]\)/);
  const d = deps();
  const r = await preparePlacementVideos({ creative_id: '501', variants: overlap, confirm: true }, d);
  assert.match(r.error, /Validation failed/); assert.equal(d.posts.length, 0);
});

test('uncovered placements fall back to the source video through a final catch-all rule', async () => {
  const r = await preparePlacementVideos({ creative_id: '501', variants: [{ video_id: '45', placements: ['facebook_feed', 'instagram_feed'] }] }, deps());
  const rules = r.creative.asset_feed_spec.asset_customization_rules;
  assert.equal(rules.length, 2);
  assert.deepEqual(rules.at(-1), { priority: 2, video_label: { name: DEFAULT_LABEL }, customization_spec: {} });
  assert.equal(r.creative.asset_feed_spec.videos.find(v => v.video_id === '916').adlabels[0].name, DEFAULT_LABEL);
  assert.ok(r.uncovered_placements_use_default.includes('instagram_reels'));
  assert.equal(r.placement_map.instagram_reels, '916 (default)');
  assert.equal(r.placement_map.facebook_feed, '45');
});

test('over-length copy only warns and aspect mismatches are flagged', async () => {
  const long = 'x'.repeat(50) + ' ';
  const d = deps(); const get = d.get;
  d.get = async (id, q) => id === '501' ? { ...structuredClone(source), object_story_spec: { ...source.object_story_spec, video_data: { ...source.object_story_spec.video_data, title: long } } } : get(id, q);
  const r = await preparePlacementVideos({ creative_id: '501', variants: [{ video_id: '916', placements: ['facebook_feed'] }] }, d);
  assert.equal(r.creative.asset_feed_spec.titles[0].text, long);
  assert.match(r.warnings.join('\n'), /headline is 51 chars .* Sent unchanged/);
  assert.match(r.warnings.join('\n'), /Video 916 is 9:16 .* feed-style placements/);
});

test('image, existing-post and placement-asset sources are rejected', () => {
  assert.throws(() => placementVideoCreative({ object_story_spec: { page_id: '1', link_data: { image_hash: 'x' } } }, [], { variants: [] }), /not a single-video creative/);
  assert.throws(() => placementVideoCreative({ ...source, object_story_id: '1_2' }, [], { variants: [] }), /existing-post/);
  assert.throws(() => placementVideoCreative({ ...source, asset_feed_spec: {} }, [], { variants: [] }), /asset-feed/);
});

test('dimension helpers name common ratios', () => {
  assert.equal(aspectRatio(1080, 1350), '4:5'); assert.equal(aspectRatio(1080, 1920), '9:16');
  assert.equal(aspectRatio(1000, 300), '10:3'); assert.equal(aspectRatio(null, 5), null);
  assert.deepEqual(videoDimensions({ format: fmt(1080, 1350) }), { width: 1080, height: 1350, aspect_ratio: '4:5' });
  assert.deepEqual(videoDimensions({}), { width: null, height: null, aspect_ratio: null });
});

test('create_meta_campaign validation of placement_videos', () => {
  const ad = { name: 'A', video_id: '916', url: 'https://example.com', primary_text: 'p', headline: 'h', placement_videos: variants };
  assert.deepEqual(validateAdSetCreatives({ name: 'S', ads: [ad] }, 0).errors, []);
  const errs = validateAdSetCreatives({ name: 'S', is_dynamic_creative: true, ads: [{ ...ad, video_id: undefined, creative_id: '1', placement_videos: [variants[0], variants[0]] }] }, 0).errors.join('\n');
  for (const re of [/can't be combined with creative_id/, /dynamic creative/, /needs video_id/, /assigned twice/]) assert.match(errs, re);
});

test('ownership: placement videos check the source creative and update_meta_object refuses a bare creative_id', async () => {
  const ctx = { metaAccounts: { act_a: { name: 'A' } }, resolveAccount: store => ({ match: Object.entries(store)[0] }), metaGet: async () => ({ id: '501', account_id: 'b' }) };
  const cross = await validateOwnership('prepare_meta_placement_videos', { account_name: 'A', creative_id: '501', variants }, ctx);
  assert.equal(cross.code, 'TARGET_ACCOUNT_MISMATCH'); assert.match(cross.error, /Creative ID does not belong/);
  assert.equal((await validateOwnership('prepare_meta_placement_videos', { account_name: 'A', creative_id: '501', variants }, { ...ctx, metaGet: async () => ({ id: '501', account_id: 'a' }) })).ok, true);
  const bare = await validateOwnership('update_meta_object', { account_name: 'A', object_id: '1', level: 'ad', updates: { creative_id: '501' } }, { ...ctx, metaGet: async id => ({ id, account_id: 'a' }) });
  assert.equal(bare.code, 'INVALID_ARGUMENT');
});

test('verification matches videos by label because Meta stores per-creative copies under new IDs', async () => {
  const d = deps(); const get = d.get;
  d.get = async (id, q) => {
    const r = await get(id, q);
    if (id !== '777') return r;
    const copy = structuredClone(r);
    copy.status = 'IN_PROCESS';
    for (const v of copy.asset_feed_spec.videos) v.video_id = 'copy' + v.video_id;
    return copy;
  };
  const r = await preparePlacementVideos({ creative_id: '501', variants, confirm: true }, d);
  assert.equal(r.verified, true);
  assert.deepEqual(r.video_id_map.map(m => [m.requested, m.stored]), [['45', 'copy45'], ['916', 'copy916'], ['916', 'copy916']]);
  assert.match(r.warnings.join('\n'), /still processing creative 777 \(status: IN_PROCESS\)/);
});
