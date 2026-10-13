// Meta budget → outcome forecasting.
//
// Meta's delivery_estimate still returns audience size, but its
// daily_outcomes_curve has come back as a single all-zero point on every
// account and API version since at least Oct 2026. This module fills the gap
// with a modeled curve: local audience size from Meta + CPM / CTR / cost per
// result benchmarks from our own accounts' recent campaigns.
//
// Model (per daily budget B, per 30.4-day month):
//   impressions  I = B * 30.4 / CPM * 1000
//   frequency    F = max(F_floor, poisson frequency of I over audience A)
//                    F_floor = median 30-day frequency of benchmark campaigns,
//                    A = reachable share (default 50%) of the midpoint of
//                    Meta's monthly active audience range
//   reach          = I / F
//   efficiency     = F_floor / F   (1.0 until the audience saturates; past that
//                    results scale with reach, not impressions — conservative)
//   clicks         = I * CTR * efficiency
//   results        = traffic: clicks; awareness: reach;
//                    otherwise clicks * click→result rate (CVR), so results
//                    always square with the clicks shown. A cost_per_result
//                    override uses spend / cost * efficiency instead.
// Low / high use the benchmark p25 / p75 CTR (traffic) or CVR (results).

const DAYS_PER_MONTH = 30.4;
const DEFAULT_DAILY_BUDGETS = [5, 10, 20, 35, 50, 75, 100, 150, 200];
const DEFAULT_REACHABLE_SHARE = 0.5;

// optimization_goal → campaign objective whose history we benchmark against,
// and what counts as a "result".
const GOAL_FAMILIES = {
    LEAD_GENERATION:     { objective: 'OUTCOME_LEADS',     result: 'leads' },
    QUALITY_LEAD:        { objective: 'OUTCOME_LEADS',     result: 'leads' },
    OFFSITE_CONVERSIONS: { objective: 'OUTCOME_LEADS',     result: 'leads' },
    VALUE:               { objective: 'OUTCOME_SALES',     result: 'purchases' },
    LINK_CLICKS:         { objective: 'OUTCOME_TRAFFIC',   result: 'link_clicks' },
    LANDING_PAGE_VIEWS:  { objective: 'OUTCOME_TRAFFIC',   result: 'landing_page_views' },
    REACH:               { objective: 'OUTCOME_AWARENESS', result: 'reach' },
    IMPRESSIONS:         { objective: 'OUTCOME_AWARENESS', result: 'reach' },
    AD_RECALL_LIFT:      { objective: 'OUTCOME_AWARENESS', result: 'reach' },
    THRUPLAY:            { objective: 'OUTCOME_ENGAGEMENT', result: 'thruplays' },
};

function goalFamily(goal, objectiveOverride) {
    const fam = GOAL_FAMILIES[String(goal || 'LEAD_GENERATION').toUpperCase()] || GOAL_FAMILIES.LEAD_GENERATION;
    return objectiveOverride ? { ...fam, objective: objectiveOverride } : fam;
}

// Meta returns { data: { users_lower_bound, users_upper_bound } } today; older
// versions returned data[0].users. Accept both.
function parseReachEstimate(data) {
    const d = Array.isArray(data?.data) ? data.data[0] : (data?.data || data || {});
    const lower = d.users_lower_bound ?? d.users ?? null;
    const upper = d.users_upper_bound ?? d.users ?? null;
    return { lower, upper, estimate_ready: d.estimate_ready ?? null };
}

// delivery_estimate: audience bounds plus the (currently empty) curve.
// The curve is only reported as available when it carries real numbers.
function parseDeliveryEstimate(data) {
    const d = data?.data?.[0] || {};
    const curve = (d.daily_outcomes_curve || []).filter(p => p.spend > 0 || p.reach > 0 || p.impressions > 0);
    return {
        lower: d.estimate_mau_lower_bound ?? null,
        upper: d.estimate_mau_upper_bound ?? null,
        dau: d.estimate_dau || null,
        curve: curve.length > 1
            ? curve.map(p => ({ daily_spend: round(p.spend / 100, 2), reach: p.reach, impressions: p.impressions, actions: round(p.actions, 1) }))
            : null,
    };
}

const num = v => parseFloat(v || 0) || 0;
const actionVal = (actions, type) => num((actions || []).find(a => a.action_type === type)?.value);

function rowResults(row, resultType) {
    const a = row.actions;
    switch (resultType) {
        // "lead" already rolls up on-Facebook + pixel leads where both exist;
        // fall back to the pixel event for accounts that only report that.
        case 'leads':              return actionVal(a, 'lead') || actionVal(a, 'offsite_conversion.fb_pixel_lead') || actionVal(a, 'onsite_conversion.lead_grouped');
        case 'purchases':          return actionVal(a, 'purchase') || actionVal(a, 'offsite_conversion.fb_pixel_purchase');
        case 'link_clicks':        return num(row.inline_link_clicks);
        case 'landing_page_views': return actionVal(a, 'landing_page_view');
        case 'reach':              return num(row.reach);
        case 'thruplays':          return actionVal(a, 'video_thruplay_watched_actions') || actionVal(a, 'thruplay');
        default:                   return actionVal(a, resultType); // explicit action_type override
    }
}

function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function stats(values) {
    const s = values.filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    return s.length ? { p25: quantile(s, 0.25), median: quantile(s, 0.5), p75: quantile(s, 0.75), n: s.length } : null;
}

// rows: campaign × 30-day insight rows (each tagged with .account) already
// filtered to the target objective. Each row with enough spend is a sample.
function buildBenchmarks(rows, { resultType, minSpend = 50 }) {
    const samples = rows
        .map(r => ({
            account: r.account, campaign: r.campaign_name,
            spend: num(r.spend), impressions: num(r.impressions), reach: num(r.reach),
            frequency: num(r.frequency), link_clicks: num(r.inline_link_clicks),
            results: rowResults(r, resultType),
        }))
        .filter(s => s.spend >= minSpend && s.impressions > 0);
    // Samples with zero results usually mean the result event isn't tracked
    // on that campaign, not a 0% conversion rate — leave them out of CVR.
    const withResults = samples.filter(s => s.results > 0);
    const resultsByAccount = {};
    for (const s of withResults) resultsByAccount[s.account] = (resultsByAccount[s.account] || 0) + s.results;
    const totalResults = Object.values(resultsByAccount).reduce((t, v) => t + v, 0);
    const [topAccount, topResults] = Object.entries(resultsByAccount).sort((a, b) => b[1] - a[1])[0] || [];
    return {
        samples: samples.length,
        samples_with_results: withResults.length,
        accounts: [...new Set(samples.map(s => s.account))],
        campaigns: [...new Set(samples.map(s => `${s.account} — ${s.campaign}`))],
        total_spend: round(samples.reduce((t, s) => t + s.spend, 0), 2),
        cpm: stats(samples.map(s => s.spend / s.impressions * 1000)),
        ctr: stats(samples.map(s => s.link_clicks / s.impressions)),
        frequency_30d: stats(samples.map(s => s.frequency)),
        cost_per_result: stats(withResults.map(s => s.spend / s.results)),
        cvr: stats(withResults.filter(s => s.link_clicks > 0).map(s => s.results / s.link_clicks)),
        top_result_account: topAccount ? { account: topAccount, share: topResults / totalResults } : null,
    };
}

// Average frequency when I impressions land uniformly at random on A people.
function poissonFrequency(impressions, audience) {
    if (!audience || audience <= 0) return 1;
    const x = impressions / audience;
    if (x < 1e-9) return 1;
    return x / (1 - Math.exp(-x));
}

function round(v, d = 0) {
    if (v == null || !Number.isFinite(v)) return null;
    const m = 10 ** d;
    return Math.round(v * m) / m;
}

// Explicit overrides (cpm, ctr, cvr, cost_per_result, frequency_floor) replace
// the benchmark value for all three cases.
function resolveInputs(bench, overrides = {}) {
    const pick = (key, stat, field) => overrides[key] != null
        ? { low: overrides[key], mid: overrides[key], high: overrides[key], source: 'override' }
        : stat ? { low: stat[field[0]], mid: stat.median, high: stat[field[1]], source: 'benchmark' } : null;
    return {
        cpm: pick('cpm', bench?.cpm, ['p25', 'p75']),
        ctr: pick('ctr', bench?.ctr, ['p25', 'p75']),
        cvr: pick('cvr', bench?.cvr, ['p25', 'p75']),
        cost_per_result: overrides.cost_per_result != null ? pick('cost_per_result', null, []) : null,
        frequency_floor: overrides.frequency_floor ?? bench?.frequency_30d?.median ?? 1.5,
    };
}

function forecastCurve({ audience: rawAudience, dailyBudgets, inputs, resultType, reachableShare = DEFAULT_REACHABLE_SHARE }) {
    const audience = rawAudience ? rawAudience * reachableShare : null;
    const budgets = (dailyBudgets?.length ? dailyBudgets : DEFAULT_DAILY_BUDGETS).filter(b => b > 0).sort((a, b) => a - b);
    const warnings = [];
    if (!inputs.cpm) return { points: [], warnings: ['No CPM benchmark or override — cannot model impressions.'] };

    const fFloor = inputs.frequency_floor;
    const points = budgets.map(daily => {
        const spend = daily * DAYS_PER_MONTH;
        const impressions = spend / inputs.cpm.mid * 1000;
        const frequency = Math.max(fFloor, poissonFrequency(impressions, audience));
        const reach = audience ? Math.min(impressions / frequency, audience) : impressions / frequency;
        const efficiency = Math.min(1, fFloor / frequency);
        const clicks = inputs.ctr ? impressions * inputs.ctr.mid * efficiency : null;

        let results;
        if (resultType === 'reach') {
            results = { low: reach, mid: reach, high: reach };
        } else if (resultType === 'link_clicks' && inputs.ctr) {
            results = {
                low: impressions * inputs.ctr.low * efficiency,
                mid: clicks,
                high: impressions * inputs.ctr.high * efficiency,
            };
        } else if (inputs.cost_per_result) {
            const r = spend / inputs.cost_per_result.mid * efficiency;
            results = { low: r, mid: r, high: r };
        } else if (inputs.cvr && clicks != null) {
            results = { low: clicks * inputs.cvr.low, mid: clicks * inputs.cvr.mid, high: clicks * inputs.cvr.high };
        } else {
            results = null;
        }

        const saturation = efficiency >= 0.9 ? 'none' : efficiency >= 0.7 ? 'moderate' : 'heavy';
        return {
            daily_budget: daily,
            monthly_spend: round(spend, 0),
            monthly_impressions: round(impressions),
            monthly_reach: round(reach),
            reach_pct_of_audience: rawAudience ? round(reach / rawAudience * 100, 1) : null,
            frequency: round(frequency, 2),
            monthly_link_clicks: round(clicks),
            monthly_results: results && { low: round(results.low, 1), mid: round(results.mid, 1), high: round(results.high, 1) },
            effective_cost_per_result: results?.mid ? round(spend / results.mid, 2) : null,
            efficiency: round(efficiency, 2),
            saturation,
        };
    });

    const unsaturated = points.filter(p => p.saturation === 'none');
    const maxEfficientDaily = unsaturated.length ? unsaturated[unsaturated.length - 1].daily_budget : null;
    if (audience && points.some(p => p.saturation !== 'none')) {
        warnings.push(`Reachable audience (~${Math.round(audience).toLocaleString()} = ${Math.round(reachableShare * 100)}% of Meta's estimate) saturates above ~$${maxEfficientDaily ?? budgets[0]}/day — extra spend mostly buys frequency.`);
    }
    if (!inputs.cost_per_result && !inputs.cvr && !['reach', 'link_clicks'].includes(resultType)) {
        warnings.push('No conversion-rate benchmark (no matching campaigns with tracked results) — results omitted. Pass cvr or cost_per_result to model them.');
    }
    return { points, max_efficient_daily_budget: maxEfficientDaily, warnings };
}

module.exports = {
    GOAL_FAMILIES, DEFAULT_DAILY_BUDGETS, DEFAULT_REACHABLE_SHARE, DAYS_PER_MONTH,
    goalFamily, parseReachEstimate, parseDeliveryEstimate, rowResults,
    buildBenchmarks, resolveInputs, poissonFrequency, forecastCurve,
};
