// manage_meta list_adsets / get_adset targeting passthrough, audience name
// resolution, Graph-side filtering, create_meta_campaign dry-run display and
// duplicate_meta_campaign objective override. Graph is mocked at fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const metaAdsets = require('../src/meta-adsets');

const root = path.resolve(__dirname, '..');
const serverFilename = path.join(root, 'server.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaycomm-meta-adsets-'));
Object.assign(process.env, {
    MCP_TEST: '1', DIGEST_ENABLED: '0', ARCHIVE_ENABLED: '0',
    META_ACCESS_TOKEN: 'synthetic-meta-token',
    WRITE_LOG_FILE: path.join(tempDir, 'write-log.jsonl'),
    WRITE_STATE_DIR: path.join(tempDir, 'write-state'),
});
delete process.env.PORT;
delete process.env.ACCOUNTS_GITHUB_TOKEN;

const accounts = { google: {}, meta: { act_nsw: { name: 'Synthetic Southwest', budget: 1000, page_id: '555' } } };

const FUTURE = '2099-12-01T00:00:00-0700';
const PAST = '2020-01-01T00:00:00-0700';
const LAL_TARGETING = {
    age_min: 25, geo_locations: { countries: ['US'] },
    custom_audiences: [{ id: '901', name: 'stale name' }],
    excluded_custom_audiences: [{ id: '902' }],
    flexible_spec: [{ interests: [{ id: '6003', name: 'Small business' }] }],
    targeting_automation: { advantage_audience: 0 },
    targeting_relaxation_types: { lookalike: 0, custom_audience: 0 },
};
const RT_TARGETING = { geo_locations: { countries: ['US'] }, custom_audiences: [{ id: '903' }], exclusions: { custom_audiences: [{ id: '902' }] } };
const ADSETS = [
    { id: '120249283942800240', name: 'Lookalike 1%', status: 'ACTIVE', effective_status: 'ACTIVE', end_time: FUTURE, campaign_id: 'c1', campaign: { id: 'c1', name: 'NSW | Prospecting | November 2026' }, targeting: LAL_TARGETING, optimization_goal: 'OFFSITE_CONVERSIONS' },
    { id: '120249283952100240', name: 'Retargeting', status: 'PAUSED', effective_status: 'PAUSED', end_time: FUTURE, campaign_id: 'c2', campaign: { id: 'c2', name: 'NSW | Retargeting | November 2026' }, targeting: RT_TARGETING },
    { id: '3', name: 'Old Retargeting', status: 'ACTIVE', effective_status: 'ACTIVE', end_time: PAST, campaign_id: 'c2', campaign: { id: 'c2', name: 'NSW | Retargeting | November 2026' }, targeting: {} },
];
const AUDIENCES = {
    901: { id: '901', name: 'NSW Lookalike 1% (US)', subtype: 'LOOKALIKE' },
    902: { id: '902', name: 'NSW Converters 180d', subtype: 'WEBSITE' },
    903: { id: '903', name: 'NSW Site Visitors 30d', subtype: 'WEBSITE' },
};

const calls = [];
const json = (payload, status = 200) => ({ ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => payload });
global.fetch = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method || 'GET';
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    const params = Object.fromEntries(url.searchParams);
    calls.push({ method, path: url.pathname, params, body });
    const parts = url.pathname.split('/').filter(Boolean).slice(1);
    if (method === 'GET') {
        if (parts.length === 0 && params.ids) {
            const out = {};
            for (const id of params.ids.split(',')) if (AUDIENCES[id]) out[id] = AUDIENCES[id];
            return json(out);
        }
        if (parts[0] === 'act_nsw' && parts[1] === 'campaigns') {
            const f = JSON.parse(params.filtering || '[]');
            const name = f.find(x => x.field === 'name')?.value?.toLowerCase();
            const camps = [{ id: 'c1', name: 'NSW | Prospecting | November 2026' }, { id: 'c2', name: 'NSW | Retargeting | November 2026' }];
            return json({ data: camps.filter(c => !name || c.name.toLowerCase().includes(name)) });
        }
        if (parts[0] === 'act_nsw' && parts[1] === 'adsets') {
            const f = JSON.parse(params.filtering || '[]');
            const eff = f.find(x => x.field === 'effective_status')?.value;
            const cids = f.find(x => x.field === 'campaign.id')?.value;
            const name = f.find(x => x.field === 'name')?.value?.toLowerCase();
            const rows = ADSETS.filter(a => (!eff || eff.includes(a.effective_status)) && (!cids || cids.includes(a.campaign_id)) && (!name || a.name.toLowerCase().includes(name)));
            return json({ data: rows });
        }
        if (parts[0] === '120249283942800240') {
            return json({ ...ADSETS[0], billing_event: 'IMPRESSIONS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', promoted_object: { pixel_id: 'px', custom_event_type: 'CONTACT' }, daily_budget: '2500', start_time: '2026-11-01T00:00:00-0700', campaign: { id: 'c1', name: 'NSW | Prospecting | November 2026', objective: 'OUTCOME_LEADS' } });
        }
        if (parts[0] === 'c1' && parts.length === 1) return json({ name: 'NSW | Prospecting | November 2026', objective: 'OUTCOME_LEADS', status: 'ACTIVE', special_ad_categories: [], daily_budget: '5000', bid_strategy: 'COST_CAP' });
        if (parts[0] === 'c1' && parts[1] === 'adsets') return json({ data: [{ id: 'as1', name: 'Lookalike 1%', status: 'ACTIVE', targeting: LAL_TARGETING, optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS', promoted_object: { pixel_id: 'px', custom_event_type: 'CONTACT' }, attribution_spec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }] }] });
        if (parts[0] === 'as1' && parts[1] === 'ads') return json({ data: [{ id: 'ad1', name: 'Ad 1', status: 'ACTIVE' }] });
        if (parts[1] === 'promote_pages') return json({ data: [{ id: '555', name: 'Page' }] });
        return json({ id: parts[0], account_id: 'act_nsw' });
    }
    return json({ id: 'new_' + parts.join('_') });
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
const audienceLookups = () => calls.filter(c => c.method === 'GET' && c.params.ids);

// ── unit ─────────────────────────────────────────────────────────────────────

test('collectAudienceIds covers top-level, excluded, exclusions and flexible_spec', () => {
    const ids = metaAdsets.collectAudienceIds({
        custom_audiences: [{ id: 1 }], excluded_custom_audiences: [{ id: '2' }],
        exclusions: { custom_audiences: [{ id: '3' }] }, flexible_spec: [{ custom_audiences: [{ id: '4' }, { id: '1' }] }],
    });
    assert.deepEqual(ids.sort(), ['1', '2', '3', '4']);
});

test('resolveAudienceNames batches 50 ids per request and survives a failed batch', async () => {
    const seen = [];
    const ids = Array.from({ length: 120 }, (_, i) => String(i));
    const warnings = [];
    const map = await metaAdsets.resolveAudienceNames(ids, async (p, q) => {
        seen.push(q.ids.split(',').length);
        if (seen.length === 2) throw new Error('boom');
        return Object.fromEntries(q.ids.split(',').map(id => [id, { name: `A${id}` }]));
    }, warnings);
    assert.deepEqual(seen, [50, 50, 20]);
    assert.equal(map.get('0').name, 'A0');
    assert.equal(map.has('60'), false);
    assert.equal(warnings.length, 1);
});

test('shapeAdset keeps the simplified fields and adds untrimmed targeting_raw', () => {
    const map = new Map([['901', { id: '901', name: 'LAL', subtype: 'LOOKALIKE' }]]);
    const out = metaAdsets.shapeAdset(ADSETS[0], { audienceMap: map, includeRaw: true });
    assert.deepEqual(out.targeting_raw, LAL_TARGETING);
    assert.equal(out.targeting.age_min, 25);
    assert.deepEqual(out.targeting.interests, [{ id: '6003', name: 'Small business' }]);
    assert.deepEqual(out.targeting.custom_audiences, [{ id: '901', name: 'LAL', subtype: 'LOOKALIKE' }]);
    assert.deepEqual(out.targeting.excluded_custom_audiences, [{ id: '902', name: null }]);
    assert.equal(metaAdsets.shapeAdset(ADSETS[0]).targeting_raw, undefined);
});

test('status filter: default ACTIVE+PAUSED, COMPLETED bucket by end date, bad values rejected', () => {
    assert.deepEqual(metaAdsets.normalizeStatusFilter(), ['ACTIVE', 'PAUSED']);
    assert.deepEqual(metaAdsets.normalizeStatusFilter(['all']), ['ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED']);
    assert.throws(() => metaAdsets.normalizeStatusFilter(['LIVE']), /Unknown status_filter/);
    assert.equal(metaAdsets.adsetBucket(ADSETS[2]), 'COMPLETED');
    assert.equal(metaAdsets.adsetBucket(ADSETS[1]), 'PAUSED');
    const f = metaAdsets.buildAdsetFiltering({ nameContains: 'Retarg', campaignIds: ['c2'], statuses: ['ACTIVE'] });
    assert.deepEqual(f.map(x => x.field), ['effective_status', 'campaign.id', 'name']);
});

test('placementSummary reads the merged spec', () => {
    assert.equal(metaAdsets.placementSummary({}), 'Advantage+ (auto)');
    assert.equal(metaAdsets.placementSummary({ publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['feed'], device_platforms: ['mobile'] }),
        'Manual: facebook (feed), instagram (all positions); devices: mobile');
});

test('planObjectiveDuplicate swaps objective/goal and drops conversion-only fields', () => {
    const plan = metaAdsets.planObjectiveDuplicate({
        campaign: { name: 'Src', objective: 'OUTCOME_LEADS', status: 'ACTIVE', daily_budget: '5000', bid_strategy: 'COST_CAP' },
        adsets: [{ id: 'as1', name: 'A', optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS', targeting: { x: 1 }, promoted_object: { pixel_id: 'p' }, attribution_spec: [{}], ads: [{ id: 'ad1', name: 'Ad' }] }],
    }, { objective: 'OUTCOME_TRAFFIC', optimization_goal: 'LANDING_PAGE_VIEWS', new_name: 'New' });
    assert.equal(plan.campaign.body.objective, 'OUTCOME_TRAFFIC');
    assert.equal(plan.campaign.body.status, 'PAUSED');
    assert.equal(plan.campaign.body.daily_budget, 5000);
    assert.equal(plan.campaign.body.bid_strategy, 'LOWEST_COST_WITHOUT_CAP');
    assert.equal(plan.warnings.length, 1);
    const s = plan.adsets[0];
    assert.equal(s.body.optimization_goal, 'LANDING_PAGE_VIEWS');
    assert.equal(s.body.promoted_object, undefined);
    assert.equal(s.body.attribution_spec, undefined);
    assert.deepEqual(s.body.targeting, { x: 1 });
    assert.deepEqual(s.dropped, ['promoted_object', 'attribution_spec']);
});

// ── integration through the MCP handler ──────────────────────────────────────

test('list_adsets campaign filter is server-side and returns named audiences + targeting_raw', async () => {
    calls.length = 0;
    const r = await invoke('manage_meta', { account_name: 'Synthetic Southwest', action: 'list_adsets', campaign: 'NSW | Retargeting | November 2026' });
    const adsetCall = calls.find(c => c.path.endsWith('/act_nsw/adsets'));
    const f = JSON.parse(adsetCall.params.filtering);
    assert.deepEqual(f.find(x => x.field === 'campaign.id').value, ['c2']);
    assert.deepEqual(r.adsets.map(a => a.name), ['Retargeting']);   // completed one dropped by default
    const rt = r.adsets[0];
    assert.deepEqual(rt.targeting.custom_audiences, [{ id: '903', name: 'NSW Site Visitors 30d', subtype: 'WEBSITE' }]);
    assert.deepEqual(rt.targeting.excluded_custom_audiences, [{ id: '902', name: 'NSW Converters 180d', subtype: 'WEBSITE' }]);
    assert.deepEqual(rt.targeting_raw, RT_TARGETING);
    assert.equal(audienceLookups().length, 1);
});

test('list_adsets target filters by ad set name in Graph, honours limit and COMPLETED', async () => {
    calls.length = 0;
    const r = await invoke('manage_meta', { account_name: 'Synthetic Southwest', action: 'list_adsets', target: 'Retargeting', status_filter: ['ACTIVE', 'PAUSED', 'COMPLETED'], limit: 1 });
    const f = JSON.parse(calls.find(c => c.path.endsWith('/act_nsw/adsets')).params.filtering);
    assert.equal(f.find(x => x.field === 'name').value, 'Retargeting');
    assert.equal(r.count, 1);
    assert.equal(r.truncated, true);
});

test('get_adset returns full raw targeting and resolved audiences in one lookup', async () => {
    calls.length = 0;
    const r = await invoke('manage_meta', { account_name: 'Synthetic Southwest', action: 'get_adset', adset_id: '120249283942800240' });
    assert.deepEqual(r.targeting_raw, LAL_TARGETING);
    assert.deepEqual(r.custom_audiences, [{ id: '901', name: 'NSW Lookalike 1% (US)', subtype: 'LOOKALIKE' }]);
    assert.deepEqual(r.excluded_custom_audiences, [{ id: '902', name: 'NSW Converters 180d', subtype: 'WEBSITE' }]);
    assert.equal(r.optimization_goal, 'OFFSITE_CONVERSIONS');
    assert.equal(r.billing_event, 'IMPRESSIONS');
    assert.deepEqual(r.promoted_object, { pixel_id: 'px', custom_event_type: 'CONTACT' });
    assert.equal(r.daily_budget, 25);
    assert.deepEqual(r.campaign, { id: 'c1', name: 'NSW | Prospecting | November 2026', objective: 'OUTCOME_LEADS' });
    assert.equal(audienceLookups().length, 1);
});

test('create_meta_campaign dry run: placements from targeting_raw, existing creative shown', async () => {
    calls.length = 0;
    const r = await invoke('create_meta_campaign', {
        account_name: 'Synthetic Southwest', campaign_name: 'T', objective: 'OUTCOME_TRAFFIC', cbo: true, daily_budget: 10,
        ad_sets: [{
            name: 'S', optimization_goal: 'LANDING_PAGE_VIEWS',
            targeting: { countries: ['US'] },
            targeting_raw: { publisher_platforms: ['facebook'], facebook_positions: ['feed', 'story'], custom_audiences: [{ id: '903', name: 'Visitors' }] },
            ads: [{ name: 'A', creative_id: '777' }],
        }],
    });
    assert.ok(!calls.some(c => c.method === 'POST'), 'dry run must not POST');
    const s = r.planned.ad_sets[0];
    assert.match(s.targeting_summary, /placements: Manual: facebook \(feed, story\)/);
    assert.match(s.targeting_summary, /audiences: Visitors \(903\)/);
    assert.deepEqual(s.ads[0], { name: 'A', creative: 'existing creative 777', creative_id: '777' });
});

test('duplicate_meta_campaign objective override dry run plans a new campaign, no writes', async () => {
    calls.length = 0;
    const r = await invoke('duplicate_meta_campaign', {
        account_name: 'Synthetic Southwest', source_campaign: 'NSW | Prospecting | November 2026',
        objective: 'OUTCOME_TRAFFIC', optimization_goal: 'LANDING_PAGE_VIEWS', new_name: 'NSW | Traffic',
    });
    assert.ok(!calls.some(c => c.method === 'POST'));
    assert.equal(r.dry_run, true);
    assert.equal(r.new_campaign.objective, 'OUTCOME_TRAFFIC');
    assert.equal(r.source.objective, 'OUTCOME_LEADS');
    assert.deepEqual(r.ad_sets[0].optimization_goal, { from: 'OFFSITE_CONVERSIONS', to: 'LANDING_PAGE_VIEWS' });
    assert.deepEqual(r.objects_to_create, { campaigns: 1, ad_sets: 1, ads: 1 });
});

test('duplicate_meta_campaign objective override confirm: campaign + adset created fresh, ad copied', async () => {
    calls.length = 0;
    const r = await invoke('duplicate_meta_campaign', {
        account_name: 'Synthetic Southwest', source_campaign: 'NSW | Prospecting | November 2026',
        objective: 'OUTCOME_TRAFFIC', optimization_goal: 'LANDING_PAGE_VIEWS', new_name: 'NSW | Traffic', confirm: true,
    });
    const posts = calls.filter(c => c.method === 'POST');
    assert.deepEqual(posts.map(p => p.path.split('/').slice(2).join('/')), ['act_nsw/campaigns', 'act_nsw/adsets', 'ad1/copies']);
    assert.equal(posts[0].body.objective, 'OUTCOME_TRAFFIC');
    assert.equal(posts[1].body.campaign_id, 'new_act_nsw_campaigns');
    assert.equal(posts[1].body.optimization_goal, 'LANDING_PAGE_VIEWS');
    assert.equal(posts[2].body.adset_id, 'new_act_nsw_adsets');
    assert.equal(r.success, true);
});
