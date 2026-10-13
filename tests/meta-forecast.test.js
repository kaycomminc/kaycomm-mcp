const test = require('node:test');
const assert = require('node:assert/strict');
const {
    goalFamily, parseReachEstimate, parseDeliveryEstimate, rowResults,
    buildBenchmarks, resolveInputs, poissonFrequency, forecastCurve,
} = require('../src/meta-forecast');

const row = (o = {}) => ({
    account: 'A', campaign_name: 'C', spend: '300', impressions: '10000', reach: '5000', frequency: '2',
    inline_link_clicks: '150', actions: [{ action_type: 'lead', value: '10' }], ...o,
});

test('parseReachEstimate: current users_lower/upper_bound shape', () => {
    const r = parseReachEstimate({ data: { users_lower_bound: 100, users_upper_bound: 200, estimate_ready: true } });
    assert.deepEqual(r, { lower: 100, upper: 200, estimate_ready: true });
});

test('parseReachEstimate: legacy data[0].users shape', () => {
    const r = parseReachEstimate({ data: [{ users: 500, estimate_ready: true }] });
    assert.equal(r.lower, 500);
    assert.equal(r.upper, 500);
});

test('parseDeliveryEstimate: all-zero single-point curve reports no curve', () => {
    const r = parseDeliveryEstimate({ data: [{ estimate_mau_lower_bound: 7100, estimate_mau_upper_bound: 8300, estimate_dau: 0,
        daily_outcomes_curve: [{ spend: 0, reach: 0, impressions: 0, actions: 0 }] }] });
    assert.equal(r.curve, null);
    assert.equal(r.lower, 7100);
    assert.equal(r.dau, null);
});

test('parseDeliveryEstimate: real curve converts spend from cents', () => {
    const r = parseDeliveryEstimate({ data: [{ daily_outcomes_curve: [
        { spend: 0, reach: 0, impressions: 0, actions: 0 },
        { spend: 1000, reach: 400, impressions: 600, actions: 2 },
        { spend: 2000, reach: 700, impressions: 1200, actions: 3.5 },
    ] }] });
    assert.deepEqual(r.curve[0], { daily_spend: 10, reach: 400, impressions: 600, actions: 2 });
    assert.equal(r.curve.length, 2);
});

test('goalFamily: maps goals to objectives and honours override', () => {
    assert.equal(goalFamily('LINK_CLICKS').objective, 'OUTCOME_TRAFFIC');
    assert.equal(goalFamily('reach').result, 'reach');
    assert.equal(goalFamily(undefined).objective, 'OUTCOME_LEADS');
    assert.equal(goalFamily('LEAD_GENERATION', 'OUTCOME_SALES').objective, 'OUTCOME_SALES');
});

test('rowResults: leads fall back to pixel lead; raw action_type override', () => {
    assert.equal(rowResults(row(), 'leads'), 10);
    assert.equal(rowResults(row({ actions: [{ action_type: 'offsite_conversion.fb_pixel_lead', value: '4' }] }), 'leads'), 4);
    assert.equal(rowResults(row({ actions: [{ action_type: 'offsite_conversion.fb_pixel_custom', value: '7' }] }), 'offsite_conversion.fb_pixel_custom'), 7);
    assert.equal(rowResults(row(), 'link_clicks'), 150);
});

test('buildBenchmarks: drops low-spend rows; zero-result rows excluded from CVR only', () => {
    const b = buildBenchmarks([
        row(),
        row({ account: 'B', actions: [] }),          // untracked: counts for CPM/CTR, not CVR
        row({ spend: '10' }),                        // below min spend
    ], { resultType: 'leads', minSpend: 50 });
    assert.equal(b.samples, 2);
    assert.equal(b.samples_with_results, 1);
    assert.equal(b.cpm.median, 30);
    assert.ok(Math.abs(b.cvr.median - 10 / 150) < 1e-9);
    assert.deepEqual(b.top_result_account, { account: 'A', share: 1 });
});

test('poissonFrequency: ~1 for tiny spend, grows past audience size', () => {
    assert.ok(Math.abs(poissonFrequency(10, 1e6) - 1) < 1e-3);
    assert.ok(poissonFrequency(3e6, 1e6) > 3);
});

test('resolveInputs: overrides replace benchmarks; frequency floor defaults', () => {
    const i = resolveInputs(null, { cpm: 12, ctr: 0.01 });
    assert.deepEqual(i.cpm, { low: 12, mid: 12, high: 12, source: 'override' });
    assert.equal(i.cvr, null);
    assert.equal(i.frequency_floor, 1.5);
});

test('forecastCurve: linear until saturation, then efficiency drops', () => {
    const inputs = resolveInputs(null, { cpm: 10, ctr: 0.01, cvr: 0.1, frequency_floor: 2 });
    const { points, max_efficient_daily_budget, warnings } = forecastCurve({
        audience: 20000, dailyBudgets: [5, 10, 100], inputs, resultType: 'leads', reachableShare: 0.5,
    });
    const [small, , big] = points;
    assert.equal(small.monthly_impressions, 15200);             // 5 * 30.4 / 10 * 1000
    assert.equal(small.frequency, 2);
    assert.equal(small.monthly_link_clicks, 152);
    assert.equal(small.monthly_results.mid, 15.2);
    assert.equal(small.saturation, 'none');
    assert.equal(big.saturation, 'heavy');
    assert.ok(big.monthly_reach <= 10000);                       // capped by reachable audience
    assert.ok(big.effective_cost_per_result > small.effective_cost_per_result);
    assert.equal(max_efficient_daily_budget, 5);
    assert.match(warnings[0], /saturates/);
});

test('forecastCurve: cost_per_result override replaces CVR model', () => {
    const inputs = resolveInputs(null, { cpm: 10, ctr: 0.01, cvr: 0.5, cost_per_result: 50, frequency_floor: 2 });
    const { points } = forecastCurve({ audience: 1e7, dailyBudgets: [50], inputs, resultType: 'leads' });
    assert.equal(points[0].monthly_results.mid, 30.4);           // 1520 / 50
});

test('forecastCurve: no CPM → no points', () => {
    const { points, warnings } = forecastCurve({ audience: 1000, inputs: resolveInputs(null), resultType: 'leads' });
    assert.equal(points.length, 0);
    assert.match(warnings[0], /CPM/);
});
