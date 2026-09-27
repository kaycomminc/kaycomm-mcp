// End-to-end coverage for the Summit Express gaps: page_id fallback, geos,
// dynamic creative, special ad category review and chunked/share-link media.
// The real server is compiled with synthetic accounts; Graph is mocked at fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const serverFilename = path.join(root, 'server.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaycomm-meta-build-'));
Object.assign(process.env, {
    MCP_TEST: '1', DIGEST_ENABLED: '0', ARCHIVE_ENABLED: '0',
    META_ACCESS_TOKEN: 'synthetic-meta-token',
    WRITE_LOG_FILE: path.join(tempDir, 'write-log.jsonl'),
    WRITE_STATE_DIR: path.join(tempDir, 'write-state'),
});
delete process.env.PORT;
delete process.env.ACCOUNTS_GITHUB_TOKEN;

const accounts = {
    google: {},
    meta: {
        act_one: { name: 'One Page Co', budget: 1000 },
        act_two: { name: 'Two Page Co', budget: 1000 },
        act_cfg: { name: 'Configured Co', budget: 1000, page_id: '555' },
    },
};
const PAGES = {
    act_one: [{ id: '111', name: 'One Page' }],
    act_two: [{ id: '180157065330926', name: 'Summit Express' }, { id: '103553957733814', name: 'Interiors by Southern Heritage' }],
    act_cfg: [{ id: '555', name: 'Configured' }],
};
const GEO = {
    'Summit County': [
        { key: '2790186', name: 'Summit County', type: 'medium_geo_area', region: 'Ohio', country_code: 'US' },
        { key: '2792602', name: 'Summit County', type: 'medium_geo_area', region: 'Colorado', country_code: 'US' },
    ],
    'Eagle County': [{ key: '2792132', name: 'Eagle County', type: 'medium_geo_area', region: 'Colorado', country_code: 'US' }],
    '80443': [{ key: 'US:80443', name: '80443', type: 'zip', region: 'Colorado', country_code: 'US' }],
};

const calls = [];
let drivePayload = null;
const json = (payload, status = 200) => ({ ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => payload });
global.fetch = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method || 'GET';
    let body = null;
    if (typeof options.body === 'string') body = JSON.parse(options.body);
    calls.push({ method, host: url.hostname, path: url.pathname, params: Object.fromEntries(url.searchParams), body });

    if (url.hostname === 'drive.usercontent.google.com') {
        const { buf, type } = drivePayload;
        return { ok: true, status: 200, headers: { get: k => ({ 'content-type': type, 'content-length': String(buf.length) })[k.toLowerCase()] ?? null },
            arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
    }
    const parts = url.pathname.split('/').filter(Boolean).slice(1);   // drop version
    if (method === 'GET') {
        if (parts[1] === 'promote_pages') return json({ data: PAGES[parts[0]] || [] });
        if (parts[0] === 'search' && url.searchParams.get('type') === 'adgeolocation') {
            const types = JSON.parse(url.searchParams.get('location_types'));
            return json({ data: (GEO[url.searchParams.get('q')] || []).filter(r => types.includes(r.type)) });
        }
        if (parts[0] === 'search' && url.searchParams.get('type') === 'adinterest') {
            return json({ data: [{ id: '6003', name: url.searchParams.get('q') }] });
        }
        if (parts[1] === 'adimages') return json({ data: [{ hash: 'urlhash', width: 800, height: 600 }] });
        if (parts[1] === 'instagram_accounts' || parts[1] === 'page_backed_instagram_accounts') return json({ data: [{ id: 'ig1' }] });
        if (parts[0] === 'lal') return json({ id: 'lal', account_id: 'two', name: 'Lookalike 1%', subtype: 'LOOKALIKE' });
        if (parts[0].startsWith('ad_')) return json({ creative: { id: 'cr_' + parts[0] } });
        return json({ id: parts[0], account_id: 'act_two' });
    }
    if (parts[1] === 'campaigns') return json({ id: 'camp_1' });
    if (parts[1] === 'adsets') return json({ id: 'adset_1' });
    if (parts[1] === 'ads') return json({ id: 'ad_1' });
    if (parts[1] === 'adimages') return json({ images: { f: { hash: 'hash_' + calls.filter(c => c.path.endsWith('/adimages')).length } } });
    return json({ id: 'x' });
};

const fakeFs = {
    ...fs,
    readFileSync(file, ...args) {
        if (String(file) === path.join(root, 'accounts.json')) return JSON.stringify(accounts);
        return fs.readFileSync(file, ...args);
    },
    writeFileSync(file, data, ...args) {
        if (String(file) === path.join(root, 'accounts.json')) return;
        return fs.writeFileSync(file, data, ...args);
    },
};
const serverModule = new Module(serverFilename, module);
serverModule.filename = serverFilename;
serverModule.paths = Module._nodeModulePaths(root);
const originalRequire = serverModule.require.bind(serverModule);
serverModule.require = name => (name === 'fs' ? fakeFs : originalRequire(name));
serverModule._compile(fs.readFileSync(serverFilename, 'utf8'), serverFilename);
const callHandler = serverModule.exports.makeServer()._requestHandlers.get('tools/call');

async function invoke(name, args) {
    const wire = await callHandler({ method: 'tools/call', params: { name, arguments: args } }, {});
    return JSON.parse(wire.content[0].text);
}
const posts = () => calls.filter(c => c.method === 'POST');

const BODIES = [
    'Year-round driving jobs in Summit County.\nGreat pay, ski pass perks. ',   // trailing space + newline on purpose
    'Drive the mountains. 🚐🏔️ Apply today — CDL training available.',
];
const hiringBuild = (extra = {}) => ({
    account_name: 'Two Page Co',
    page_id: '180157065330926',
    campaign_name: 'Summit Express | Hiring | Sept 2026',
    objective: 'OUTCOME_TRAFFIC',
    special_ad_categories: ['EMPLOYMENT'],
    cbo: true,
    daily_budget: 20,
    ad_sets: [{
        name: 'Hiring | Summit + Eagle County',
        optimization_goal: 'LANDING_PAGE_VIEWS',
        is_dynamic_creative: true,
        targeting: { geos: [{ name: 'Summit County, CO' }, { name: 'Eagle County, CO' }], placements: 'advantage_plus' },
        ads: [{
            name: 'Hiring DCO',
            asset_feed_spec: {
                images: ['a'.repeat(32), 'b'.repeat(32)],
                bodies: BODIES,
                titles: ['Work Hard. Play Hard. Drive With Us.'],
                call_to_action_types: ['APPLY_NOW'],
                link_urls: ['https://www.summitexpress.com/now-hiring/'],
            },
        }],
    }],
    ...extra,
});

test('create_meta_campaign: single promote_page is used with a _meta warning to save it', async () => {
    calls.length = 0;
    const r = await invoke('create_meta_campaign', { ...hiringBuild(), account_name: 'One Page Co', page_id: undefined });
    assert.equal(r.dry_run, true);
    assert.equal(r.page_id, '111');
    assert.equal(r.page_source, 'promote_pages');
    assert.ok(r._meta.warnings.some(w => /using its only promotable page, One Page \(111\).*page_id=111/.test(w)));
    assert.equal(posts().length, 0);
});

test('create_meta_campaign: multiple promote_pages without page_id errors and lists them', async () => {
    const { page_id, ...args } = hiringBuild();
    const r = await invoke('create_meta_campaign', args);
    assert.equal(r._meta.status, 'error');
    assert.match(r.error, /Summit Express \(180157065330926\), Interiors by Southern Heritage \(103553957733814\)/);
    assert.deepEqual(r.available_pages.map(p => p.id), ['180157065330926', '103553957733814']);
});

test('create_meta_campaign: accounts.json page_id is used without a promote_pages call', async () => {
    calls.length = 0;
    const { page_id, ...args } = hiringBuild({ account_name: 'Configured Co' });
    const r = await invoke('create_meta_campaign', args);
    assert.equal(r.page_id, '555');
    assert.equal(r.page_source, 'accounts.json');
    assert.equal(calls.filter(c => c.path.endsWith('/promote_pages')).length, 0);
});

test('create_meta_campaign dry run: geos resolve to county keys, DCO previews exact asset_feed_spec, EMPLOYMENT passes review', async () => {
    calls.length = 0;
    const r = await invoke('create_meta_campaign', hiringBuild());
    assert.equal(r._meta.status, 'success');
    assert.equal(posts().length, 0);
    const c = r.planned.campaign;
    assert.deepEqual(c.special_ad_categories, ['EMPLOYMENT']);
    assert.deepEqual(c.special_ad_category_country, ['US']);
    const set = r.planned.ad_sets[0];
    assert.deepEqual(set.geo_resolution.map(g => [g.key, g.type, g.region]), [['2792602', 'medium_geo_area', 'Colorado'], ['2792132', 'medium_geo_area', 'Colorado']]);
    assert.deepEqual(set.targeting_spec.geo_locations, { medium_geo_areas: [{ key: '2792602' }, { key: '2792132' }] });
    assert.deepEqual(set.special_ad_category_review.issues, []);
    const ad = set.ads[0];
    assert.equal(ad.creative_type, 'dynamic_creative');
    assert.deepEqual(ad.asset_feed_spec.bodies.map(b => b.text), BODIES);
    assert.deepEqual(ad.asset_feed_spec.call_to_action_types, ['APPLY_NOW']);
});

test('create_meta_campaign dry run: DCO with two ads fails validation and makes no writes', async () => {
    calls.length = 0;
    const args = hiringBuild();
    args.ad_sets[0].ads.push({ ...args.ad_sets[0].ads[0], name: 'Second' });
    const r = await invoke('create_meta_campaign', args);
    assert.equal(r._meta.status, 'error');
    assert.ok(r.validation_errors.some(e => /exactly one ad \(got 2\)/.test(e)));
    assert.equal(posts().length, 0);
});

test('create_meta_campaign dry run: EMPLOYMENT flags age, gender, ZIP, exclusions, lookalike and dropped interests', async () => {
    const args = hiringBuild();
    args.ad_sets[0].targeting = {
        geos: [{ name: '80443' }], age_min: 21, age_max: 50, genders: [2],
        interests: ['Truck driving'], excluded_interests: ['Skiing'], custom_audiences: ['lal'],
    };
    const r = await invoke('create_meta_campaign', args);
    const review = r.planned.ad_sets[0].special_ad_category_review;
    assert.deepEqual(review.issues.map(i => i.field), ['age', 'genders', 'geo_locations.zips', 'exclusions', 'custom_audiences', 'flexible_spec']);
    assert.deepEqual(review.dropped_detailed_targeting, [{ kind: 'interests', id: '6003', name: 'Truck driving' }]);
    assert.ok(r._meta.warnings.some(w => /\[EMPLOYMENT\]: EMPLOYMENT ads can't use lookalike audiences/.test(w)));
});

test('create_meta_campaign confirm: sends EMPLOYMENT, PAUSED objects, and DCO copy byte-for-byte', async () => {
    calls.length = 0;
    const r = await invoke('create_meta_campaign', { ...hiringBuild(), confirm: true, idempotency_key: 'summit-hiring-test' });
    assert.equal(r.success, true, JSON.stringify(r));
    const [camp] = posts().filter(p => p.path.endsWith('/campaigns'));
    assert.deepEqual(camp.body.special_ad_categories, ['EMPLOYMENT']);
    assert.deepEqual(camp.body.special_ad_category_country, ['US']);
    assert.equal(camp.body.status, 'PAUSED');
    assert.equal(camp.body.daily_budget, 2000);
    const [adset] = posts().filter(p => p.path.endsWith('/adsets'));
    assert.equal(adset.body.status, 'PAUSED');
    assert.equal(adset.body.is_dynamic_creative, true);
    assert.equal(adset.body.optimization_goal, 'LANDING_PAGE_VIEWS');
    assert.deepEqual(adset.body.targeting.geo_locations, { medium_geo_areas: [{ key: '2792602' }, { key: '2792132' }] });
    const [ad] = posts().filter(p => p.path.endsWith('/ads'));
    assert.equal(ad.body.status, 'PAUSED');
    const { creative } = ad.body;
    assert.deepEqual(creative.object_story_spec, { page_id: '180157065330926', instagram_user_id: 'ig1' });
    assert.deepEqual(creative.asset_feed_spec.bodies.map(b => b.text), BODIES);
    for (const [i, t] of BODIES.entries()) assert.equal(Buffer.compare(Buffer.from(creative.asset_feed_spec.bodies[i].text), Buffer.from(t)), 0);
    assert.deepEqual(creative.asset_feed_spec.titles, [{ text: 'Work Hard. Play Hard. Drive With Us.' }]);
    assert.deepEqual(creative.asset_feed_spec.images, [{ hash: 'a'.repeat(32) }, { hash: 'b'.repeat(32) }]);
    assert.equal(creative.asset_feed_spec.optimization_type, undefined);
    assert.ok(creative.url_tags.includes('utm_source=facebook'));
});

test('create_meta_campaign confirm: unresolved geo aborts before any POST', async () => {
    calls.length = 0;
    const args = hiringBuild({ confirm: true, idempotency_key: 'bad-geo' });
    args.ad_sets[0].targeting.geos = [{ name: 'Summit County' }];   // ambiguous: OH + CO
    const r = await invoke('create_meta_campaign', args);
    assert.match(r.validation_errors[0], /ambiguous/);
    assert.equal(posts().length, 0);
});

test('upload_meta_media_chunk: stage, preview dimensions, then confirm uploads and returns hash/name/dims', async () => {
    const img = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: '#0a0' } }).jpeg().toBuffer();
    const b64 = img.toString('base64');
    const cut = Math.floor(b64.length / 3);
    const pieces = [b64.slice(0, cut), b64.slice(cut, 2 * cut + 1), b64.slice(2 * cut + 1)];
    const base = { account_name: 'Two Page Co', upload_id: 'hire-1', total_chunks: 3 };
    const first = await invoke('upload_meta_media_chunk', { ...base, chunk_index: 0, data: pieces[0], name: 'hire-1080.jpg' });
    assert.equal(first.status, 'staged');
    assert.deepEqual(first.missing, [1, 2]);
    await invoke('upload_meta_media_chunk', { ...base, chunk_index: 2, data: pieces[2] });
    const preview = await invoke('upload_meta_media_chunk', { ...base, chunk_index: 1, data: pieces[1] });
    assert.equal(preview.dry_run, true);
    assert.deepEqual([preview.file.width, preview.file.height, preview.file.name], [1080, 1080, 'hire-1080.jpg']);
    calls.length = 0;
    const done = await invoke('upload_meta_media_chunk', { account_name: 'Two Page Co', upload_id: 'hire-1', confirm: true });
    assert.equal(done.success, true, JSON.stringify(done));
    assert.deepEqual(Object.keys(done.uploaded[0]).filter(k => ['name', 'image_hash', 'width', 'height'].includes(k)).sort(), ['height', 'image_hash', 'name', 'width']);
    assert.equal(done.uploaded[0].width, 1080);
    assert.equal(posts().filter(p => p.path.endsWith('/adimages')).length, 1);
    const again = await invoke('upload_meta_media_chunk', { account_name: 'Two Page Co', upload_id: 'hire-1' });
    assert.match(again.error, /No staged upload/);
});

test('upload_meta_media: Google Drive link is downloaded, content-type checked, dims returned', async () => {
    drivePayload = { buf: await sharp({ create: { width: 1200, height: 628, channels: 3, background: '#00f' } }).png().toBuffer(), type: 'image/png' };
    const dry = await invoke('upload_meta_media', { account_name: 'Two Page Co', files: [{ source: 'https://drive.google.com/file/d/FILE123/view?usp=sharing', name: 'hire-wide.png' }] });
    assert.equal(dry.dry_run, true, JSON.stringify(dry));
    assert.deepEqual([dry.files[0].width, dry.files[0].height, dry.files[0].provider], [1200, 628, 'google_drive']);
    assert.ok(calls.some(c => c.host === 'drive.usercontent.google.com' && c.params.id === 'FILE123'));
    const done = await invoke('upload_meta_media', { account_name: 'Two Page Co', files: [{ source: 'https://drive.google.com/file/d/FILE123/view?usp=sharing', name: 'hire-wide.png' }], confirm: true });
    assert.equal(done.uploaded[0].name, 'hire-wide.png');
    assert.ok(done.uploaded[0].image_hash);
    assert.deepEqual([done.uploaded[0].width, done.uploaded[0].height], [1200, 628]);
});

test('upload_meta_media: Drive link returning HTML is rejected', async () => {
    drivePayload = { buf: Buffer.from('<html>sign in</html>'), type: 'text/html' };
    const r = await invoke('upload_meta_media', { account_name: 'Two Page Co', files: [{ source: 'https://drive.google.com/file/d/PRIVATE/view' }] });
    assert.equal(r._meta.status, 'error');
    assert.match(r.details[0].error, /google_drive: .*got a web page/);
});

test('upload_meta_media: plain URL image returns dims from Meta after upload', async () => {
    const r = await invoke('upload_meta_media', { account_name: 'Two Page Co', files: [{ source: 'https://cdn.example.com/a.jpg' }], confirm: true });
    assert.deepEqual([r.uploaded[0].width, r.uploaded[0].height], [800, 600]);
});

test('manage_accounts: page_id is an accepted add/update field', async () => {
    const r = await invoke('manage_accounts', { action: 'update', platform: 'meta', id: 'act_two', page_id: '180157065330926' });
    assert.equal(r.dry_run, true);
    assert.deepEqual(r.changes, { page_id: '180157065330926' });
    const bad = await invoke('manage_accounts', { action: 'update', platform: 'meta', id: 'act_two', page_id: 'not-a-number' });
    assert.equal(bad._meta.errors[0].code, 'INVALID_ARGUMENT');
});
