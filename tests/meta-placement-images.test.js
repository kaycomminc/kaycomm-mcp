const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { validateVariants, resizePlacementImage, fetchMetaImage, placementCreative, preparePlacementImages } = require('../src/meta-placement-images');
const { validateOwnership } = require('../src/mcp/ownership');
const source = { id: '901', name: 'Original', url_tags: 'utm_source=test', object_story_spec: { page_id: '1', instagram_user_id: '2', link_data: { image_hash: 'original', link: 'https://example.com', name: 'Headline', message: 'Body', call_to_action: { type: 'BOOK_TRAVEL' } } } };
const variants = [{ width: 1080, height: 1350, placements: ['instagram_feed', 'facebook_feed'] }, { width: 1080, height: 1920, placements: ['instagram_stories', 'instagram_reels'], padding: 100 }];
test('contain preserves edge content, produces exact dimensions and applies padding color', async () => {
  const input = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const [v] = validateVariants([{ width: 100, height: 200, placements: ['instagram_stories'], background: '#0000ff', padding: 10 }]);
  const output = await resizePlacementImage(input, v);
  const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 100); assert.equal(info.height, 200);
  const pixel = (x,y) => [...data.subarray((y*info.width+x)*info.channels,(y*info.width+x)*info.channels+3)];
  assert.deepEqual(pixel(0,0), [0,0,255]);
  assert.deepEqual(pixel(10,60), [255,0,0]);
  assert.deepEqual(pixel(89,139), [255,0,0]);
  assert.deepEqual(pixel(90,140), [0,0,255]);
});
test('cover requires explicit selection and generates exact dimensions', async () => {
  const input = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const [v] = validateVariants([{ width: 100, height: 200, placements: ['instagram_stories'], fit: 'cover' }]);
  const m = await sharp(await resizePlacementImage(input, v)).metadata();
  assert.equal(m.width,100); assert.equal(m.height,200);
});
test('duplicate placements, invalid dimensions and excessive padding are rejected', () => {
  for (const vs of [[variants[0], variants[0]], [{ ...variants[0], width: 99999 }], [{ ...variants[0], padding: 540 }], [{ ...variants[0], placements: ['unknown'] }]]) assert.throws(() => validateVariants(vs));
});
test('placement rules preserve identity, copy, destination, CTA and tracking with original fallback', () => {
  const creative = placementCreative(source, validateVariants(variants), ['feed', 'story']);
  assert.deepEqual(creative.object_story_spec, { page_id:'1', instagram_user_id:'2' });
  assert.equal(creative.url_tags, source.url_tags);
  assert.equal(creative.asset_feed_spec.bodies[0].text, 'Body');
  assert.equal(creative.asset_feed_spec.titles[0].text, 'Headline');
  assert.equal(creative.asset_feed_spec.link_urls[0].website_url, 'https://example.com');
  assert.deepEqual(creative.asset_feed_spec.call_to_action_types, ['BOOK_TRAVEL']);
  assert.deepEqual(creative.asset_feed_spec.asset_customization_rules[0].customization_spec, { publisher_platforms:['instagram','facebook'], instagram_positions:['stream'], facebook_positions:['feed'] });
  assert.equal(creative.asset_feed_spec.asset_customization_rules.at(-1).image_label.name, 'placement_original');
  assert.equal(creative.degrees_of_freedom_spec.creative_features_spec.image_auto_crop.enroll_status,'OPT_OUT');
  assert.equal(source.degrees_of_freedom_spec, undefined);
});
test('unsupported copy fields fail before conversion and duplicate hashes combine labels', () => {
  assert.throws(() => placementCreative({ ...source, object_story_spec: { ...source.object_story_spec, link_data: { ...source.object_story_spec.link_data, app_link: 'special' } } }, validateVariants(variants), ['a','b']));
  const c = placementCreative(source, validateVariants(variants), ['original','original']);
  assert.equal(c.asset_feed_spec.images.length,1); assert.equal(c.asset_feed_spec.images[0].adlabels.length,3);
});
test('download rejects non-Meta hosts, credentials, redirects and oversized images', async () => {
  for (const url of ['http://scontent.fbcdn.net/a', 'https://localhost/a', 'https://fbcdn.net.attacker.com/a', 'https://user:pass@scontent.fbcdn.net/a']) await assert.rejects(fetchMetaImage(url, () => { throw new Error('Must not fetch'); }), /Meta CDN/);
  await assert.rejects(fetchMetaImage('https://scontent.fbcdn.net/a', async (_, options) => { assert.equal(options.redirect,'error'); return { ok:true,body:{},headers:new Headers({ 'content-length':String(21*1024*1024) }) }; }), /20 MB/);
});
function dependencies(input, failAt = '') {
  const posts = []; let saved;
  return { posts, accountId: 'act_a',
    get: async (id) => id === '901' ? structuredClone(source) : id.endsWith('/adimages') ? { data:[{ hash:'original',url:'https://scontent.fbcdn.net/a',width:100,height:100 }] } : { id, ...saved },
    fetch: async () => new Response(input),
    post: async (path, body) => {
      posts.push({path,body});
      if (path.endsWith('/adimages')) { if (failAt === 'upload' && posts.length === 2) throw new Error('Upload failed'); return { images:{ image:{ hash:'resized'+posts.length } } }; }
      if (failAt === 'creative') throw new Error('Creative failed');
      saved = body; return { id:'902' };
    }
  };
}
test('dry run has no downloads/uploads and confirmed run uploads actual PNG bytes, verifies assignment', async () => {
  const input = await sharp({ create:{width:100,height:100,channels:3,background:'#ff0000'} }).png().toBuffer();
  const deps = dependencies(input); let fetched = false;
  const fetch = deps.fetch; deps.fetch = (...args) => { fetched = true; return fetch(...args); };
  const args = { creative_id:'901', variants };
  assert.equal((await preparePlacementImages(args,deps)).dry_run,true);
  assert.equal(fetched,false); assert.equal(deps.posts.length,0);
  const result = await preparePlacementImages({...args,confirm:true},deps);
  assert.equal(result.verified,true); assert.equal(result.live_ads_changed,false);
  assert.equal(result.creative_id,'902'); assert.equal(deps.posts.length,3);
  const m = await sharp(Buffer.from(deps.posts[1].body.bytes,'base64')).metadata();
  assert.equal(m.width,1080); assert.equal(m.height,1920);
});
test('partial upload failure returns completed hashes for reconciliation and never touches ads', async () => {
  const input = await sharp({ create:{width:100,height:100,channels:3,background:'#ff0000'} }).png().toBuffer();
  const deps = dependencies(input,'upload');
  const result = await preparePlacementImages({creative_id:'901',variants,confirm:true},deps);
  assert.equal(result.reconciliation_required,true); assert.equal(result.uploaded_images.length,1);
  assert.equal(result.error,'Upload failed'); assert.equal(deps.posts.length,2);
});
test('placement preparation rejects a cross-account creative before reads or writes', async () => {
  for (const confirm of [false,true]) {
    const result = await validateOwnership('prepare_meta_placement_images',{account_name:'A',creative_id:'901',confirm},{metaAccounts:{act_a:{name:'A'}},metaGet:async()=>({id:'901',account_id:'b'})});
    assert.equal(result.ok,false);
  }
});
test('recovery reuses account-owned images without downloading or uploading again', async () => {
  const vs = variants.map((v,i)=>({...v,image_hash:'reused'+i}));
  const deps = dependencies(null);
  const get=deps.get;
  deps.get=async id=>id.endsWith('/adimages')?{data:[{hash:'original',url:'https://scontent.fbcdn.net/a'},...vs.map(v=>({hash:v.image_hash,width:v.width,height:v.height}))]}:get(id);
  deps.fetch=()=>{throw new Error('Should not download');};
  const result=await preparePlacementImages({creative_id:'901',variants:vs,confirm:true},deps);
  assert.equal(result.verified,true); assert.equal(deps.posts.length,1);
  assert.ok(deps.posts[0].path.endsWith('/adcreatives'));
  assert.ok(result.uploaded_images.every(x=>x.reused));
  await assert.rejects(preparePlacementImages({creative_id:'901',variants:[{...vs[0],width:1000}],confirm:true},deps),/match requested dimensions/);
});
