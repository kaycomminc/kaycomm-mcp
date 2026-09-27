const test = require('node:test');
const assert = require('node:assert/strict');
const {
    resolveMetaPageId, resolveMetaGeos, parseGeoName,
    copyLengthWarnings, validateAdSetCreatives, buildAssetFeedSpec,
    reviewSpecialAdCategoryTargeting,
} = require('../src/meta-campaign-build');

// ── Page ID ──────────────────────────────────────────────────────────────────

const pagesGet = pages => {
    const calls = [];
    const metaGet = async (path, params) => { calls.push({ path, params }); return { data: pages }; };
    return { metaGet, calls };
};

test('page_id: accounts.json value is used without calling Graph', async () => {
    const { metaGet, calls } = pagesGet([]);
    const r = await resolveMetaPageId({ accountId: 'act_1', accountName: 'A', configured: '111', metaGet });
    assert.equal(r.page_id, '111');
    assert.equal(r.source, 'accounts.json');
    assert.equal(calls.length, 0);
});

test('page_id: single promote_pages result is used with a save warning', async () => {
    const { metaGet, calls } = pagesGet([{ id: '222', name: 'Only Page' }]);
    const r = await resolveMetaPageId({ accountId: 'act_1', accountName: 'A', metaGet });
    assert.equal(r.page_id, '222');
    assert.equal(r.source, 'promote_pages');
    assert.equal(calls[0].path, 'act_1/promote_pages');
    assert.match(r.warnings[0], /Only Page \(222\)/);
    assert.match(r.warnings[0], /manage_accounts action=update platform=meta id=act_1 page_id=222/);
});

test('page_id: multiple promote_pages results error and list name + id', async () => {
    const { metaGet } = pagesGet([{ id: '180157065330926', name: 'Summit Express' }, { id: '103553957733814', name: 'Interiors by Southern Heritage' }]);
    const r = await resolveMetaPageId({ accountId: 'act_1', accountName: 'Summit Express', metaGet });
    assert.equal(r.page_id, undefined);
    assert.match(r.error, /Summit Express \(180157065330926\)/);
    assert.match(r.error, /Interiors by Southern Heritage \(103553957733814\)/);
    assert.equal(r.pages.length, 2);
});

test('page_id: no promote_pages is an error', async () => {
    const { metaGet } = pagesGet([]);
    const r = await resolveMetaPageId({ accountId: 'act_1', accountName: 'A', metaGet });
    assert.match(r.error, /no promote_pages/);
});

test('page_id: explicit argument overrides accounts.json and warns when not promotable', async () => {
    const { metaGet } = pagesGet([{ id: '222', name: 'Other' }]);
    const r = await resolveMetaPageId({ accountId: 'act_1', accountName: 'A', explicit: '999', configured: '111', metaGet });
    assert.equal(r.page_id, '999');
    assert.equal(r.source, 'argument');
    assert.ok(r.warnings.some(w => /overrides accounts.json page_id 111/.test(w)));
    assert.ok(r.warnings.some(w => /not in A's promote_pages/.test(w)));
});

test('page_id: explicit argument survives a failing promote_pages lookup', async () => {
    const r = await resolveMetaPageId({ accountId: 'act_1', accountName: 'A', explicit: '999', metaGet: async () => { throw new Error('boom'); } });
    assert.equal(r.page_id, '999');
    assert.deepEqual(r.warnings, []);
});

// ── Geo ──────────────────────────────────────────────────────────────────────

// Shapes copied from live /search?type=adgeolocation responses.
const GEO_FIXTURES = {
    'Summit County': [
        { key: '2790186', name: 'Summit County', type: 'medium_geo_area', region: 'Ohio', country_code: 'US' },
        { key: '2790379', name: 'Summit County', type: 'medium_geo_area', region: 'Utah', country_code: 'US' },
        { key: '2792602', name: 'Summit County', type: 'medium_geo_area', region: 'Colorado', country_code: 'US' },
    ],
    'Eagle County': [
        { key: '2792132', name: 'Eagle County', type: 'medium_geo_area', region: 'Colorado', country_code: 'US' },
    ],
    Frisco: [
        { key: '2527102', name: 'Frisco', type: 'city', region: 'Texas', country_code: 'US' },
        { key: '2423511', name: 'Frisco', type: 'city', region: 'Colorado', country_code: 'US' },
        { key: '2436804', name: 'Frisco', type: 'subcity', region: 'Idaho', country_code: 'US' },
    ],
    Eagle: [
        { key: '2423407', name: 'Eagle', type: 'city', region: 'Colorado', country_code: 'US' },
        { key: '2480566', name: 'Eagle', type: 'city', region: 'Nebraska', country_code: 'US' },
    ],
    '80443': [{ key: 'US:80443', name: '80443', type: 'zip', region: 'Colorado', country_code: 'US' }],
};
const geoSearch = () => {
    const calls = [];
    return { calls, searchGeo: async (q, types) => { calls.push({ q, types }); return (GEO_FIXTURES[q] || []).filter(r => types.includes(r.type)); } };
};

test('parseGeoName expands state abbreviations', () => {
    assert.deepEqual(parseGeoName('Frisco, CO'), { base: 'Frisco', region: 'Colorado' });
    assert.deepEqual(parseGeoName('Summit County, Colorado'), { base: 'Summit County', region: 'Colorado' });
    assert.deepEqual(parseGeoName('Denver'), { base: 'Denver', region: null });
});

test('geos: multiple cities resolve to exact keys with per-city radius', async () => {
    const { searchGeo } = geoSearch();
    const r = await resolveMetaGeos([{ name: 'Frisco, CO', radius: 20 }, { name: 'Eagle, CO', radius: 20 }], { searchGeo });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.geo_locations, { cities: [
        { key: '2423511', radius: 20, distance_unit: 'mile' },
        { key: '2423407', radius: 20, distance_unit: 'mile' },
    ] });
    assert.deepEqual(r.resolved.map(x => x.key), ['2423511', '2423407']);
});

test('geos: counties search medium_geo_area and resolve to the right state', async () => {
    const { searchGeo, calls } = geoSearch();
    const r = await resolveMetaGeos([{ name: 'Summit County, CO' }, { name: 'Eagle County, CO' }], { searchGeo });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(calls[0], { q: 'Summit County', types: ['medium_geo_area'] });
    assert.deepEqual(r.geo_locations, { medium_geo_areas: [{ key: '2792602' }, { key: '2792132' }] });
    assert.equal(r.resolved[0].region, 'Colorado');
    assert.equal(r.resolved[0].radius, undefined);
});

test('geos: ambiguous names error instead of guessing', async () => {
    const { searchGeo } = geoSearch();
    const r = await resolveMetaGeos([{ name: 'Summit County' }], { searchGeo });
    assert.equal(r.resolved.length, 0);
    assert.match(r.errors[0], /ambiguous/);
    assert.match(r.errors[0], /2792602/);
});

test('geos: unmatched names error with Meta suggestions', async () => {
    const { searchGeo } = geoSearch();
    const r = await resolveMetaGeos([{ name: 'Frisco, UT' }], { searchGeo });
    assert.match(r.errors[0], /no exact/);
    assert.match(r.errors[0], /Frisco, Colorado/);
});

test('geos: radius on a county is ignored with a warning; out-of-range city radius warns', async () => {
    const { searchGeo } = geoSearch();
    const r = await resolveMetaGeos([{ name: 'Eagle County, CO', radius: 20 }, { name: 'Frisco, CO', radius: 5 }], { searchGeo });
    assert.ok(r.warnings.some(w => /radius 20 is ignored/.test(w)));
    assert.ok(r.warnings.some(w => /10-50 miles; 5/.test(w)));
});

test('geos: ZIPs resolve to zips bucket', async () => {
    const { searchGeo } = geoSearch();
    const r = await resolveMetaGeos([{ name: '80443' }], { searchGeo });
    assert.deepEqual(r.geo_locations, { zips: [{ key: 'US:80443' }] });
});

// ── Dynamic creative ─────────────────────────────────────────────────────────

const dcoAd = (extra = {}) => ({
    name: 'DCO', url: 'https://www.summitexpress.com/now-hiring/', cta: 'APPLY_NOW',
    asset_feed_spec: { images: ['a'.repeat(32), 'b'.repeat(32)], bodies: ['Body one', 'Body two'], titles: ['Work Hard. Play Hard. Drive With Us.'], ...extra },
});

test('DCO: exactly one ad with asset_feed_spec passes validation', () => {
    const r = validateAdSetCreatives({ name: 'S', is_dynamic_creative: true, ads: [dcoAd()] }, 0);
    assert.deepEqual(r.errors, []);
});

test('DCO: more than one ad is rejected', () => {
    const r = validateAdSetCreatives({ name: 'S', is_dynamic_creative: true, ads: [dcoAd(), dcoAd()] }, 0);
    assert.match(r.errors[0], /exactly one ad \(got 2\)/);
});

test('DCO: zero ads is rejected', () => {
    const r = validateAdSetCreatives({ name: 'S', is_dynamic_creative: true, ads: [] }, 0);
    assert.match(r.errors[0], /exactly one ad \(got 0\)/);
});

test('DCO: ad without asset_feed_spec is rejected', () => {
    const r = validateAdSetCreatives({ name: 'S', is_dynamic_creative: true, ads: [{ name: 'plain', image_hash: 'x', url: 'https://x' }] }, 0);
    assert.ok(r.errors.some(e => /require asset_feed_spec/.test(e)));
});

test('DCO: asset_feed_spec mixed with single-asset fields, no media, too many bodies, no link are rejected', () => {
    const r = validateAdSetCreatives({ name: 'S', is_dynamic_creative: true, ads: [{
        name: 'bad', image_hash: 'x', primary_text: 'p',
        asset_feed_spec: { bodies: ['1', '2', '3', '4', '5', '6'] },
    }] }, 0);
    const text = r.errors.join('\n');
    assert.match(text, /can't be combined with image_hash, primary_text/);
    assert.match(text, /at least one image or video/);
    assert.match(text, /needs link_urls/);
    assert.match(text, /bodies has 6 items; Meta allows 5/);
});

test('asset_feed_spec outside dynamic creative is flexible format and warns', () => {
    const r = validateAdSetCreatives({ name: 'S', ads: [dcoAd()] }, 0);
    assert.deepEqual(r.errors, []);
    assert.ok(r.warnings.some(w => /flexible-format/.test(w)));
    const spec = buildAssetFeedSpec(dcoAd(), { dynamicCreative: false });
    assert.equal(spec.optimization_type, 'DEGREES_OF_FREEDOM');
});

test('buildAssetFeedSpec maps to Graph shape with ad-level link/CTA fallback', () => {
    const spec = buildAssetFeedSpec(dcoAd(), { dynamicCreative: true });
    assert.deepEqual(spec, {
        images: [{ hash: 'a'.repeat(32) }, { hash: 'b'.repeat(32) }],
        bodies: [{ text: 'Body one' }, { text: 'Body two' }],
        titles: [{ text: 'Work Hard. Play Hard. Drive With Us.' }],
        link_urls: [{ website_url: 'https://www.summitexpress.com/now-hiring/' }],
        call_to_action_types: ['APPLY_NOW'],
        ad_formats: ['SINGLE_IMAGE'],
    });
    assert.deepEqual(buildAssetFeedSpec({ asset_feed_spec: { videos: ['1'], images: ['h'], link_urls: ['https://x'] } }, { dynamicCreative: true }).ad_formats, ['AUTOMATIC_FORMAT']);
    assert.deepEqual(buildAssetFeedSpec({ asset_feed_spec: { videos: ['1'], link_urls: ['https://x'] } }, { dynamicCreative: true }).videos, [{ video_id: '1' }]);
});

test('copy is passed through byte-for-byte: whitespace, newlines, emoji, long text', () => {
    const odd = [
        '  Leading and trailing spaces  ',
        'Line one\n\nLine two\r\n\tTabbed — em dash “quotes” 🚐🏔️',
        'x'.repeat(400),
        'é (decomposed é) vs é',
    ];
    const ad = { url: 'https://x', asset_feed_spec: { images: ['h'], bodies: odd, titles: [odd[1]], descriptions: [odd[0]] } };
    const before = JSON.stringify(ad);
    const spec = buildAssetFeedSpec(ad, { dynamicCreative: true });
    assert.deepEqual(spec.bodies.map(b => b.text), odd);
    for (const [i, t] of odd.entries()) assert.equal(Buffer.compare(Buffer.from(spec.bodies[i].text), Buffer.from(t)), 0);
    assert.equal(spec.titles[0].text, odd[1]);
    assert.equal(spec.descriptions[0].text, odd[0]);
    assert.equal(JSON.stringify(ad), before, 'input must not be mutated');
});

test('over-length copy warns and reports length but never modifies', () => {
    const long = 'y'.repeat(130);
    const ad = { name: 'A', primary_text: long, headline: 'h'.repeat(41), description: 'd'.repeat(31), asset_feed_spec: { bodies: [long], titles: ['ok'] } };
    const w = copyLengthWarnings(ad, 'ad');
    assert.equal(w.length, 4);
    assert.match(w[0], /primary_text is 130 chars .*≤125.*Sent unchanged/);
    assert.equal(ad.primary_text, long);
    // Emoji count as one character each, not UTF-16 units.
    assert.deepEqual(copyLengthWarnings({ headline: '🚐'.repeat(40) }, 'ad'), []);
});

// ── Special ad categories ────────────────────────────────────────────────────

test('SAC: no review for unrestricted categories', async () => {
    assert.equal(await reviewSpecialAdCategoryTargeting({ categories: [], spec: { age_min: 25 } }), null);
    assert.equal(await reviewSpecialAdCategoryTargeting({ categories: ['ISSUES_ELECTIONS_POLITICS'], spec: { age_min: 25 } }), null);
});

test('SAC: compliant targeting (counties, 18-65, Advantage+) has no issues', async () => {
    const r = await reviewSpecialAdCategoryTargeting({ categories: ['EMPLOYMENT'], spec: { geo_locations: { medium_geo_areas: [{ key: '2792602' }] } } });
    assert.deepEqual(r.issues, []);
    assert.deepEqual(r.dropped_detailed_targeting, []);
});

test('SAC: flags age, gender, ZIP, small radius, detailed exclusions, lookalikes and dropped interests', async () => {
    const audiences = { '11': { id: '11', name: 'LAL 1%', subtype: 'LOOKALIKE' }, '12': { id: '12', name: 'Site visitors', subtype: 'WEBSITE' } };
    const r = await reviewSpecialAdCategoryTargeting({
        categories: ['EMPLOYMENT', 'HOUSING'],
        spec: {
            age_min: 21, age_max: 45, genders: [1],
            geo_locations: { zips: [{ key: 'US:80443' }], cities: [{ key: '2423511', radius: 10, distance_unit: 'mile' }, { key: '2423407', radius: 20, distance_unit: 'kilometer' }, { key: '9', radius: 15, distance_unit: 'mile' }] },
            exclusions: { custom_audiences: [{ id: '12' }], interests: [{ id: '600', name: 'Skiing' }] },
            custom_audiences: [{ id: '11' }, { id: '12' }],
            flexible_spec: [{ interests: [{ id: '6003', name: 'Truck driving' }], behaviors: [{ id: '6002', name: 'Commuters' }] }],
        },
        getAudience: async id => audiences[id],
    });
    const fields = r.issues.map(i => i.field);
    assert.deepEqual(fields, ['age', 'genders', 'geo_locations.zips', 'geo_locations.radius', 'geo_locations.radius', 'exclusions', 'custom_audiences', 'flexible_spec']);
    assert.match(r.issues[0].message, /EMPLOYMENT\/HOUSING ads must target ages 18-65\+; requested 21-45/);
    assert.match(r.issues[3].message, /2423511 is 10 miles/);
    assert.match(r.issues[4].message, /2423407 is 20 kilometers/);   // 20 km ≈ 12.4 mi
    assert.match(r.issues[6].message, /LAL 1% \(11\)/);
    assert.deepEqual(r.dropped_detailed_targeting, [
        { kind: 'interests', id: '6003', name: 'Truck driving' },
        { kind: 'behaviors', id: '6002', name: 'Commuters' },
    ]);
});

test('SAC: failed lookalike lookup is reported, not swallowed', async () => {
    const r = await reviewSpecialAdCategoryTargeting({ categories: ['CREDIT'], spec: { custom_audiences: [{ id: '5' }] }, getAudience: async () => { throw new Error('perm'); } });
    assert.match(r.issues[0].message, /Couldn't check whether audience 5 is a lookalike \(perm\)/);
});
