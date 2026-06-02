#!/usr/bin/env node
/**
 * KayComm Pacing MCP Server
 * Tools: get_google_pacing, get_meta_pacing, get_full_pacing,
 *        get_account_detail, get_search_terms
 */

const http    = require("http");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { SSEServerTransport }   = require("@modelcontextprotocol/sdk/server/sse.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

let fetchFn = globalThis.fetch;
if (!fetchFn) fetchFn = require("node-fetch");

// ── Credentials — loaded from environment variables ───────────────────────────
// Set these in Railway → Variables, and in claude_desktop_config.json env block for local use
const GOOGLE_DEVELOPER_TOKEN = process.env.GOOGLE_DEVELOPER_TOKEN;
const GOOGLE_CLIENT_ID       = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET   = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN   = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_API_VERSION     = "v20";

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_API_VERSION  = "v21.0";

// ── Google Accounts ───────────────────────────────────────────────────────────
// mcc = login-customer-id (managing MCC, or account itself if self-managed)
// nc_budget = if set, Boulevard Carroll NC sub-budget (excludes PMax)
const GOOGLE_ACCOUNTS = {
    "9547060400": { name: "Eye Associates of NF",   budget: 2500, mcc: "9547060400" },
    "5976116321": { name: "Nationwide Southwest",    budget: 1000, mcc: "7631184147" },
    "9694376492": { name: "Enzoic",                  budget: 1800, mcc: "9694376492" },
    "9040402786": { name: "Alderwood Psychological", budget: 650,  mcc: "7631184147" },
    "2908157845": { name: "Boulevard Carroll",       budget: 3500, mcc: "7631184147", nc_budget: 1000 },
    "8459391760": { name: "Outside The Breadbox",    budget: 375,  mcc: "7631184147" },
    "1481569045": { name: "Woca Woodcare",           budget: 2500, mcc: "7631184147" },
    "2696762909": { name: "Warrior Advocates",       budget: 300,  mcc: "8621281595", ga4: "14591178781" },
    "8184463966": { name: "Spartan Exteriors",       budget: 500,  mcc: "8184463966", budget_schedule: [{ from: "2026-06-01", budget: 2000 }] },
    "6631800329": { name: "Summit Express",          budget: 0,    mcc: "7631184147" },
    "2275371078": { name: "Childrens Therapy Services of Colorado", budget: 1000, mcc: "7631184147" },
};

// ── Meta Accounts ─────────────────────────────────────────────────────────────
const META_ACCOUNTS = {
    "act_287139600343581":  { name: "Nationwide Southwest", budget: 1000 },
    "act_6128243883951018": { name: "Warrior Advocates",    budget: 300  },
    "act_866700669704203":  { name: "Spartan Exteriors",    budget: 1000 },
    "act_482088457883195":  { name: "Summit Express",       budget: 0    },
    // Two flights: Revive Day $425 (May 25–Jun 4), Domestic Abuse Training $1,020 (May 25–Jun 5)
    "act_1527255801416040": { name: "Florida DOH Monroe County", budget: 1445, flight_end: "2026-06-05" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Resolve an account's budget (and nc_budget) for a given date, honoring an
// optional budget_schedule. Schedule entries: [{ from: "YYYY-MM-DD", budget, nc_budget? }]
// The latest entry whose `from` is on or before `today` wins; otherwise the base budget.
function getEffectiveBudget(info, today) {
    let budget    = info.budget;
    let ncBudget  = info.nc_budget;
    let effective = null;
    if (Array.isArray(info.budget_schedule)) {
        const applicable = info.budget_schedule
            .filter(s => s.from <= today)
            .sort((a, b) => a.from.localeCompare(b.from));
        for (const s of applicable) {
            if (s.budget    != null) budget   = s.budget;
            if (s.nc_budget != null) ncBudget = s.nc_budget;
            effective = s.from;
        }
    }
    return { budget, nc_budget: ncBudget, effective_from: effective };
}

function getPacingLabel(spent, budget, dom, dim) {
    if (!budget) return { status: "no_cap" };
    const expected    = budget * (dom / dim);
    const pctBudget   = Math.round((spent / budget) * 100 * 10) / 10;
    const pctExpected = expected > 0 ? Math.round((spent / expected) * 100 * 10) / 10 : 0;
    const remaining   = Math.round((budget - spent) * 100) / 100;
    const status      = pctExpected >= 105 ? "OVERPACING" : pctExpected <= 85 ? "UNDERPACING" : "ON PACE";
    return { status, pct_budget: pctBudget, pct_expected: pctExpected, remaining };
}

function getDateInfo() {
    const now  = new Date();
    const yday = new Date(now); yday.setDate(yday.getDate() - 1);
    const fmt  = d => d.toISOString().split("T")[0];
    const dim  = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const monthStart = fmt(new Date(now.getFullYear(), now.getMonth(), 1));
    return {
        today:      fmt(now),
        yesterday:  fmt(yday),
        month_start: monthStart,
        dom:        now.getDate(),         // actual calendar day (for display)
        pace_dom:   yday.getDate(),        // complete days elapsed (for pacing math)
        dim,
    };
}

// ── Google Auth ───────────────────────────────────────────────────────────────
let _googleToken = null;
let _googleTokenExpiry = 0;

async function getGoogleAccessToken() {
    if (_googleToken && Date.now() < _googleTokenExpiry) return { token: _googleToken, error: null };
    const resp = await fetchFn("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
            refresh_token: GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token",
        }),
    });
    const data = await resp.json();
    if (!data.access_token) return { token: null, error: data.error_description || JSON.stringify(data) };
    _googleToken = data.access_token;
    _googleTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return { token: _googleToken, error: null };
}

// ── Google Ads API ────────────────────────────────────────────────────────────
async function googleSearch(token, customerId, mccId, query) {
    const resp = await fetchFn(
        `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers/${customerId}/googleAds:search`,
        {
            method: "POST",
            headers: {
                "Authorization":       `Bearer ${token}`,
                "developer-token":     GOOGLE_DEVELOPER_TOKEN,
                "login-customer-id":   mccId,
                "Content-Type":        "application/json",
            },
            body: JSON.stringify({ query }),
        }
    );
    const data = await resp.json();
    if (!resp.ok) {
        const msg = data?.error?.details?.[0]?.errors?.[0]?.message || data?.error?.message || JSON.stringify(data);
        throw new Error(msg);
    }
    return data.results || [];
}

async function fetchGoogleMTD(token, customerId, mccId, monthStart, yesterday) {
    // Pull spend from 1st of month through yesterday (complete days only — excludes today's partial data)
    try {
        const rows = await googleSearch(token, customerId, mccId,
            `SELECT metrics.cost_micros FROM campaign WHERE segments.date BETWEEN '${monthStart}' AND '${yesterday}'`);
        const micros = rows.reduce((sum, r) => sum + parseInt(r?.metrics?.costMicros || 0), 0);
        return { spend: micros / 1_000_000, error: null };
    } catch (e) {
        return { spend: null, error: e.message };
    }
}

async function fetchGoogleMTDbyNC(token, customerId, mccId, monthStart, yesterday) {
    // Returns { nc, other } where nc = NC-tagged campaigns (no PMax), other = everything else incl PMax
    try {
        const rows = await googleSearch(token, customerId, mccId, `
            SELECT campaign.name, campaign.advertising_channel_type, metrics.cost_micros
            FROM campaign WHERE segments.date BETWEEN '${monthStart}' AND '${yesterday}'`);
        let nc = 0, other = 0;
        for (const row of rows) {
            const micros  = parseInt(row.metrics?.costMicros || 0);
            const isPmax  = row.campaign?.advertisingChannelType === "PERFORMANCE_MAX";
            const isNC    = row.campaign?.name?.toUpperCase().includes("NC") && !isPmax;
            if (isNC) nc += micros; else other += micros;
        }
        return { nc: nc / 1_000_000, other: other / 1_000_000, error: null };
    } catch (e) {
        return { nc: null, other: null, error: e.message };
    }
}

// ── Meta API ──────────────────────────────────────────────────────────────────
async function fetchMetaMTD(accountId, monthStart, yesterday) {
    // Pull spend from 1st of month through yesterday (complete days only)
    const params = new URLSearchParams({
        access_token: META_ACCESS_TOKEN,
        fields: "spend",
        time_range: JSON.stringify({ since: monthStart, until: yesterday }),
        level: "account",
    });
    const resp = await fetchFn(`https://graph.facebook.com/${META_API_VERSION}/${accountId}/insights?${params}`);
    const data = await resp.json();
    if (data.error) return { spend: null, error: data.error.message };
    const spend = data.data?.length ? parseFloat(data.data[0].spend || 0) : 0;
    return { spend, error: null };
}

// ── Row builders ──────────────────────────────────────────────────────────────
async function buildGoogleRows(token, pace_dom, dim, today, monthStart, yesterday) {
    const rows = [];
    for (const [cid, info] of Object.entries(GOOGLE_ACCOUNTS)) {
        const { budget, nc_budget } = getEffectiveBudget(info, today);
        if (nc_budget) {
            const { nc, other, error } = await fetchGoogleMTDbyNC(token, cid, info.mcc, monthStart, yesterday);
            if (error) { rows.push({ account: info.name, error }); continue; }
            const total       = nc + other;
            const ncBudget    = nc_budget;
            const otherBudget = budget - ncBudget;
            rows.push({
                account: info.name, mtd_spend: Math.round(total * 100) / 100,
                budget, ...getPacingLabel(total, budget, pace_dom, dim),
                breakdown: {
                    nc:    { spend: Math.round(nc * 100) / 100,    budget: ncBudget,    ...getPacingLabel(nc, ncBudget, pace_dom, dim) },
                    other: { spend: Math.round(other * 100) / 100, budget: otherBudget, ...getPacingLabel(other, otherBudget, pace_dom, dim) },
                },
            });
        } else {
            const { spend, error } = await fetchGoogleMTD(token, cid, info.mcc, monthStart, yesterday);
            if (error) { rows.push({ account: info.name, error }); continue; }
            rows.push({
                account: info.name, mtd_spend: Math.round(spend * 100) / 100,
                budget, ...getPacingLabel(spend, budget, pace_dom, dim),
            });
        }
    }
    return rows;
}

async function buildMetaRows(pace_dom, dim, today, monthStart, yesterday) {
    const rows = [];
    for (const [id, info] of Object.entries(META_ACCOUNTS)) {
        const { budget } = getEffectiveBudget(info, today);
        const { spend, error } = await fetchMetaMTD(id, monthStart, yesterday);
        if (error) { rows.push({ account: info.name, error }); continue; }
        rows.push({
            account: info.name, mtd_spend: Math.round(spend * 100) / 100,
            budget, ...getPacingLabel(spend, budget, pace_dom, dim),
        });
    }
    return rows;
}

// ── Negative keyword write ────────────────────────────────────────────────────
async function getCampaigns(token, customerId, mccId) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT campaign.id, campaign.name, campaign.status
        FROM campaign
        WHERE campaign.status != 'REMOVED'
        ORDER BY campaign.name`);
    return rows.map(r => ({
        id:           r.campaign.id,
        name:         r.campaign.name,
        status:       r.campaign.status,
        resourceName: `customers/${customerId}/campaigns/${r.campaign.id}`,
    }));
}

async function mutateNegativeKeywords(token, customerId, mccId, campaignResourceName, keywords, matchType) {
    const operations = keywords.map(kw => ({
        campaignCriterionOperation: {
            create: {
                campaign: campaignResourceName,
                negative: true,
                keyword: { text: kw.replace(/^["']|["']$/g, ""), matchType },
            },
        },
    }));

    const resp = await fetchFn(
        `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers/${customerId}/googleAds:mutate`,
        {
            method: "POST",
            headers: {
                "Authorization":     `Bearer ${token}`,
                "developer-token":   GOOGLE_DEVELOPER_TOKEN,
                "login-customer-id": mccId,
                "Content-Type":      "application/json",
            },
            body: JSON.stringify({ mutateOperations: operations }),
        }
    );
    const data = await resp.json();
    if (!resp.ok) {
        const msg = data?.error?.details?.[0]?.errors?.[0]?.message || data?.error?.message || JSON.stringify(data);
        throw new Error(msg);
    }
    return data.mutateOperationResponses || [];
}

// ── Meta write helpers ────────────────────────────────────────────────────────
async function metaDuplicate(id, level, newName, status = "PAUSED") {
    // Uses Meta's /copies endpoint to deep-copy a campaign or ad set
    const body = {
        access_token:  META_ACCESS_TOKEN,
        deep_copy:     true,
        status_option: status.toUpperCase(),
    };
    if (newName) {
        body.rename_options = { rename_prefix: "", rename_suffix: "" };
        // Meta's copies endpoint doesn't directly set the name, so we'll rename after
    }
    const resp = await fetchFn(
        `https://graph.facebook.com/${META_API_VERSION}/${id}/copies`,
        {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(body),
        }
    );
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);
    const newId = (data.copied_campaign_id || data.copied_adset_id || data.id);
    // Rename if a new name was provided
    if (newName && newId) {
        await fetchFn(
            `https://graph.facebook.com/${META_API_VERSION}/${newId}`,
            {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ access_token: META_ACCESS_TOKEN, name: newName }),
            }
        );
    }
    return { new_id: newId, new_name: newName || null };
}
async function metaGet(path, extraParams = {}) {
    const params = new URLSearchParams({ access_token: META_ACCESS_TOKEN, ...extraParams });
    const resp = await fetchFn(`https://graph.facebook.com/${META_API_VERSION}/${path}?${params}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);
    return data;
}

async function metaPost(path, body = {}) {
    const resp = await fetchFn(`https://graph.facebook.com/${META_API_VERSION}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: META_ACCESS_TOKEN, ...body }),
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);
    return data;
}

async function getMetaCampaigns(accountId) {
    const data = await metaGet(`${accountId}/campaigns`, {
        fields: "id,name,status,daily_budget,lifetime_budget,objective",
        limit: 100,
    });
    return (data.data || []).map(c => ({
        id: c.id, name: c.name, status: c.status,
        daily_budget:    c.daily_budget    ? parseFloat(c.daily_budget) / 100    : null,
        lifetime_budget: c.lifetime_budget ? parseFloat(c.lifetime_budget) / 100 : null,
        objective: c.objective,
        level: "campaign",
    }));
}

async function getMetaAdsets(accountId) {
    const data = await metaGet(`${accountId}/adsets`, {
        fields: "id,name,status,daily_budget,lifetime_budget,campaign_id,campaign{name}",
        limit: 200,
    });
    return (data.data || []).map(s => ({
        id: s.id, name: s.name, status: s.status,
        campaign: s.campaign?.name || s.campaign_id,
        daily_budget:    s.daily_budget    ? parseFloat(s.daily_budget) / 100    : null,
        lifetime_budget: s.lifetime_budget ? parseFloat(s.lifetime_budget) / 100 : null,
        level: "adset",
    }));
}

// ── Google Analytics 4 ───────────────────────────────────────────────────────
function getGA4DateRange(range) {
    const today = new Date();
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    switch (range) {
        case "THIS_MONTH":   return { startDate: fmt(new Date(today.getFullYear(), today.getMonth(), 1)), endDate: "today" };
        case "LAST_MONTH":   return { startDate: fmt(new Date(today.getFullYear(), today.getMonth()-1, 1)), endDate: fmt(new Date(today.getFullYear(), today.getMonth(), 0)) };
        case "LAST_7_DAYS":  return { startDate: "7daysAgo",  endDate: "yesterday" };
        case "LAST_30_DAYS": return { startDate: "30daysAgo", endDate: "yesterday" };
        case "LAST_90_DAYS": return { startDate: "90daysAgo", endDate: "yesterday" };
        default:             return { startDate: "30daysAgo", endDate: "yesterday" };
    }
}

const GA4_DIMENSION_MAP = {
    channel:       "sessionDefaultChannelGroup",
    source_medium: "sessionSourceMedium",
    landing_page:  "landingPagePlusQueryString",
    device:        "deviceCategory",
    date:          "date",
    campaign:      "sessionGoogleAdsCampaignName",
};

async function fetchGA4Report(token, propertyId, dateRange, breakdownBy = "channel") {
    const { startDate, endDate } = getGA4DateRange(dateRange);
    const dimensionName = GA4_DIMENSION_MAP[breakdownBy] || GA4_DIMENSION_MAP.channel;

    const body = {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: dimensionName }],
        metrics: [
            { name: "sessions" },
            { name: "totalUsers" },
            { name: "newUsers" },
            { name: "screenPageViews" },
            { name: "bounceRate" },
            { name: "averageSessionDuration" },
            { name: "engagementRate" },
            { name: "conversions" },
            { name: "totalRevenue" },
        ],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: 50,
    };

    const resp = await fetchFn(
        `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
        {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }
    );
    const data = await resp.json();
    if (!resp.ok) {
        const msg = data?.error?.message || JSON.stringify(data);
        if (msg.includes("insufficient authentication scopes")) {
            throw new Error("GA4 scope missing — the current OAuth token was generated for Google Ads only. A new refresh token with analytics.readonly scope is needed.");
        }
        throw new Error(msg);
    }

    const dimHeaders = (data.dimensionHeaders || []).map(h => h.name);
    const metHeaders = (data.metricHeaders  || []).map(h => h.name);
    const rows = (data.rows || []).map(row => {
        const r = {};
        (row.dimensionValues || []).forEach((v, i) => r[dimHeaders[i]] = v.value);
        (row.metricValues    || []).forEach((v, i) => r[metHeaders[i]]  = v.value);
        return r;
    });

    // Totals
    const totals = data.totals?.[0];
    let summary = null;
    if (totals) {
        const mv = totals.metricValues || [];
        summary = {
            sessions:          parseInt(mv[0]?.value || 0),
            total_users:       parseInt(mv[1]?.value || 0),
            new_users:         parseInt(mv[2]?.value || 0),
            pageviews:         parseInt(mv[3]?.value || 0),
            bounce_rate:       (parseFloat(mv[4]?.value || 0) * 100).toFixed(1) + "%",
            avg_session_dur:   Math.round(parseFloat(mv[5]?.value || 0)) + "s",
            engagement_rate:   (parseFloat(mv[6]?.value || 0) * 100).toFixed(1) + "%",
            conversions:       parseFloat(mv[7]?.value || 0),
            revenue:           parseFloat(mv[8]?.value || 0),
        };
    }

    // Format rows
    const formatted = rows.map(r => ({
        [breakdownBy]:    r[dimHeaders[0]],
        sessions:         parseInt(r.sessions || 0),
        users:            parseInt(r.totalUsers || 0),
        new_users:        parseInt(r.newUsers || 0),
        pageviews:        parseInt(r.screenPageViews || 0),
        bounce_rate:      (parseFloat(r.bounceRate || 0) * 100).toFixed(1) + "%",
        avg_duration:     Math.round(parseFloat(r.averageSessionDuration || 0)) + "s",
        engagement_rate:  (parseFloat(r.engagementRate || 0) * 100).toFixed(1) + "%",
        conversions:      parseFloat(r.conversions || 0),
        revenue:          parseFloat(r.totalRevenue || 0),
    }));

    return { summary, rows: formatted, date_range: { startDate, endDate } };
}

// ── Campaign performance ──────────────────────────────────────────────────────
async function fetchGoogleCampaignPerf(token, customerId, mccId, dateRange) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT campaign.name, campaign.status, campaign.advertising_channel_type,
               metrics.cost_micros, metrics.clicks, metrics.impressions,
               metrics.conversions, metrics.conversions_value,
               metrics.ctr, metrics.average_cpc, metrics.search_impression_share
        FROM campaign
        WHERE segments.date DURING ${dateRange}
          AND metrics.impressions > 0
        ORDER BY metrics.cost_micros DESC`);

    return rows.map(row => {
        const spend   = parseInt(row.metrics.costMicros || 0) / 1_000_000;
        const convs   = parseFloat(row.metrics.conversions || 0);
        const convVal = parseFloat(row.metrics.conversionsValue || 0);
        const cpa     = convs > 0 ? Math.round((spend / convs) * 100) / 100 : null;
        const roas    = spend > 0 && convVal > 0 ? Math.round((convVal / spend) * 100) / 100 : null;
        return {
            campaign:         row.campaign.name,
            status:           row.campaign.status,
            type:             row.campaign.advertisingChannelType,
            spend:            Math.round(spend * 100) / 100,
            clicks:           parseInt(row.metrics.clicks || 0),
            impressions:      parseInt(row.metrics.impressions || 0),
            ctr:              (parseFloat(row.metrics.ctr || 0) * 100).toFixed(2) + "%",
            avg_cpc:          "$" + (parseInt(row.metrics.averageCpc || 0) / 1_000_000).toFixed(2),
            conversions:      convs,
            conv_value:       Math.round(convVal * 100) / 100,
            cpa:              cpa ? "$" + cpa : null,
            roas:             roas,
            impression_share: row.metrics.searchImpressionShare || null,
        };
    });
}

async function fetchMetaCampaignPerf(accountId, datePreset) {
    const params = new URLSearchParams({
        access_token: META_ACCESS_TOKEN,
        fields: "campaign_name,spend,clicks,impressions,ctr,cpc,actions,cost_per_action_type,purchase_roas",
        date_preset: datePreset,
        level: "campaign",
        limit: 100,
    });
    const resp = await fetchFn(`https://graph.facebook.com/${META_API_VERSION}/${accountId}/insights?${params}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);

    return (data.data || []).map(row => {
        const actions   = row.actions || [];
        const leads     = parseFloat(actions.find(a => a.action_type === "lead")?.value || 0);
        const purchases = parseFloat(actions.find(a => a.action_type === "purchase")?.value || 0);
        const pixelLeads = parseFloat(actions.find(a => a.action_type === "offsite_conversion.fb_pixel_lead")?.value || 0);
        const convs     = leads + purchases + pixelLeads;
        const spend     = parseFloat(row.spend || 0);
        const roas      = row.purchase_roas?.[0]?.value ? parseFloat(row.purchase_roas[0].value) : null;
        const cpa       = convs > 0 ? Math.round((spend / convs) * 100) / 100 : null;
        return {
            campaign:    row.campaign_name,
            spend,
            clicks:      parseInt(row.clicks || 0),
            impressions: parseInt(row.impressions || 0),
            ctr:         parseFloat(row.ctr || 0).toFixed(2) + "%",
            avg_cpc:     "$" + parseFloat(row.cpc || 0).toFixed(2),
            leads,
            purchases,
            conversions: convs,
            cpa:         cpa ? "$" + cpa : null,
            roas,
        };
    });
}

// ── Recommendations ────────────────────────────────────────────────────────────
async function fetchGoogleRecommendations(token, customerId, mccId) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT recommendation.type, recommendation.impact, recommendation.resource_name,
               recommendation.campaign_budget_recommendation,
               recommendation.keyword_recommendation,
               recommendation.target_cpa_opt_in_recommendation,
               recommendation.target_roas_opt_in_recommendation,
               recommendation.maximize_conversions_opt_in_recommendation,
               recommendation.responsive_search_ad_recommendation,
               recommendation.move_unused_budget_recommendation
        FROM recommendation`);

    const grouped = {};
    for (const row of rows) {
        const type = row.recommendation.type;
        if (!grouped[type]) grouped[type] = [];

        const rec = { type };

        if (row.recommendation.campaignBudgetRecommendation) {
            const r = row.recommendation.campaignBudgetRecommendation;
            rec.current_budget     = r.currentBudgetAmountMicros ? parseInt(r.currentBudgetAmountMicros) / 1_000_000 : null;
            rec.recommended_budget = r.recommendedBudgetAmountMicros ? parseInt(r.recommendedBudgetAmountMicros) / 1_000_000 : null;
        }
        if (row.recommendation.keywordRecommendation) {
            const r = row.recommendation.keywordRecommendation;
            rec.keyword    = r.keyword?.text;
            rec.match_type = r.keyword?.matchType;
        }
        if (row.recommendation.targetCpaOptInRecommendation) {
            const r = row.recommendation.targetCpaOptInRecommendation;
            rec.recommended_cpa = r.recommendedTargetCpaMicros ? parseInt(r.recommendedTargetCpaMicros) / 1_000_000 : null;
        }
        if (row.recommendation.targetRoasOptInRecommendation) {
            const r = row.recommendation.targetRoasOptInRecommendation;
            rec.recommended_roas = r.recommendedTargetRoas || null;
        }
        if (row.recommendation.impact) {
            const base      = row.recommendation.impact.baseMetrics || {};
            const potential = row.recommendation.impact.potentialMetrics || {};
            rec.impact = {
                clicks_change:      (parseInt(potential.clicks || 0) - parseInt(base.clicks || 0)),
                conversions_change: (parseFloat(potential.conversions || 0) - parseFloat(base.conversions || 0)).toFixed(1),
            };
        }
        grouped[type].push(rec);
    }

    return Object.entries(grouped).map(([type, recs]) => ({
        type,
        count: recs.length,
        details: recs.slice(0, 5),
    }));
}

// ── Keyword performance ───────────────────────────────────────────────────────
async function fetchGoogleKeywordPerf(token, customerId, mccId, dateRange) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT campaign.name, ad_group.name,
               ad_group_criterion.keyword.text,
               ad_group_criterion.keyword.match_type,
               ad_group_criterion.quality_info.quality_score,
               ad_group_criterion.quality_info.search_predicted_ctr,
               ad_group_criterion.status,
               metrics.cost_micros, metrics.clicks, metrics.impressions,
               metrics.conversions, metrics.ctr, metrics.average_cpc,
               metrics.search_impression_share, metrics.search_top_impression_share
        FROM keyword_view
        WHERE segments.date DURING ${dateRange}
          AND metrics.impressions > 0
        ORDER BY metrics.cost_micros DESC
        LIMIT 200`);

    return rows.map(row => ({
        keyword:          row.adGroupCriterion.keyword.text,
        match_type:       row.adGroupCriterion.keyword.matchType,
        campaign:         row.campaign.name,
        ad_group:         row.adGroup.name,
        status:           row.adGroupCriterion.status,
        quality_score:    row.adGroupCriterion.qualityInfo?.qualityScore ?? null,
        predicted_ctr:    row.adGroupCriterion.qualityInfo?.searchPredictedCtr ?? null,
        spend:            Math.round(parseInt(row.metrics.costMicros || 0) / 1_000_000 * 100) / 100,
        clicks:           parseInt(row.metrics.clicks || 0),
        impressions:      parseInt(row.metrics.impressions || 0),
        ctr:              (parseFloat(row.metrics.ctr || 0) * 100).toFixed(2) + "%",
        avg_cpc:          "$" + (parseInt(row.metrics.averageCpc || 0) / 1_000_000).toFixed(2),
        conversions:      parseFloat(row.metrics.conversions || 0),
        impression_share: row.metrics.searchImpressionShare ?? null,
        top_is:           row.metrics.searchTopImpressionShare ?? null,
    }));
}

// ── Period comparison helpers ─────────────────────────────────────────────────
function getCompareDateRanges(comparison) {
    const today = new Date();
    const fmt = d => {
        const y   = d.getFullYear();
        const m   = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
    };
    const shift = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

    if (comparison === "this_month_vs_last_month") {
        const thisStart = new Date(today.getFullYear(), today.getMonth(), 1);
        const lastStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const lastEnd   = new Date(today.getFullYear(), today.getMonth(), 0);
        return {
            p1: { start: fmt(thisStart), end: fmt(shift(today, -1)), label: "This Month MTD" },
            p2: { start: fmt(lastStart), end: fmt(lastEnd),          label: "Last Month (Full)" },
        };
    }
    if (comparison === "last_7_days_vs_prior_7_days") {
        return {
            p1: { start: fmt(shift(today, -7)), end: fmt(shift(today, -1)), label: "Last 7 Days" },
            p2: { start: fmt(shift(today, -14)), end: fmt(shift(today, -8)), label: "Prior 7 Days" },
        };
    }
    if (comparison === "last_30_days_vs_prior_30_days") {
        return {
            p1: { start: fmt(shift(today, -30)), end: fmt(shift(today, -1)), label: "Last 30 Days" },
            p2: { start: fmt(shift(today, -60)), end: fmt(shift(today, -31)), label: "Prior 30 Days" },
        };
    }
    throw new Error(`Unknown comparison: ${comparison}`);
}

async function fetchGoogleMetricsForRange(token, customerId, mccId, startDate, endDate) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT metrics.cost_micros, metrics.clicks, metrics.impressions,
               metrics.conversions, metrics.conversions_value
        FROM campaign
        WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
          AND metrics.impressions > 0`);

    let spend = 0, clicks = 0, impressions = 0, conversions = 0, convValue = 0;
    for (const row of rows) {
        spend       += parseInt(row.metrics.costMicros || 0) / 1_000_000;
        clicks      += parseInt(row.metrics.clicks || 0);
        impressions += parseInt(row.metrics.impressions || 0);
        conversions += parseFloat(row.metrics.conversions || 0);
        convValue   += parseFloat(row.metrics.conversionsValue || 0);
    }
    const cpa  = conversions > 0 ? Math.round((spend / conversions) * 100) / 100 : null;
    const roas = spend > 0 && convValue > 0 ? Math.round((convValue / spend) * 100) / 100 : null;

    return {
        spend:       Math.round(spend * 100) / 100,
        clicks,
        impressions,
        ctr:         impressions > 0 ? (clicks / impressions * 100).toFixed(2) + "%" : "0%",
        avg_cpc:     clicks > 0 ? "$" + (spend / clicks).toFixed(2) : null,
        conversions: Math.round(conversions * 10) / 10,
        conv_value:  Math.round(convValue * 100) / 100,
        cpa,
        roas,
    };
}

async function fetchMetaMetricsForRange(accountId, startDate, endDate) {
    const params = new URLSearchParams({
        access_token: META_ACCESS_TOKEN,
        fields: "spend,clicks,impressions,ctr,cpc,actions,purchase_roas",
        time_range: JSON.stringify({ since: startDate, until: endDate }),
        level: "account",
    });
    const resp = await fetchFn(`https://graph.facebook.com/${META_API_VERSION}/${accountId}/insights?${params}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);

    const row     = data.data?.[0] || {};
    const actions = row.actions || [];
    const leads   = parseFloat(actions.find(a => a.action_type === "lead")?.value || 0);
    const purch   = parseFloat(actions.find(a => a.action_type === "purchase")?.value || 0);
    const convs   = leads + purch;
    const spend   = parseFloat(row.spend || 0);
    const roas    = row.purchase_roas?.[0]?.value ? parseFloat(row.purchase_roas[0].value) : null;
    const cpa     = convs > 0 ? Math.round((spend / convs) * 100) / 100 : null;

    return {
        spend,
        clicks:      parseInt(row.clicks || 0),
        impressions: parseInt(row.impressions || 0),
        ctr:         parseFloat(row.ctr || 0).toFixed(2) + "%",
        avg_cpc:     row.cpc ? "$" + parseFloat(row.cpc).toFixed(2) : null,
        conversions: convs,
        cpa,
        roas,
    };
}

function pctChange(current, prior) {
    if (prior == null || prior === 0) return current > 0 ? "new" : "—";
    const p = ((current - prior) / Math.abs(prior)) * 100;
    return (p >= 0 ? "+" : "") + p.toFixed(1) + "%";
}

// ── Search terms ──────────────────────────────────────────────────────────────
async function fetchSearchTerms(token, customerId, mccId, dateRange) {
    const campRows = await googleSearch(token, customerId, mccId, `
        SELECT campaign.name, ad_group.name,
               metrics.cost_micros, metrics.clicks, metrics.impressions,
               metrics.conversions, metrics.average_cpc, metrics.ctr
        FROM ad_group
        WHERE segments.date DURING ${dateRange} AND metrics.impressions > 0
        ORDER BY metrics.cost_micros DESC`);

    const termRows = await googleSearch(token, customerId, mccId, `
        SELECT search_term_view.search_term, search_term_view.status,
               campaign.name, metrics.cost_micros, metrics.clicks,
               metrics.impressions, metrics.conversions, metrics.ctr, metrics.average_cpc
        FROM search_term_view
        WHERE segments.date DURING ${dateRange} AND metrics.impressions > 0
        ORDER BY metrics.cost_micros DESC LIMIT 500`);

    const terms = termRows.map(row => ({
        term:        row.searchTermView.searchTerm,
        status:      row.searchTermView.status || "",
        campaign:    row.campaign.name,
        cost:        parseInt(row.metrics.costMicros || 0) / 1_000_000,
        clicks:      parseInt(row.metrics.clicks || 0),
        impressions: parseInt(row.metrics.impressions || 0),
        convs:       parseFloat(row.metrics.conversions || 0),
        ctr:         (parseFloat(row.metrics.ctr || 0) * 100).toFixed(1) + "%",
        avg_cpc:     (parseInt(row.metrics.averageCpc || 0) / 1_000_000).toFixed(2),
    }));

    const campaigns = campRows.map(row => ({
        campaign: row.campaign.name,
        ad_group: row.adGroup.name,
        cost:     (parseInt(row.metrics.costMicros || 0) / 1_000_000).toFixed(2),
        clicks:   parseInt(row.metrics.clicks || 0),
        ctr:      (parseFloat(row.metrics.ctr || 0) * 100).toFixed(1) + "%",
        avg_cpc:  (parseInt(row.metrics.averageCpc || 0) / 1_000_000).toFixed(2),
        convs:    parseFloat(row.metrics.conversions || 0),
    }));

    return {
        total_terms: terms.length,
        campaigns,
        wasted:    terms.filter(t => t.cost > 3 && t.convs === 0).slice(0, 25),
        converting: terms.filter(t => t.convs > 0),
        all_terms:  terms,
    };
}

// ── Keyword planning ──────────────────────────────────────────────────────────
function parseKwMetric(r, metricsKey = "keywordIdeaMetrics") {
    const m = r[metricsKey] || r.keywordMetrics || {};
    return {
        keyword:              r.text,
        avg_monthly_searches: parseInt(m.avgMonthlySearches || 0),
        competition:          m.competition || "UNKNOWN",
        competition_index:    parseInt(m.competitionIndex || 0),
        low_cpc:  m.lowTopOfPageBidMicros  ? parseFloat((parseInt(m.lowTopOfPageBidMicros)  / 1_000_000).toFixed(2)) : null,
        high_cpc: m.highTopOfPageBidMicros ? parseFloat((parseInt(m.highTopOfPageBidMicros) / 1_000_000).toFixed(2)) : null,
    };
}

async function callKeywordPlannerIdeas(token, customerId, mccId, seedKeywords, url) {
    let seed = {};
    if (url && seedKeywords.length) seed = { keywordAndUrlSeed: { keywords: seedKeywords, url } };
    else if (url)                    seed = { urlSeed: { url } };
    else                             seed = { keywordSeed: { keywords: seedKeywords } };

    const resp = await fetchFn(
        `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers/${customerId}:generateKeywordIdeas`,
        {
            method: "POST",
            headers: {
                "Authorization":     `Bearer ${token}`,
                "developer-token":   GOOGLE_DEVELOPER_TOKEN,
                "login-customer-id": mccId,
                "Content-Type":      "application/json",
            },
            body: JSON.stringify({
                ...seed,
                language:            "languageConstants/1000",
                keywordPlanNetwork:  "GOOGLE_SEARCH",
                includeAdultKeywords: false,
            }),
        }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || JSON.stringify(data));
    return (data.results || []).map(r => parseKwMetric(r));
}

// Keep old name for existing get_keyword_ideas tool
async function fetchKeywordIdeas(token, customerId, mccId, seedKeywords) {
    const results = await callKeywordPlannerIdeas(token, customerId, mccId, seedKeywords, null);
    return results.sort((a, b) => b.avg_monthly_searches - a.avg_monthly_searches);
}

async function fetchKeywordHistoricalMetrics(token, customerId, mccId, keywords, showTrend) {
    const resp = await fetchFn(
        `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers/${customerId}:generateKeywordHistoricalMetrics`,
        {
            method: "POST",
            headers: {
                "Authorization":     `Bearer ${token}`,
                "developer-token":   GOOGLE_DEVELOPER_TOKEN,
                "login-customer-id": mccId,
                "Content-Type":      "application/json",
            },
            body: JSON.stringify({
                keywords,
                language:           "languageConstants/1000",
                keywordPlanNetwork: "GOOGLE_SEARCH",
            }),
        }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || JSON.stringify(data));

    return (data.results || []).map(r => {
        const base = parseKwMetric(r, "keywordMetrics");
        if (showTrend) {
            base.monthly_trend = (r.keywordMetrics?.monthlySearchVolumes || [])
                .map(m => ({ year: m.year, month: m.month, searches: parseInt(m.monthlySearches || 0) }))
                .sort((a, b) => a.year !== b.year ? a.year - b.year : monthOrder(a.month) - monthOrder(b.month));
        }
        return base;
    });
}

function monthOrder(m) {
    return ["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE",
            "JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"].indexOf(m);
}

function clusterKeywords(kwMetrics) {
    const STOP = new Set(["a","an","the","in","on","at","for","to","of","and","or",
                          "near","me","my","best","top","local","cheap","free","how",
                          "what","where","is","are","get","find","hire","with","i","do"]);

    // Count word frequency across all keywords
    const freq = {};
    for (const kw of kwMetrics) {
        for (const w of kw.keyword.toLowerCase().split(/\s+/)) {
            if (!STOP.has(w) && w.length > 2) freq[w] = (freq[w] || 0) + 1;
        }
    }

    // Assign each keyword to the group of its most "distinctive" word
    // (appears in 2+ keywords but not ubiquitous)
    const sorted = [...kwMetrics].sort((a, b) => b.avg_monthly_searches - a.avg_monthly_searches);
    const groups = {};
    const assigned = new Set();

    for (const kw of sorted) {
        if (assigned.has(kw.keyword)) continue;
        const words = kw.keyword.toLowerCase().split(/\s+/)
            .filter(w => !STOP.has(w) && w.length > 2)
            .sort((a, b) => {
                const fa = freq[a] || 0, fb = freq[b] || 0;
                // Prefer words appearing in 2-50% of keywords (specific but shared)
                const sa = Math.abs(fa - kwMetrics.length * 0.3);
                const sb = Math.abs(fb - kwMetrics.length * 0.3);
                return sa - sb;
            });

        const groupKey = words[0] || "general";
        if (!groups[groupKey]) groups[groupKey] = [];

        for (const other of sorted) {
            if (!assigned.has(other.keyword) && other.keyword.toLowerCase().includes(groupKey)) {
                groups[groupKey].push(other);
                assigned.add(other.keyword);
            }
        }
    }

    // Catch anything unassigned
    for (const kw of sorted) {
        if (!assigned.has(kw.keyword)) {
            groups["general"] = groups["general"] || [];
            groups["general"].push(kw);
        }
    }

    return groups;
}

function recommendMatchType(kw) {
    if (kw.avg_monthly_searches >= 1000 && kw.competition_index >= 60) return "EXACT";
    if (kw.avg_monthly_searches >= 200)  return "PHRASE";
    return "BROAD";
}

function estimateMonthlyClicks(kw) {
    // Estimated CTR for positions 1-3 by competition level
    const ctrMap = { HIGH: 0.04, MEDIUM: 0.06, LOW: 0.08, UNKNOWN: 0.05 };
    const ctr = ctrMap[kw.competition] || 0.05;
    return Math.round(kw.avg_monthly_searches * ctr);
}

function estimateMonthlyCost(kw) {
    const clicks = estimateMonthlyClicks(kw);
    const midCpc = (kw.low_cpc && kw.high_cpc) ? (kw.low_cpc + kw.high_cpc) / 2 : (kw.high_cpc || kw.low_cpc || 2);
    return Math.round(clicks * midCpc * 100) / 100;
}

function inferNegatives(kwMetrics) {
    // Common modifiers that indicate wrong intent for service-based businesses
    const INTENT_NEGATIVES = ["free","diy","how to","yourself","salary","jobs","career",
                               "training","school","course","tutorial","wiki","reddit",
                               "forum","vs","review","reviews","cheap","used","wholesale",
                               "supply","supplies","store","shop","buy","amazon","ebay"];
    const found = new Set();
    for (const kw of kwMetrics) {
        for (const neg of INTENT_NEGATIVES) {
            if (kw.keyword.toLowerCase().includes(neg)) found.add(neg);
        }
    }
    return [...found];
}

// ── Campaign status + budget writes ──────────────────────────────────────────
async function listGoogleCampaignsFull(token, customerId, mccId) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
               campaign_budget.amount_micros, campaign.resource_name,
               metrics.cost_micros
        FROM campaign
        WHERE campaign.status != 'REMOVED'
          AND segments.date DURING THIS_MONTH
        ORDER BY metrics.cost_micros DESC`);
    return rows.map(r => ({
        id:           r.campaign.id,
        name:         r.campaign.name,
        status:       r.campaign.status,
        type:         r.campaign.advertisingChannelType,
        daily_budget: r.campaignBudget?.amountMicros ? "$" + (parseInt(r.campaignBudget.amountMicros) / 1_000_000).toFixed(2) : null,
        mtd_spend:    "$" + (parseInt(r.metrics.costMicros || 0) / 1_000_000).toFixed(2),
        resource_name: r.campaign.resourceName,
    }));
}

async function updateGoogleCampaignStatus(token, customerId, mccId, resourceName, status) {
    const resp = await fetchFn(
        `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers/${customerId}/googleAds:mutate`,
        {
            method: "POST",
            headers: {
                "Authorization":     `Bearer ${token}`,
                "developer-token":   GOOGLE_DEVELOPER_TOKEN,
                "login-customer-id": mccId,
                "Content-Type":      "application/json",
            },
            body: JSON.stringify({
                mutateOperations: [{
                    campaignOperation: {
                        update:     { resourceName, status },
                        updateMask: "status",
                    },
                }],
            }),
        }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || JSON.stringify(data));
    return data;
}

async function updateGoogleCampaignBudget(token, customerId, mccId, campaignResourceName, dailyBudgetDollars) {
    // Step 1: get the budget resource name for this campaign
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT campaign.campaign_budget
        FROM campaign
        WHERE campaign.resource_name = '${campaignResourceName}'`);
    const budgetResourceName = rows[0]?.campaign?.campaignBudget;
    if (!budgetResourceName) throw new Error("Could not find budget resource for campaign.");

    // Step 2: mutate the budget
    const resp = await fetchFn(
        `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers/${customerId}/googleAds:mutate`,
        {
            method: "POST",
            headers: {
                "Authorization":     `Bearer ${token}`,
                "developer-token":   GOOGLE_DEVELOPER_TOKEN,
                "login-customer-id": mccId,
                "Content-Type":      "application/json",
            },
            body: JSON.stringify({
                mutateOperations: [{
                    campaignBudgetOperation: {
                        update:     { resourceName: budgetResourceName, amountMicros: String(Math.round(dailyBudgetDollars * 1_000_000)) },
                        updateMask: "amount_micros",
                    },
                }],
            }),
        }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || JSON.stringify(data));
    return { budget_resource: budgetResourceName, new_daily_budget: "$" + dailyBudgetDollars.toFixed(2) };
}

// ── Account discovery ─────────────────────────────────────────────────────────

async function listAccessibleCustomers(token) {
    const resp = await fetchFn(
        `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers:listAccessibleCustomers`,
        {
            headers: {
                "Authorization":   `Bearer ${token}`,
                "developer-token": GOOGLE_DEVELOPER_TOKEN,
            },
        }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || JSON.stringify(data));
    // Returns resource names like "customers/1234567890"
    return (data.resourceNames || []).map(r => r.replace("customers/", ""));
}

async function listMCCChildren(token, mccId) {
    // Query customer_client at level 1 (direct children only)
    try {
        const rows = await googleSearch(token, mccId, mccId, `
            SELECT
                customer_client.id,
                customer_client.descriptive_name,
                customer_client.status,
                customer_client.manager,
                customer_client.level
            FROM customer_client
            WHERE customer_client.level = 1
              AND customer_client.status = 'ENABLED'`);
        return rows.map(r => ({
            id:      String(r.customerClient.id),
            name:    r.customerClient.descriptiveName || "(no name)",
            manager: !!r.customerClient.manager,
            mcc:     mccId,
        }));
    } catch (_) {
        return []; // Not an MCC or no access
    }
}

async function listMetaAdAccountsAll() {
    // Paginate through all accessible ad accounts
    let url = `https://graph.facebook.com/${META_API_VERSION}/me/adaccounts?fields=id,name,account_status&limit=200&access_token=${META_ACCESS_TOKEN}`;
    const accounts = [];
    while (url) {
        const resp = await fetchFn(url);
        const data = await resp.json();
        if (data.error) throw new Error(data.error.message);
        for (const a of (data.data || [])) {
            accounts.push({
                id:     a.id,
                name:   a.name,
                status: a.account_status === 1 ? "ACTIVE" : String(a.account_status),
            });
        }
        url = data.paging?.next || null;
    }
    return accounts;
}

async function getMetaBusinessAdAccountIds(businessId) {
    // Returns all ad account IDs (act_XXX) owned or managed by a business manager
    const ids = new Set();
    for (const edge of ["owned_ad_accounts", "client_ad_accounts"]) {
        try {
            let url = `https://graph.facebook.com/${META_API_VERSION}/${businessId}/${edge}?fields=id&limit=200&access_token=${META_ACCESS_TOKEN}`;
            while (url) {
                const resp = await fetchFn(url);
                const data = await resp.json();
                if (data.error) break;
                for (const a of (data.data || [])) ids.add(a.id);
                url = data.paging?.next || null;
            }
        } catch (_) {}
    }
    return ids;
}

async function getMetaAccountSpend(accountId) {
    // Returns spend in last 30 days for a single ad account (0 if no data)
    try {
        const resp = await fetchFn(
            `https://graph.facebook.com/${META_API_VERSION}/${accountId}/insights?fields=spend&date_preset=last_30_days&access_token=${META_ACCESS_TOKEN}`
        );
        const data = await resp.json();
        if (data.error) return 0;
        return parseFloat((data.data || [])[0]?.spend || 0);
    } catch (_) { return 0; }
}

async function batchMetaSpend(accountIds) {
    // Returns a Map of accountId -> spend using Meta batch API (50 per request)
    const spendMap = new Map();
    const BATCH_SIZE = 50;
    for (let i = 0; i < accountIds.length; i += BATCH_SIZE) {
        const chunk = accountIds.slice(i, i + BATCH_SIZE);
        const batch = chunk.map(id => ({
            method:       "GET",
            relative_url: `${id}/insights?fields=spend&date_preset=last_30_days`,
        }));
        try {
            const resp = await fetchFn(
                `https://graph.facebook.com/${META_API_VERSION}/?include_headers=false&access_token=${META_ACCESS_TOKEN}`,
                {
                    method:  "POST",
                    headers: { "Content-Type": "application/json" },
                    body:    JSON.stringify({ batch }),
                }
            );
            const results = await resp.json();
            if (!Array.isArray(results)) continue;
            for (let j = 0; j < results.length; j++) {
                const item = results[j];
                const id   = chunk[j];
                if (!item || item.code !== 200) { spendMap.set(id, 0); continue; }
                try {
                    const body  = JSON.parse(item.body);
                    const spend = parseFloat((body.data || [])[0]?.spend || 0);
                    spendMap.set(id, spend);
                } catch (_) { spendMap.set(id, 0); }
            }
        } catch (_) {
            for (const id of chunk) spendMap.set(id, 0);
        }
    }
    return spendMap;
}

async function getGoogleAccountName(token, customerId) {
    // Direct lookup for self-managed accounts with no MCC parent
    try {
        const resp = await fetchFn(
            `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers/${customerId}`,
            {
                headers: {
                    "Authorization":     `Bearer ${token}`,
                    "developer-token":   GOOGLE_DEVELOPER_TOKEN,
                    "login-customer-id": customerId,
                },
            }
        );
        const data = await resp.json();
        if (!resp.ok) return null;
        return data.descriptiveName || data.id || null;
    } catch (_) { return null; }
}

async function getGoogleAccountSpend(token, customerId, mccId) {
    // Returns MTD spend for a single Google Ads account (0 if error)
    try {
        const rows = await googleSearch(token, customerId, mccId, `
            SELECT metrics.cost_micros
            FROM customer
            WHERE segments.date DURING LAST_30_DAYS`);
        const total = rows.reduce((s, r) => s + parseInt(r.metrics?.costMicros || 0), 0);
        return total / 1_000_000;
    } catch (_) { return 0; }
}

function googleAdsError(data) {
    return data?.error?.details?.[0]?.errors?.[0]?.message
        || data?.error?.message
        || JSON.stringify(data);
}

function extractPolicyViolationKeys(data) {
    // Pull PolicyViolationKey objects from a Google Ads error response for retry with exemptions
    // err.details is an object (not array) with shape { policyViolationDetails: { key: {...} } }
    const keys = [];
    const details = data?.error?.details || [];
    for (const detail of Array.isArray(details) ? details : []) {
        for (const err of (detail.errors || [])) {
            const pvKey = err.details?.policyViolationDetails?.key;
            if (pvKey) keys.push(pvKey);
        }
    }
    return keys;
}

async function addKeywordsToAdGroup(token, customerId, mccId, adGroupResourceName, keywords) {
    // Use service-level adGroupCriteria:mutate endpoint
    // Auto-retries with policy exemption keys for healthcare/restricted keyword categories
    const makeOps = (exemptKeys = []) => keywords.map(kw => ({
        create: {
            adGroup: adGroupResourceName,
            status:  "ENABLED",
            keyword: { text: kw.text, matchType: (kw.match_type || "EXACT").toUpperCase() },
        },
        ...(exemptKeys.length ? { exemptPolicyViolationKeys: exemptKeys } : {}),
    }));

    const doRequest = async (ops) => {
        const resp = await fetchFn(
            `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers/${customerId}/adGroupCriteria:mutate`,
            {
                method: "POST",
                headers: {
                    "Authorization":     `Bearer ${token}`,
                    "developer-token":   GOOGLE_DEVELOPER_TOKEN,
                    "login-customer-id": mccId,
                    "Content-Type":      "application/json",
                },
                body: JSON.stringify({ operations: ops }),
            }
        );
        return { resp, data: await resp.json() };
    };

    // First attempt
    let { resp, data } = await doRequest(makeOps());
    if (!resp.ok) {
        const policyKeys = extractPolicyViolationKeys(data);
        if (policyKeys.length) {
            // Retry with exemptions for already-approved policy violations
            ({ resp, data } = await doRequest(makeOps(policyKeys)));
        }
        if (!resp.ok) throw new Error(googleAdsError(data));
    }
    return (data.results || []).map(r => r.resourceName).filter(Boolean);
}

async function addRSAToAdGroup(token, customerId, mccId, adGroupResourceName, headlines, descriptions, finalUrl) {
    // Use service-level adGroupAds:mutate endpoint
    const resp = await fetchFn(
        `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers/${customerId}/adGroupAds:mutate`,
        {
            method: "POST",
            headers: {
                "Authorization":     `Bearer ${token}`,
                "developer-token":   GOOGLE_DEVELOPER_TOKEN,
                "login-customer-id": mccId,
                "Content-Type":      "application/json",
            },
            body: JSON.stringify({
                operations: [{
                    create: {
                        adGroup: adGroupResourceName,
                        status:  "ENABLED",
                        ad: {
                            finalUrls: [finalUrl],
                            responsiveSearchAd: {
                                headlines:    headlines.map(h => ({ text: h.text, ...(h.pinned_field ? { pinnedField: h.pinned_field } : {}) })),
                                descriptions: descriptions.map(d => ({ text: d.text, ...(d.pinned_field ? { pinnedField: d.pinned_field } : {}) })),
                            },
                        },
                    },
                }],
            }),
        }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(googleAdsError(data));
    return (data.results || [])[0]?.resourceName;
}

async function createAdGroupInCampaign(token, customerId, mccId, campaignResourceName, config) {
    // config: { name, status, keywords:[{text, match_type}], headlines:[{text,pinned_field?}], descriptions:[{text,pinned_field?}], final_url }
    // Creates ad group first, then keywords and RSA in separate calls (more reliable than one big batch)
    const status = (config.status || "PAUSED").toUpperCase();

    // Step 1: Create the ad group via service endpoint
    const agResp = await fetchFn(
        `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers/${customerId}/adGroups:mutate`,
        {
            method: "POST",
            headers: {
                "Authorization":     `Bearer ${token}`,
                "developer-token":   GOOGLE_DEVELOPER_TOKEN,
                "login-customer-id": mccId,
                "Content-Type":      "application/json",
            },
            body: JSON.stringify({
                operations: [{ create: { name: config.name, campaign: campaignResourceName, status } }],
            }),
        }
    );
    const agData = await agResp.json();
    if (!agResp.ok) throw new Error(googleAdsError(agData));
    const agResource = agData.results?.[0]?.resourceName;
    if (!agResource) throw new Error("Ad group created but no resource name returned");

    // Step 2: Add keywords (separate call with real resource name)
    let kwResults = [];
    if (config.keywords?.length) {
        kwResults = await addKeywordsToAdGroup(token, customerId, mccId, agResource, config.keywords);
    }

    // Step 3: Add RSA if provided (requires final_url)
    let adResource = null;
    if (config.headlines?.length >= 3 && config.descriptions?.length >= 2 && config.final_url) {
        adResource = await addRSAToAdGroup(token, customerId, mccId, agResource, config.headlines, config.descriptions, config.final_url);
    }

    return {
        ad_group_resource: agResource,
        keywords_created:  kwResults.length,
        ad_created:        !!adResource,
        ad_resource:       adResource,
    };
}

// ── Write helpers: bidding, campaign create, RSA update, extensions ──────────

function buildBiddingUpdateBody(strategy, options = {}) {
    const s = strategy.toUpperCase();
    if (s === "MANUAL_CPC") {
        return { campaignFields: { manualCpc: {} }, updateMask: "manual_cpc" };
    } else if (s === "ENHANCED_CPC") {
        return { campaignFields: { manualCpc: { enhancedCpcEnabled: true } }, updateMask: "manual_cpc,manual_cpc.enhanced_cpc_enabled" };
    } else if (s === "MAXIMIZE_CLICKS") {
        const mc = {};
        if (options.cpc_bid_ceiling) mc.cpcBidCeilingMicros = String(Math.round(options.cpc_bid_ceiling * 1_000_000));
        return {
            campaignFields: { maximizeClicks: mc },
            updateMask: options.cpc_bid_ceiling ? "maximize_clicks,maximize_clicks.cpc_bid_ceiling_micros" : "maximize_clicks",
        };
    } else if (s === "MAXIMIZE_CONVERSIONS") {
        return { campaignFields: { maximizeConversions: {} }, updateMask: "maximize_conversions" };
    } else if (s === "TARGET_CPA") {
        if (!options.target_cpa) throw new Error("target_cpa (dollars) is required for TARGET_CPA strategy");
        return {
            campaignFields: { targetCpa: { targetCpaMicros: String(Math.round(options.target_cpa * 1_000_000)) } },
            updateMask: "target_cpa,target_cpa.target_cpa_micros",
        };
    } else if (s === "TARGET_ROAS") {
        if (!options.target_roas) throw new Error("target_roas is required for TARGET_ROAS strategy (e.g. 3.0 = 300% ROAS)");
        return {
            campaignFields: { targetRoas: { targetRoas: options.target_roas } },
            updateMask: "target_roas,target_roas.target_roas",
        };
    } else {
        throw new Error(`Unknown strategy: ${strategy}. Valid: MANUAL_CPC, ENHANCED_CPC, MAXIMIZE_CLICKS, MAXIMIZE_CONVERSIONS, TARGET_CPA, TARGET_ROAS`);
    }
}

async function setBiddingStrategy(token, customerId, mccId, campaignResourceName, strategy, options = {}) {
    const { campaignFields, updateMask } = buildBiddingUpdateBody(strategy, options);
    const resp = await fetchFn(
        `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers/${customerId}/googleAds:mutate`,
        {
            method: "POST",
            headers: {
                "Authorization":     `Bearer ${token}`,
                "developer-token":   GOOGLE_DEVELOPER_TOKEN,
                "login-customer-id": mccId,
                "Content-Type":      "application/json",
            },
            body: JSON.stringify({
                mutateOperations: [{
                    campaignOperation: {
                        update:     { resourceName: campaignResourceName, ...campaignFields },
                        updateMask,
                    },
                }],
            }),
        }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || JSON.stringify(data));
    return data;
}

async function createGoogleCampaignFull(token, customerId, mccId, config) {
    // config: { campaign_name, daily_budget, campaign_type, bidding_strategy, ad_groups: [{name, keywords:[{text,match_type}]}] }
    const type = (config.campaign_type || "SEARCH").toUpperCase();
    const mutateOperations = [];

    // Op 0: Budget
    const budgetTempName   = `customers/${customerId}/campaignBudgets/-1`;
    const campaignTempName = `customers/${customerId}/campaigns/-2`;
    mutateOperations.push({
        campaignBudgetOperation: {
            create: {
                resourceName:   budgetTempName,
                name:           `${config.campaign_name} Budget`,
                amountMicros:   String(Math.round(config.daily_budget * 1_000_000)),
                deliveryMethod: "STANDARD",
            },
        },
    });

    // Op 1: Campaign
    const strategy = (config.bidding_strategy || "MANUAL_CPC").toUpperCase();
    let biddingFields = {};
    try { biddingFields = buildBiddingUpdateBody(strategy, config).campaignFields; } catch (_) { biddingFields = { manualCpc: {} }; }
    mutateOperations.push({
        campaignOperation: {
            create: {
                resourceName:            campaignTempName,
                name:                    config.campaign_name,
                status:                  "PAUSED",
                advertisingChannelType:  type,
                campaignBudget:          budgetTempName,
                networkSettings: {
                    targetGoogleSearch:  true,
                    targetSearchNetwork: true,
                    targetContentNetwork: false,
                },
                ...biddingFields,
            },
        },
    });

    // Ops 2+: Ad Groups + Keywords
    let adGroupCounter = -3;
    for (const ag of (config.ad_groups || [])) {
        const agTempName = `customers/${customerId}/adGroups/${adGroupCounter}`;
        adGroupCounter--;
        mutateOperations.push({
            adGroupOperation: {
                create: {
                    resourceName: agTempName,
                    name:         ag.name,
                    campaign:     campaignTempName,
                    status:       "ENABLED",
                },
            },
        });
        for (const kw of (ag.keywords || [])) {
            mutateOperations.push({
                adGroupCriterionOperation: {
                    create: {
                        adGroup: agTempName,
                        keyword: { text: kw.text, matchType: (kw.match_type || "BROAD").toUpperCase() },
                        status:  "ENABLED",
                    },
                },
            });
        }
    }

    const resp = await fetchFn(
        `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers/${customerId}/googleAds:mutate`,
        {
            method: "POST",
            headers: {
                "Authorization":     `Bearer ${token}`,
                "developer-token":   GOOGLE_DEVELOPER_TOKEN,
                "login-customer-id": mccId,
                "Content-Type":      "application/json",
            },
            body: JSON.stringify({ mutateOperations }),
        }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || JSON.stringify(data));

    const results = data.mutateOperationResponses || [];
    return {
        campaign_resource: results[1]?.campaignResult?.resourceName,
        budget_resource:   results[0]?.campaignBudgetResult?.resourceName,
        total_ops:         mutateOperations.length,
        results_count:     results.length,
    };
}

async function getAdGroupAds(token, customerId, mccId, campaignSearch, adGroupSearch) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT
            ad_group_ad.ad.resource_name,
            ad_group_ad.ad.responsive_search_ad.headlines,
            ad_group_ad.ad.responsive_search_ad.descriptions,
            ad_group.name,
            campaign.name
        FROM ad_group_ad
        WHERE ad_group_ad.status != 'REMOVED'
          AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'`);
    let filtered = rows;
    if (campaignSearch) filtered = filtered.filter(r => r.campaign.name.toLowerCase().includes(campaignSearch.toLowerCase()));
    if (adGroupSearch)  filtered = filtered.filter(r => r.adGroup.name.toLowerCase().includes(adGroupSearch.toLowerCase()));
    return filtered.map(r => ({
        resource_name: r.adGroupAd.ad.resourceName,
        campaign:      r.campaign.name,
        ad_group:      r.adGroup.name,
        headlines:     (r.adGroupAd.ad.responsiveSearchAd?.headlines || []).map(h => ({ text: h.text, pinned: h.pinnedField || null })),
        descriptions:  (r.adGroupAd.ad.responsiveSearchAd?.descriptions || []).map(d => ({ text: d.text, pinned: d.pinnedField || null })),
    }));
}

async function updateRSA(token, customerId, mccId, adResourceName, headlines, descriptions) {
    // headlines / descriptions: [{text, pinned_field?}]  pinned_field = "HEADLINE_1" | "HEADLINE_2" | "HEADLINE_3" | "DESCRIPTION_1" | "DESCRIPTION_2"
    const headlineObjs = headlines.map(h => ({ text: h.text, ...(h.pinned_field ? { pinnedField: h.pinned_field } : {}) }));
    const descObjs     = descriptions.map(d => ({ text: d.text, ...(d.pinned_field ? { pinnedField: d.pinned_field } : {}) }));
    const resp = await fetchFn(
        `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers/${customerId}/googleAds:mutate`,
        {
            method: "POST",
            headers: {
                "Authorization":     `Bearer ${token}`,
                "developer-token":   GOOGLE_DEVELOPER_TOKEN,
                "login-customer-id": mccId,
                "Content-Type":      "application/json",
            },
            body: JSON.stringify({
                mutateOperations: [{
                    adGroupAdOperation: {
                        update: {
                            resourceName: adResourceName,
                            ad: {
                                responsiveSearchAd: { headlines: headlineObjs, descriptions: descObjs },
                            },
                        },
                        updateMask: "ad.responsive_search_ad.headlines,ad.responsive_search_ad.descriptions",
                    },
                }],
            }),
        }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || JSON.stringify(data));
    return data;
}

async function addCampaignExtensions(token, customerId, mccId, campaignResourceName, extensionType, assets) {
    // extensionType: SITELINK | CALLOUT | STRUCTURED_SNIPPET
    // SITELINK assets: [{link_text, description1, description2, url}]
    // CALLOUT assets: [{text}]
    // STRUCTURED_SNIPPET assets: [{header, values:[]}]
    const mutateOperations = [];
    const assetTempNames   = [];

    for (let i = 0; i < assets.length; i++) {
        const tempName = `customers/${customerId}/assets/${-(i + 1)}`;
        assetTempNames.push(tempName);
        let assetCreate = { resourceName: tempName };

        if (extensionType === "SITELINK") {
            assetCreate.sitelinkAsset = {
                linkText:     assets[i].link_text,
                description1: assets[i].description1 || "",
                description2: assets[i].description2 || "",
            };
            if (assets[i].url) assetCreate.finalUrls = [assets[i].url];
        } else if (extensionType === "CALLOUT") {
            assetCreate.calloutAsset = { calloutText: assets[i].text };
        } else if (extensionType === "STRUCTURED_SNIPPET") {
            assetCreate.structuredSnippetAsset = { header: assets[i].header, values: assets[i].values || [] };
        }
        mutateOperations.push({ assetOperation: { create: assetCreate } });
    }

    // Link assets to campaign
    const fieldTypeMap = { SITELINK: "SITELINK", CALLOUT: "CALLOUT", STRUCTURED_SNIPPET: "STRUCTURED_SNIPPET" };
    for (const tempName of assetTempNames) {
        mutateOperations.push({
            campaignAssetOperation: {
                create: {
                    campaign:  campaignResourceName,
                    asset:     tempName,
                    fieldType: fieldTypeMap[extensionType] || extensionType,
                },
            },
        });
    }

    const resp = await fetchFn(
        `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers/${customerId}/googleAds:mutate`,
        {
            method: "POST",
            headers: {
                "Authorization":     `Bearer ${token}`,
                "developer-token":   GOOGLE_DEVELOPER_TOKEN,
                "login-customer-id": mccId,
                "Content-Type":      "application/json",
            },
            body: JSON.stringify({ mutateOperations }),
        }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || JSON.stringify(data));

    const results       = data.mutateOperationResponses || [];
    const assetResults  = results.slice(0, assets.length).map(r => r.assetResult?.resourceName).filter(Boolean);
    const linkResults   = results.slice(assets.length).map(r => r.campaignAssetResult?.resourceName).filter(Boolean);
    return { assets_created: assetResults.length, links_created: linkResults.length, asset_resources: assetResults };
}

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new Server(
    { name: "kaycomm-pacing", version: "2.0.0" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "get_google_pacing",
            description: "Pull Google Ads MTD spend and pacing for all client accounts, including Boulevard Carroll NC/non-NC breakdown.",
            inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
            name: "get_meta_pacing",
            description: "Pull Meta Ads MTD spend and pacing for all client accounts.",
            inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
            name: "get_full_pacing",
            description: "Pull Google Ads AND Meta MTD spend and pacing for all accounts in one report.",
            inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
            name: "get_account_detail",
            description: "Get MTD spend detail across Google and Meta for a specific client by name.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name to look up (partial match ok)" },
                },
                required: ["account_name"],
            },
        },
        {
            name: "get_search_terms",
            description: "Analyze Google Ads search term performance for an account — wasted spend, converting terms, campaign breakdown. Use to find negative keyword opportunities.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    date_range: {
                        type: "string",
                        description: "THIS_MONTH (default), LAST_30_DAYS, LAST_90_DAYS, LAST_MONTH",
                        enum: ["THIS_MONTH", "LAST_30_DAYS", "LAST_90_DAYS", "LAST_MONTH"],
                    },
                },
                required: ["account_name"],
            },
        },
        {
            name: "get_analytics_report",
            description: "Pull Google Analytics 4 website traffic and conversion data for a client. " +
                "Break down by channel (Organic, Paid Search, Direct, Social etc.), source/medium, landing page, device, date trend, or GA campaign. " +
                "Returns sessions, users, bounce rate, engagement rate, avg session duration, conversions, revenue.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok). Only clients with GA4 configured will work." },
                    date_range: {
                        type: "string",
                        description: "THIS_MONTH (default), LAST_7_DAYS, LAST_30_DAYS, LAST_90_DAYS, LAST_MONTH",
                        enum: ["THIS_MONTH", "LAST_7_DAYS", "LAST_30_DAYS", "LAST_90_DAYS", "LAST_MONTH"],
                    },
                    breakdown: {
                        type: "string",
                        description: "channel (default) | source_medium | landing_page | device | date | campaign",
                        enum: ["channel", "source_medium", "landing_page", "device", "date", "campaign"],
                    },
                },
                required: ["account_name"],
            },
        },
        {
            name: "get_campaign_performance",
            description: "Pull full campaign-level performance metrics — spend, clicks, impressions, CTR, CPC, conversions, CPA, ROAS — for Google Ads and/or Meta accounts. Better than get_google_pacing for optimization analysis.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    platform: {
                        type: "string",
                        description: "google (default), meta, or both",
                        enum: ["google", "meta", "both"],
                    },
                    date_range: {
                        type: "string",
                        description: "THIS_MONTH (default), LAST_30_DAYS, LAST_90_DAYS, LAST_MONTH, LAST_7_DAYS",
                        enum: ["THIS_MONTH", "LAST_30_DAYS", "LAST_90_DAYS", "LAST_MONTH", "LAST_7_DAYS"],
                    },
                },
                required: ["account_name"],
            },
        },
        {
            name: "get_recommendations",
            description: "Pull Google Ads automated optimization recommendations for an account — budget suggestions, keyword ideas, bidding strategy changes, ad improvements.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                },
                required: ["account_name"],
            },
        },
        {
            name: "get_keyword_performance",
            description: "Pull keyword-level metrics including Quality Score, impression share, CPC, CTR, and conversions for a Google Ads account. Use to find low QS keywords, impression share loss, and bidding issues.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    date_range: {
                        type: "string",
                        description: "THIS_MONTH (default), LAST_30_DAYS, LAST_90_DAYS, LAST_MONTH",
                        enum: ["THIS_MONTH", "LAST_30_DAYS", "LAST_90_DAYS", "LAST_MONTH"],
                    },
                    filter: {
                        type: "string",
                        description: "Optional filter: low_quality_score (QS ≤ 4), low_impression_share (IS < 50%), converting (has conversions), non_converting (0 conversions, >$5 spend)",
                        enum: ["low_quality_score", "low_impression_share", "converting", "non_converting"],
                    },
                },
                required: ["account_name"],
            },
        },
        {
            name: "compare_periods",
            description: "Compare performance metrics across two time periods for an account — this month vs last, last 7 days vs prior 7, or last 30 days vs prior 30. Shows % change for spend, clicks, CPC, conversions, CPA, ROAS.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    comparison: {
                        type: "string",
                        description: "this_month_vs_last_month | last_7_days_vs_prior_7_days | last_30_days_vs_prior_30_days",
                        enum: ["this_month_vs_last_month", "last_7_days_vs_prior_7_days", "last_30_days_vs_prior_30_days"],
                    },
                    platform: {
                        type: "string",
                        description: "google (default), meta, or both",
                        enum: ["google", "meta", "both"],
                    },
                },
                required: ["account_name", "comparison"],
            },
        },
        {
            name: "manage_meta",
            description: "View and manage Meta Ads campaigns and ad sets — list, pause, resume, update budgets, or duplicate. " +
                "Dry run by default. Set confirm=true to apply changes. " +
                "Actions: list_campaigns, list_adsets, pause, resume, set_daily_budget, duplicate.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Meta account name (partial match ok)" },
                    action: {
                        type: "string",
                        description: "list_campaigns | list_adsets | pause | resume | set_daily_budget | duplicate",
                        enum: ["list_campaigns", "list_adsets", "pause", "resume", "set_daily_budget", "duplicate"],
                    },
                    target: { type: "string", description: "Campaign or ad set name to target (partial match ok). Required for pause/resume/set_daily_budget/duplicate." },
                    level: {
                        type: "string",
                        description: "Whether target is a campaign or adset (default: campaign for duplicate, adset for others)",
                        enum: ["campaign", "adset"],
                    },
                    new_name: { type: "string", description: "Name for the duplicated campaign or ad set. Optional for duplicate — defaults to 'Copy of [original name]'." },
                    status:   { type: "string", enum: ["PAUSED", "ACTIVE", "INHERITED_FROM_SOURCE"], description: "Status for the duplicate (default: PAUSED)." },
                    budget: { type: "number", description: "New daily budget in dollars. Required for set_daily_budget." },
                    confirm: { type: "boolean", description: "Set true to apply changes. Omit for dry-run preview." },
                },
                required: ["account_name", "action"],
            },
        },
        {
            name: "list_campaigns",
            description: "List all campaigns and their status, daily budget, and MTD spend for a client. Works on Google and/or Meta. Use before pause/enable/update_budget to find exact campaign names.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    platform: { type: "string", enum: ["google", "meta", "both"], description: "google (default), meta, or both" },
                },
                required: ["account_name"],
            },
        },
        {
            name: "keyword_research",
            description: "Research keywords for a new campaign using Google Keyword Planner. " +
                "Accepts seed keywords and/or a competitor/client URL. " +
                "Returns ideas grouped by theme with volume, competition, and CPC range. " +
                "Filter by minimum volume or competition level. Use this first when planning a new campaign.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:    { type: "string", description: "Client account to run the research under (partial match ok)" },
                    seed_keywords:   { type: "array", items: { type: "string" }, description: "Seed keywords (1-10). Can be omitted if url is provided." },
                    url:             { type: "string", description: "Optional competitor or client website URL to pull keyword ideas from (e.g. 'https://competitor.com')" },
                    min_volume:      { type: "number", description: "Filter out keywords with fewer avg monthly searches than this (e.g. 100)" },
                    competition:     { type: "string", enum: ["LOW", "MEDIUM", "HIGH"], description: "Filter to only show this competition level. Omit for all." },
                    max_cpc:         { type: "number", description: "Filter out keywords with high-end CPC estimate above this dollar amount." },
                },
                required: ["account_name"],
            },
        },
        {
            name: "keyword_metrics",
            description: "Get exact historical search volume, competition score, and CPC estimates for a specific list of keywords. " +
                "Optionally includes month-by-month trend for the past 12 months. " +
                "Use after keyword_research to validate specific keywords before building a campaign.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:  { type: "string", description: "Client account to run the query under (partial match ok)" },
                    keywords:      { type: "array", items: { type: "string" }, description: "Exact keywords to get metrics for (up to 20)" },
                    show_trend:    { type: "boolean", description: "Include month-by-month search volume for the past 12 months (default false)" },
                },
                required: ["account_name", "keywords"],
            },
        },
        {
            name: "build_campaign_plan",
            description: "Full campaign planning tool. Takes a list of keywords, fetches their metrics, clusters them into ad groups, " +
                "assigns match types, estimates monthly clicks and spend, and flags negative keyword opportunities. " +
                "Returns a ready-to-implement campaign structure. Use after keyword_research to go from idea to plan.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:  { type: "string", description: "Client account (partial match ok)" },
                    campaign_name: { type: "string", description: "Name for the planned campaign" },
                    keywords:      { type: "array", items: { type: "string" }, description: "Keywords to plan around (up to 50)" },
                    daily_budget:  { type: "number", description: "Planned daily budget in dollars — used to show spend coverage estimates" },
                },
                required: ["account_name", "campaign_name", "keywords"],
            },
        },
        {
            name: "get_keyword_ideas",
            description: "Generate keyword ideas with search volume, competition level, and CPC range estimates from Google Ads Keyword Planner. Use for research before building new campaigns or expanding existing ones.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client account to run the query under (partial match ok)" },
                    keywords: {
                        type: "array",
                        items: { type: "string" },
                        description: "Seed keywords to generate ideas from (1-10 keywords)",
                    },
                },
                required: ["account_name", "keywords"],
            },
        },
        {
            name: "pause_campaign",
            description: "Pause a Google Ads or Meta campaign. Dry run by default — set confirm=true to apply. Use list_campaigns first to confirm the exact campaign name.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:  { type: "string", description: "Client name (partial match ok)" },
                    campaign_name: { type: "string", description: "Campaign name (partial match ok)" },
                    platform:      { type: "string", enum: ["google", "meta"], description: "google (default) or meta" },
                    confirm:       { type: "boolean", description: "Set true to actually pause. Omit for dry run." },
                },
                required: ["account_name", "campaign_name"],
            },
        },
        {
            name: "enable_campaign",
            description: "Re-enable a paused Google Ads or Meta campaign. Dry run by default — set confirm=true to apply.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:  { type: "string", description: "Client name (partial match ok)" },
                    campaign_name: { type: "string", description: "Campaign name (partial match ok)" },
                    platform:      { type: "string", enum: ["google", "meta"], description: "google (default) or meta" },
                    confirm:       { type: "boolean", description: "Set true to actually enable. Omit for dry run." },
                },
                required: ["account_name", "campaign_name"],
            },
        },
        {
            name: "update_budget",
            description: "Update the daily budget for a Google Ads campaign or Meta campaign/ad set. Dry run by default — set confirm=true to apply. Google budgets are daily amounts; Meta budgets are also daily in dollars.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:  { type: "string", description: "Client name (partial match ok)" },
                    campaign_name: { type: "string", description: "Campaign name (partial match ok)" },
                    daily_budget:  { type: "number", description: "New daily budget in dollars" },
                    platform:      { type: "string", enum: ["google", "meta"], description: "google (default) or meta" },
                    confirm:       { type: "boolean", description: "Set true to apply. Omit for dry run." },
                },
                required: ["account_name", "campaign_name", "daily_budget"],
            },
        },
        {
            name: "sync_accounts",
            description: "Discover all Google Ads and Meta ad accounts you have access to and compare against what's currently tracked. " +
                "Filters out accounts under specified Meta business managers. " +
                "Checks spend in the last 30 days and skips accounts with zero activity. " +
                "Returns only new active accounts ready to be added.",
            inputSchema: {
                type: "object",
                properties: {
                    platform: {
                        type: "string",
                        enum: ["google", "meta", "both"],
                        description: "Which platform to scan (default: both)",
                    },
                    exclude_business_ids: {
                        type: "array",
                        items: { type: "string" },
                        description: "Meta Business Manager IDs to exclude (all their ad accounts will be filtered out)",
                    },
                    check_spend: {
                        type: "boolean",
                        description: "Check last 30 days spend and skip accounts with $0 activity (default: true)",
                    },
                },
                required: [],
            },
        },
        {
            name: "create_ad_group",
            description: "Create a new ad group inside an existing Google Ads campaign. " +
                "Adds keywords and optionally an RSA in the same batch. " +
                "Status defaults to PAUSED for review before launch. " +
                "Dry run by default — set confirm=true to create.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:   { type: "string", description: "Client name (partial match ok)" },
                    campaign_name:  { type: "string", description: "Existing campaign name (partial match ok)" },
                    ad_group_name:  { type: "string", description: "Name for the new ad group" },
                    status:         { type: "string", enum: ["PAUSED", "ENABLED"], description: "Ad group status (default: PAUSED)" },
                    keywords: {
                        type: "array",
                        description: "Keywords to add to the ad group",
                        items: {
                            type: "object",
                            properties: {
                                text:       { type: "string" },
                                match_type: { type: "string", enum: ["EXACT", "PHRASE", "BROAD"] },
                            },
                            required: ["text"],
                        },
                    },
                    headlines: {
                        type: "array",
                        description: "RSA headlines (3–15, max 30 chars each). Omit to skip creating an ad.",
                        items: {
                            type: "object",
                            properties: {
                                text:         { type: "string" },
                                pinned_field: { type: "string", enum: ["HEADLINE_1", "HEADLINE_2", "HEADLINE_3"] },
                            },
                            required: ["text"],
                        },
                    },
                    descriptions: {
                        type: "array",
                        description: "RSA descriptions (2–4, max 90 chars each). Required if headlines provided.",
                        items: {
                            type: "object",
                            properties: {
                                text:         { type: "string" },
                                pinned_field: { type: "string", enum: ["DESCRIPTION_1", "DESCRIPTION_2"] },
                            },
                            required: ["text"],
                        },
                    },
                    final_url:  { type: "string", description: "Final URL for the RSA (required if headlines/descriptions provided)" },
                    confirm: { type: "boolean", description: "Set true to create. Omit for dry run." },
                },
                required: ["account_name", "campaign_name", "ad_group_name"],
            },
        },
        {
            name: "populate_ad_group",
            description: "Add keywords and/or an RSA to an existing Google Ads ad group using its resource name. " +
                "Use after create_ad_group to finish setting up an ad group. Dry run by default — set confirm=true to apply.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:     { type: "string", description: "Client name (partial match ok)" },
                    ad_group_resource: { type: "string", description: "Full ad group resource name (e.g. customers/123/adGroups/456)" },
                    keywords: {
                        type: "array",
                        description: "Keywords to add",
                        items: {
                            type: "object",
                            properties: {
                                text:       { type: "string" },
                                match_type: { type: "string", enum: ["EXACT", "PHRASE", "BROAD"] },
                            },
                            required: ["text"],
                        },
                    },
                    headlines: {
                        type: "array",
                        description: "RSA headlines (3–15, max 30 chars each)",
                        items: {
                            type: "object",
                            properties: {
                                text:         { type: "string" },
                                pinned_field: { type: "string", enum: ["HEADLINE_1", "HEADLINE_2", "HEADLINE_3"] },
                            },
                            required: ["text"],
                        },
                    },
                    descriptions: {
                        type: "array",
                        description: "RSA descriptions (2–4, max 90 chars each)",
                        items: {
                            type: "object",
                            properties: {
                                text:         { type: "string" },
                                pinned_field: { type: "string", enum: ["DESCRIPTION_1", "DESCRIPTION_2"] },
                            },
                            required: ["text"],
                        },
                    },
                    final_url: { type: "string", description: "Final URL for the RSA (required if providing headlines)" },
                    confirm:   { type: "boolean", description: "Set true to apply. Omit for dry run." },
                },
                required: ["account_name", "ad_group_resource"],
            },
        },
        {
            name: "get_budget_overview",
            description: "Pull daily and lifetime budgets for all campaigns across all tracked Google Ads and Meta accounts. Shows which campaigns use daily vs lifetime budgets and current amounts.",
            inputSchema: {
                type: "object",
                properties: {
                    platform: { type: "string", enum: ["google", "meta", "both"], description: "Platform to pull (default: both)" },
                    account_name: { type: "string", description: "Filter to a specific account (partial match ok). Omit for all accounts." },
                    active_only: { type: "boolean", description: "Only show enabled/active campaigns (default: false)" },
                },
                required: [],
            },
        },
        {
            name: "set_bidding_strategy",
            description: "Change the bidding strategy on a Google Ads campaign. Supports MANUAL_CPC, ENHANCED_CPC, MAXIMIZE_CLICKS, MAXIMIZE_CONVERSIONS, TARGET_CPA, TARGET_ROAS. Dry run by default — set confirm=true to apply.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:     { type: "string", description: "Client name (partial match ok)" },
                    campaign_name:    { type: "string", description: "Campaign name (partial match ok)" },
                    strategy:         { type: "string", enum: ["MANUAL_CPC","ENHANCED_CPC","MAXIMIZE_CLICKS","MAXIMIZE_CONVERSIONS","TARGET_CPA","TARGET_ROAS"], description: "Bidding strategy to apply" },
                    target_cpa:       { type: "number", description: "Target CPA in dollars — required for TARGET_CPA strategy" },
                    target_roas:      { type: "number", description: "Target ROAS as a multiplier — required for TARGET_ROAS (e.g. 3.0 = 300%)" },
                    cpc_bid_ceiling:  { type: "number", description: "Optional max CPC ceiling in dollars — for MAXIMIZE_CLICKS only" },
                    confirm:          { type: "boolean", description: "Set true to apply. Omit for dry run." },
                },
                required: ["account_name", "campaign_name", "strategy"],
            },
        },
        {
            name: "create_campaign",
            description: "Create a new Google Ads Search campaign with ad groups and keywords in one step. " +
                "Campaign is created in PAUSED status for review before launch. " +
                "Use build_campaign_plan first to design the structure, then pass the result here. " +
                "Dry run by default — set confirm=true to build it.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:      { type: "string", description: "Client name (partial match ok)" },
                    campaign_name:     { type: "string", description: "Name for the new campaign" },
                    daily_budget:      { type: "number", description: "Daily budget in dollars" },
                    campaign_type:     { type: "string", enum: ["SEARCH","DISPLAY","SHOPPING"], description: "Campaign type (default: SEARCH)" },
                    bidding_strategy:  { type: "string", enum: ["MANUAL_CPC","ENHANCED_CPC","MAXIMIZE_CLICKS","MAXIMIZE_CONVERSIONS","TARGET_CPA","TARGET_ROAS"], description: "Bidding strategy (default: MANUAL_CPC)" },
                    ad_groups: {
                        type: "array",
                        description: "Ad groups to create",
                        items: {
                            type: "object",
                            properties: {
                                name:     { type: "string", description: "Ad group name" },
                                keywords: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            text:       { type: "string" },
                                            match_type: { type: "string", enum: ["EXACT","PHRASE","BROAD"] },
                                        },
                                        required: ["text"],
                                    },
                                },
                            },
                            required: ["name"],
                        },
                    },
                    confirm: { type: "boolean", description: "Set true to actually create. Omit for dry run." },
                },
                required: ["account_name", "campaign_name", "daily_budget", "ad_groups"],
            },
        },
        {
            name: "update_ad_copy",
            description: "View or update responsive search ad (RSA) headlines and descriptions in a Google Ads ad group. " +
                "Omit headlines/descriptions to preview current copy. Provide new copy to replace it. " +
                "Dry run by default — set confirm=true to apply. Google requires 3–15 headlines and 2–4 descriptions.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:  { type: "string", description: "Client name (partial match ok)" },
                    campaign_name: { type: "string", description: "Campaign name (partial match ok)" },
                    ad_group_name: { type: "string", description: "Ad group name (partial match ok). Omit to search entire campaign." },
                    headlines: {
                        type: "array",
                        description: "New headlines (3–15 required). Each up to 30 chars.",
                        items: {
                            type: "object",
                            properties: {
                                text:         { type: "string", description: "Headline text (max 30 chars)" },
                                pinned_field: { type: "string", enum: ["HEADLINE_1","HEADLINE_2","HEADLINE_3"], description: "Optional: pin to position" },
                            },
                            required: ["text"],
                        },
                    },
                    descriptions: {
                        type: "array",
                        description: "New descriptions (2–4 required). Each up to 90 chars.",
                        items: {
                            type: "object",
                            properties: {
                                text:         { type: "string", description: "Description text (max 90 chars)" },
                                pinned_field: { type: "string", enum: ["DESCRIPTION_1","DESCRIPTION_2"], description: "Optional: pin to position" },
                            },
                            required: ["text"],
                        },
                    },
                    confirm: { type: "boolean", description: "Set true to apply changes. Omit for dry run / preview." },
                },
                required: ["account_name", "campaign_name"],
            },
        },
        {
            name: "add_ad_extension",
            description: "Add sitelinks, callouts, or structured snippets to a Google Ads campaign. " +
                "Dry run by default — set confirm=true to apply. " +
                "Sitelinks: link_text, description1, description2, url. " +
                "Callouts: text (25 char max). " +
                "Structured snippets: header + values list.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:   { type: "string", description: "Client name (partial match ok)" },
                    campaign_name:  { type: "string", description: "Campaign name (partial match ok)" },
                    extension_type: { type: "string", enum: ["SITELINK","CALLOUT","STRUCTURED_SNIPPET"], description: "Type of extension to add" },
                    assets: {
                        type: "array",
                        description: "Extensions to add. For SITELINK: {link_text, description1, description2, url}. For CALLOUT: {text}. For STRUCTURED_SNIPPET: {header, values:[]}.",
                        items: { type: "object" },
                    },
                    confirm: { type: "boolean", description: "Set true to apply. Omit for dry run." },
                },
                required: ["account_name", "campaign_name", "extension_type", "assets"],
            },
        },
        {
            name: "add_negative_keywords",
            description: "Add campaign-level negative keywords to a Google Ads account. " +
                "By default runs as a DRY RUN (preview only). Set confirm=true to actually write to the account. " +
                "If campaign_name is omitted, returns a list of available campaigns to choose from.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    campaign_name: { type: "string", description: "Campaign name (partial match ok). Omit to list campaigns." },
                    keywords: {
                        type: "array",
                        items: { type: "string" },
                        description: "Keywords to add as negatives. Quotes around phrase-match terms are stripped automatically.",
                    },
                    match_type: {
                        type: "string",
                        description: "EXACT (default), PHRASE, or BROAD",
                        enum: ["EXACT", "PHRASE", "BROAD"],
                    },
                    confirm: {
                        type: "boolean",
                        description: "Set true to actually write changes. Omit or false for dry-run preview only.",
                    },
                },
                required: ["account_name", "keywords"],
            },
        },
    ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const { today, yesterday, month_start, dom, pace_dom, dim } = getDateInfo();
    let result;

    if (name === "get_google_pacing") {
        const { token, error } = await getGoogleAccessToken();
        if (error) return { content: [{ type: "text", text: JSON.stringify({ error: `Auth failed: ${error}` }) }] };
        result = { date: today, spend_through: yesterday, day: dom, days_in_month: dim, platform: "Google Ads", accounts: await buildGoogleRows(token, pace_dom, dim, today, month_start, yesterday) };

    } else if (name === "get_meta_pacing") {
        result = { date: today, spend_through: yesterday, day: dom, days_in_month: dim, platform: "Meta", accounts: await buildMetaRows(pace_dom, dim, today, month_start, yesterday) };

    } else if (name === "get_full_pacing") {
        const { token, error } = await getGoogleAccessToken();
        const googleRows = error ? [{ error: `Auth failed: ${error}` }] : await buildGoogleRows(token, pace_dom, dim, today, month_start, yesterday);
        result = { date: today, spend_through: yesterday, day: dom, days_in_month: dim, google: googleRows, meta: await buildMetaRows(pace_dom, dim, today, month_start, yesterday) };

    } else if (name === "get_account_detail") {
        const search = (args.account_name || "").toLowerCase();
        const results = [];

        // Meta
        for (const [id, info] of Object.entries(META_ACCOUNTS)) {
            if (info.name.toLowerCase().includes(search)) {
                const { budget } = getEffectiveBudget(info, today);
                const { spend, error } = await fetchMetaMTD(id, month_start, yesterday);
                if (error) results.push({ platform: "Meta", account: info.name, error });
                else results.push({ platform: "Meta", account: info.name,
                    mtd_spend: Math.round(spend * 100) / 100, budget,
                    ...getPacingLabel(spend, budget, pace_dom, dim) });
            }
        }

        // Google
        const { token } = await getGoogleAccessToken();
        if (token) {
            for (const [cid, info] of Object.entries(GOOGLE_ACCOUNTS)) {
                if (info.name.toLowerCase().includes(search)) {
                    const { budget } = getEffectiveBudget(info, today);
                    const { spend, error } = await fetchGoogleMTD(token, cid, info.mcc, month_start, yesterday);
                    if (error) results.push({ platform: "Google", account: info.name, error });
                    else results.push({ platform: "Google", account: info.name,
                        mtd_spend: Math.round(spend * 100) / 100, budget,
                        ...getPacingLabel(spend, budget, pace_dom, dim) });
                }
            }
        }

        result = results.length
            ? { date: today, spend_through: yesterday, day: dom, days_in_month: dim, results }
            : { error: `No account found matching '${args.account_name}'` };

    } else if (name === "get_search_terms") {
        const search    = (args.account_name || "").toLowerCase();
        const dateRange = args.date_range || "THIS_MONTH";
        const match     = Object.entries(GOOGLE_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account found matching '${args.account_name}'` };
        } else {
            const [cid, info] = match;
            const { token, error } = await getGoogleAccessToken();
            if (error) { result = { error: `Auth failed: ${error}` }; }
            else {
                try {
                    result = { account: info.name, date_range: dateRange, ...(await fetchSearchTerms(token, cid, info.mcc, dateRange)) };
                } catch (e) {
                    result = { error: e.message };
                }
            }
        }

    } else if (name === "list_campaigns") {
        const search   = (args.account_name || "").toLowerCase();
        const platform = args.platform || "google";
        result = { account: args.account_name };

        if (platform === "google" || platform === "both") {
            const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) { result.google_error = `No Google account matching '${args.account_name}'`; }
            else {
                const [cid, info] = match;
                const { token, error: authErr } = await getGoogleAccessToken();
                if (authErr) { result.google_error = authErr; }
                else {
                    try { result.google = { account: info.name, campaigns: await listGoogleCampaignsFull(token, cid, info.mcc) }; }
                    catch (e) { result.google_error = e.message; }
                }
            }
        }

        if (platform === "meta" || platform === "both") {
            const match = Object.entries(META_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) { result.meta_error = `No Meta account matching '${args.account_name}'`; }
            else {
                const [accountId, info] = match;
                try {
                    const campaigns = await getMetaCampaigns(accountId);
                    result.meta = { account: info.name, campaigns };
                } catch (e) { result.meta_error = e.message; }
            }
        }

    } else if (name === "keyword_research") {
        const search   = (args.account_name || "").toLowerCase();
        const seeds    = args.seed_keywords || [];
        const url      = args.url || null;
        const minVol   = args.min_volume   || 0;
        const maxCpc   = args.max_cpc      || null;
        const compFilt = args.competition  || null;

        if (!seeds.length && !url) {
            result = { error: "Provide at least one seed_keyword or a url." };
        } else {
            const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) { result = { error: `No Google account matching '${args.account_name}'` }; }
            else {
                const [cid, info] = match;
                const { token, error: authErr } = await getGoogleAccessToken();
                if (authErr) { result = { error: `Auth: ${authErr}` }; }
                else {
                    try {
                        let ideas = await callKeywordPlannerIdeas(token, cid, info.mcc, seeds, url);

                        // Apply filters
                        if (minVol)   ideas = ideas.filter(k => k.avg_monthly_searches >= minVol);
                        if (compFilt) ideas = ideas.filter(k => k.competition === compFilt);
                        if (maxCpc)   ideas = ideas.filter(k => !k.high_cpc || k.high_cpc <= maxCpc);

                        ideas.sort((a, b) => b.avg_monthly_searches - a.avg_monthly_searches);

                        // Group by cluster
                        const groups = clusterKeywords(ideas);
                        const grouped = Object.entries(groups).map(([theme, kws]) => ({
                            theme: theme.charAt(0).toUpperCase() + theme.slice(1),
                            keyword_count: kws.length,
                            total_monthly_volume: kws.reduce((s, k) => s + k.avg_monthly_searches, 0),
                            keywords: kws.slice(0, 20), // top 20 per group
                        })).sort((a, b) => b.total_monthly_volume - a.total_monthly_volume);

                        result = {
                            account: info.name,
                            source: url ? (seeds.length ? `seeds + ${url}` : url) : `seeds: ${seeds.join(", ")}`,
                            filters_applied: { min_volume: minVol || null, competition: compFilt, max_cpc: maxCpc },
                            total_ideas: ideas.length,
                            groups: grouped,
                        };
                    } catch (e) { result = { error: e.message }; }
                }
            }
        }

    } else if (name === "keyword_metrics") {
        const search    = (args.account_name || "").toLowerCase();
        const keywords  = (args.keywords || []).slice(0, 20);
        const showTrend = !!args.show_trend;

        if (!keywords.length) { result = { error: "Provide at least one keyword." }; }
        else {
            const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) { result = { error: `No Google account matching '${args.account_name}'` }; }
            else {
                const [cid, info] = match;
                const { token, error: authErr } = await getGoogleAccessToken();
                if (authErr) { result = { error: `Auth: ${authErr}` }; }
                else {
                    try {
                        const metrics = await fetchKeywordHistoricalMetrics(token, cid, info.mcc, keywords, showTrend);
                        metrics.sort((a, b) => b.avg_monthly_searches - a.avg_monthly_searches);
                        result = { account: info.name, keyword_count: metrics.length, keywords: metrics };
                    } catch (e) { result = { error: e.message }; }
                }
            }
        }

    } else if (name === "build_campaign_plan") {
        const search    = (args.account_name || "").toLowerCase();
        const keywords  = (args.keywords || []).slice(0, 50);
        const campName  = args.campaign_name || "New Campaign";
        const dailyBudget = args.daily_budget || null;

        if (!keywords.length) { result = { error: "Provide at least one keyword." }; }
        else {
            const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) { result = { error: `No Google account matching '${args.account_name}'` }; }
            else {
                const [cid, info] = match;
                const { token, error: authErr } = await getGoogleAccessToken();
                if (authErr) { result = { error: `Auth: ${authErr}` }; }
                else {
                    try {
                        // Fetch historical metrics for all keywords
                        const metrics = await fetchKeywordHistoricalMetrics(token, cid, info.mcc, keywords, false);

                        // Cluster into ad groups
                        const groups = clusterKeywords(metrics);
                        const adGroups = Object.entries(groups).map(([theme, kws]) => {
                            const planned = kws.map(kw => ({
                                keyword:      kw.keyword,
                                match_type:   recommendMatchType(kw),
                                monthly_searches: kw.avg_monthly_searches,
                                competition:  kw.competition,
                                cpc_range:    (kw.low_cpc && kw.high_cpc) ? `$${kw.low_cpc}–$${kw.high_cpc}` : (kw.high_cpc ? `~$${kw.high_cpc}` : "N/A"),
                                est_monthly_clicks: estimateMonthlyClicks(kw),
                                est_monthly_spend:  "$" + estimateMonthlyCost(kw).toFixed(2),
                            }));
                            const totalClicks = planned.reduce((s, k) => s + k.est_monthly_clicks, 0);
                            const totalSpend  = planned.reduce((s, k) => s + estimateMonthlyCost(metrics.find(m => m.keyword === k.keyword) || {}), 0);
                            return {
                                ad_group: theme.charAt(0).toUpperCase() + theme.slice(1),
                                keyword_count: planned.length,
                                total_monthly_volume: kws.reduce((s, k) => s + k.avg_monthly_searches, 0),
                                est_monthly_clicks: totalClicks,
                                est_monthly_spend: "$" + totalSpend.toFixed(2),
                                keywords: planned,
                            };
                        }).sort((a, b) => b.total_monthly_volume - a.total_monthly_volume);

                        // Overall totals
                        const totalMonthlySpend = adGroups.reduce((s, g) => s + parseFloat(g.est_monthly_spend.replace("$", "")), 0);
                        const totalMonthlyClicks = adGroups.reduce((s, g) => s + g.est_monthly_clicks, 0);
                        const suggestedNegatives = inferNegatives(metrics);

                        // Budget analysis
                        let budgetNote = null;
                        if (dailyBudget) {
                            const monthlyBudget = dailyBudget * 30.4;
                            const coverage = Math.round((monthlyBudget / totalMonthlySpend) * 100);
                            budgetNote = {
                                daily_budget: "$" + dailyBudget.toFixed(2),
                                monthly_budget: "$" + monthlyBudget.toFixed(2),
                                estimated_full_spend: "$" + totalMonthlySpend.toFixed(2),
                                budget_coverage: coverage + "% of estimated full spend",
                                note: coverage >= 100 ? "Budget likely sufficient to capture most traffic."
                                    : coverage >= 60  ? "Budget will capture ~" + coverage + "% of available traffic."
                                    : "Budget is tight — consider focusing on highest-intent ad groups first.",
                            };
                        }

                        result = {
                            campaign_name: campName,
                            account: info.name,
                            summary: {
                                ad_group_count: adGroups.length,
                                total_keywords: metrics.length,
                                est_monthly_clicks: totalMonthlyClicks,
                                est_monthly_spend: "$" + totalMonthlySpend.toFixed(2),
                            },
                            budget_analysis: budgetNote,
                            ad_groups: adGroups,
                            suggested_negatives: suggestedNegatives,
                            next_steps: [
                                "Review ad groups — merge any with fewer than 3 keywords",
                                "Confirm match types — EXACT for proven converters, PHRASE for intent variants",
                                "Write 3+ headlines and 2+ descriptions per ad group",
                                "Add negatives to prevent ad group cross-contamination",
                                "Set up conversion tracking before launch",
                            ],
                        };
                    } catch (e) { result = { error: e.message }; }
                }
            }
        }

    } else if (name === "get_keyword_ideas") {
        const search  = (args.account_name || "").toLowerCase();
        const keywords = args.keywords || [];
        const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account found matching '${args.account_name}'` };
        } else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken();
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    const ideas = await fetchKeywordIdeas(token, cid, info.mcc, keywords);
                    result = { account: info.name, seed_keywords: keywords, total: ideas.length, ideas };
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "pause_campaign" || name === "enable_campaign") {
        const search    = (args.account_name || "").toLowerCase();
        const campSearch = (args.campaign_name || "").toLowerCase();
        const platform  = args.platform || "google";
        const confirm   = !!args.confirm;
        const newStatus = name === "pause_campaign" ? "PAUSED" : "ENABLED";
        const metaStatus = name === "pause_campaign" ? "PAUSED" : "ACTIVE";

        if (platform === "google") {
            const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) { result = { error: `No Google account matching '${args.account_name}'` }; }
            else {
                const [cid, info] = match;
                const { token, error: authErr } = await getGoogleAccessToken();
                if (authErr) { result = { error: `Auth: ${authErr}` }; }
                else {
                    try {
                        const campaigns = await listGoogleCampaignsFull(token, cid, info.mcc);
                        const camp = campaigns.find(c => c.name.toLowerCase().includes(campSearch));
                        if (!camp) {
                            result = { error: `No campaign matching '${args.campaign_name}'`, available: campaigns.map(c => c.name) };
                        } else if (!confirm) {
                            result = { dry_run: true, message: `DRY RUN — set confirm=true to apply`, account: info.name, campaign: camp.name, current_status: camp.status, new_status: newStatus };
                        } else {
                            await updateGoogleCampaignStatus(token, cid, info.mcc, camp.resource_name, newStatus);
                            result = { success: true, account: info.name, campaign: camp.name, status: newStatus };
                        }
                    } catch (e) { result = { error: e.message }; }
                }
            }
        } else {
            // Meta
            const match = Object.entries(META_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) { result = { error: `No Meta account matching '${args.account_name}'` }; }
            else {
                const [accountId, info] = match;
                try {
                    const campaigns = await getMetaCampaigns(accountId);
                    const camp = campaigns.find(c => c.name.toLowerCase().includes(campSearch));
                    if (!camp) {
                        result = { error: `No campaign matching '${args.campaign_name}'`, available: campaigns.map(c => c.name) };
                    } else if (!confirm) {
                        result = { dry_run: true, message: `DRY RUN — set confirm=true to apply`, account: info.name, campaign: camp.name, current_status: camp.status, new_status: metaStatus };
                    } else {
                        await metaPost(camp.id, { status: metaStatus });
                        result = { success: true, account: info.name, campaign: camp.name, status: metaStatus };
                    }
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "update_budget") {
        const search     = (args.account_name || "").toLowerCase();
        const campSearch = (args.campaign_name || "").toLowerCase();
        const platform   = args.platform || "google";
        const daily      = args.daily_budget;
        const confirm    = !!args.confirm;

        if (!daily || daily <= 0) {
            result = { error: "daily_budget must be a positive number." };
        } else if (platform === "google") {
            const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) { result = { error: `No Google account matching '${args.account_name}'` }; }
            else {
                const [cid, info] = match;
                const { token, error: authErr } = await getGoogleAccessToken();
                if (authErr) { result = { error: `Auth: ${authErr}` }; }
                else {
                    try {
                        const campaigns = await listGoogleCampaignsFull(token, cid, info.mcc);
                        const camp = campaigns.find(c => c.name.toLowerCase().includes(campSearch));
                        if (!camp) {
                            result = { error: `No campaign matching '${args.campaign_name}'`, available: campaigns.map(c => c.name) };
                        } else if (!confirm) {
                            result = { dry_run: true, message: `DRY RUN — set confirm=true to apply`, account: info.name, campaign: camp.name, current_daily_budget: camp.daily_budget, new_daily_budget: "$" + daily.toFixed(2) };
                        } else {
                            const r = await updateGoogleCampaignBudget(token, cid, info.mcc, camp.resource_name, daily);
                            result = { success: true, account: info.name, campaign: camp.name, ...r };
                        }
                    } catch (e) { result = { error: e.message }; }
                }
            }
        } else {
            // Meta
            const match = Object.entries(META_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) { result = { error: `No Meta account matching '${args.account_name}'` }; }
            else {
                const [accountId, info] = match;
                try {
                    const campaigns = await getMetaCampaigns(accountId);
                    const camp = campaigns.find(c => c.name.toLowerCase().includes(campSearch));
                    if (!camp) {
                        result = { error: `No campaign matching '${args.campaign_name}'`, available: campaigns.map(c => c.name) };
                    } else if (!confirm) {
                        result = { dry_run: true, message: `DRY RUN — set confirm=true to apply`, account: info.name, campaign: camp.name, current_daily_budget: camp.daily_budget ? "$" + camp.daily_budget : null, new_daily_budget: "$" + daily.toFixed(2) };
                    } else {
                        await metaPost(camp.id, { daily_budget: Math.round(daily * 100) });
                        result = { success: true, account: info.name, campaign: camp.name, new_daily_budget: "$" + daily.toFixed(2) };
                    }
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "get_analytics_report") {
        const search    = (args.account_name || "").toLowerCase();
        const dateRange = args.date_range || "THIS_MONTH";
        const breakdown = args.breakdown  || "channel";

        const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No account found matching '${args.account_name}'` };
        } else {
            const [, info] = match;
            if (!info.ga4) {
                const withGA4 = Object.values(GOOGLE_ACCOUNTS).filter(a => a.ga4).map(a => a.name);
                result = {
                    error: `No GA4 property configured for ${info.name}.`,
                    accounts_with_ga4: withGA4.length ? withGA4 : ["None configured yet — provide a GA4 Property ID to add one."],
                };
            } else {
                const { token, error: authErr } = await getGoogleAccessToken();
                if (authErr) { result = { error: `Auth: ${authErr}` }; }
                else {
                    try {
                        const report = await fetchGA4Report(token, info.ga4, dateRange, breakdown);
                        result = { account: info.name, ga4_property: info.ga4, date_range: dateRange, breakdown, ...report };
                    } catch (e) { result = { error: e.message }; }
                }
            }
        }

    } else if (name === "get_campaign_performance") {
        const search    = (args.account_name || "").toLowerCase();
        const platform  = args.platform || "google";
        const dateRange = args.date_range || "THIS_MONTH";
        const metaPresetMap = {
            THIS_MONTH: "this_month", LAST_MONTH: "last_month",
            LAST_30_DAYS: "last_30_days", LAST_90_DAYS: "last_90_days", LAST_7_DAYS: "last_7_days",
        };

        result = { account: args.account_name, date_range: dateRange };

        if (platform === "google" || platform === "both") {
            const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) {
                result.google_error = `No Google account matching '${args.account_name}'`;
            } else {
                const [cid, info] = match;
                const { token, error: authErr } = await getGoogleAccessToken();
                if (authErr) { result.google_error = `Auth: ${authErr}`; }
                else {
                    try {
                        result.google = { account: info.name, campaigns: await fetchGoogleCampaignPerf(token, cid, info.mcc, dateRange) };
                    } catch (e) { result.google_error = e.message; }
                }
            }
        }

        if (platform === "meta" || platform === "both") {
            const match = Object.entries(META_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) {
                result.meta_error = `No Meta account matching '${args.account_name}'`;
            } else {
                const [accountId, info] = match;
                try {
                    result.meta = { account: info.name, campaigns: await fetchMetaCampaignPerf(accountId, metaPresetMap[dateRange] || "this_month") };
                } catch (e) { result.meta_error = e.message; }
            }
        }

    } else if (name === "get_recommendations") {
        const search = (args.account_name || "").toLowerCase();
        const match  = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account found matching '${args.account_name}'` };
        } else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken();
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    const recs = await fetchGoogleRecommendations(token, cid, info.mcc);
                    result = {
                        account: info.name,
                        total_recommendations: recs.reduce((s, r) => s + r.count, 0),
                        recommendations: recs,
                    };
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "get_keyword_performance") {
        const search    = (args.account_name || "").toLowerCase();
        const dateRange = args.date_range || "THIS_MONTH";
        const filter    = args.filter || null;
        const match     = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));

        if (!match) {
            result = { error: `No Google account found matching '${args.account_name}'` };
        } else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken();
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    let keywords = await fetchGoogleKeywordPerf(token, cid, info.mcc, dateRange);
                    if (filter === "low_quality_score")   keywords = keywords.filter(k => k.quality_score != null && k.quality_score <= 4);
                    if (filter === "low_impression_share") keywords = keywords.filter(k => k.impression_share != null && parseFloat(k.impression_share) < 0.5);
                    if (filter === "converting")          keywords = keywords.filter(k => k.conversions > 0);
                    if (filter === "non_converting")      keywords = keywords.filter(k => k.conversions === 0 && k.spend > 5);

                    // Summary stats
                    const avgQS = keywords.filter(k => k.quality_score).reduce((s, k, _, a) => s + k.quality_score / a.length, 0);
                    result = {
                        account:      info.name,
                        date_range:   dateRange,
                        filter:       filter || "none",
                        total:        keywords.length,
                        avg_quality_score: avgQS > 0 ? Math.round(avgQS * 10) / 10 : null,
                        keywords,
                    };
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "compare_periods") {
        const search     = (args.account_name || "").toLowerCase();
        const comparison = args.comparison;
        const platform   = args.platform || "google";

        try {
            const { p1, p2 } = getCompareDateRanges(comparison);
            result = { account: args.account_name, comparison, p1_label: p1.label, p2_label: p2.label };

            const diff = (cur, pri, isNegGood = false) => {
                const chg = pctChange(cur, pri);
                const good = isNegGood ? (cur <= pri) : (cur >= pri);
                return { current: cur, prior: pri, change: chg, trend: chg === "—" ? "flat" : good ? "up" : "down" };
            };

            if (platform === "google" || platform === "both") {
                const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
                if (!match) { result.google_error = `No Google account matching '${args.account_name}'`; }
                else {
                    const [cid, info] = match;
                    const { token, error: authErr } = await getGoogleAccessToken();
                    if (authErr) { result.google_error = authErr; }
                    else {
                        const [cur, pri] = await Promise.all([
                            fetchGoogleMetricsForRange(token, cid, info.mcc, p1.start, p1.end),
                            fetchGoogleMetricsForRange(token, cid, info.mcc, p2.start, p2.end),
                        ]);
                        result.google = {
                            account:      info.name,
                            spend:        diff(cur.spend, pri.spend),
                            clicks:       diff(cur.clicks, pri.clicks),
                            impressions:  diff(cur.impressions, pri.impressions),
                            avg_cpc:      diff(parseFloat(cur.avg_cpc?.replace("$","") || 0), parseFloat(pri.avg_cpc?.replace("$","") || 0), true),
                            conversions:  diff(cur.conversions, pri.conversions),
                            cpa:          cur.cpa != null ? diff(cur.cpa, pri.cpa, true) : null,
                            roas:         cur.roas != null ? diff(cur.roas, pri.roas) : null,
                        };
                    }
                }
            }

            if (platform === "meta" || platform === "both") {
                const match = Object.entries(META_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
                if (!match) { result.meta_error = `No Meta account matching '${args.account_name}'`; }
                else {
                    const [accountId, info] = match;
                    const [cur, pri] = await Promise.all([
                        fetchMetaMetricsForRange(accountId, p1.start, p1.end),
                        fetchMetaMetricsForRange(accountId, p2.start, p2.end),
                    ]);
                    result.meta = {
                        account:     info.name,
                        spend:       diff(cur.spend, pri.spend),
                        clicks:      diff(cur.clicks, pri.clicks),
                        impressions: diff(cur.impressions, pri.impressions),
                        conversions: diff(cur.conversions, pri.conversions),
                        cpa:         cur.cpa != null ? diff(cur.cpa, pri.cpa, true) : null,
                        roas:        cur.roas != null ? diff(cur.roas, pri.roas) : null,
                    };
                }
            }
        } catch (e) { result = { error: e.message }; }

    } else if (name === "manage_meta") {
        const search  = (args.account_name || "").toLowerCase();
        const action  = args.action || "list_adsets";
        const confirm = !!args.confirm;
        const level   = args.level || "adset";

        const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!acctMatch) {
            result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
        } else {
            const [accountId, acctInfo] = acctMatch;
            try {
                if (action === "list_campaigns") {
                    const campaigns = await getMetaCampaigns(accountId);
                    result = { account: acctInfo.name, campaigns };

                } else if (action === "list_adsets") {
                    const adsets = await getMetaAdsets(accountId);
                    result = { account: acctInfo.name, adsets };

                } else if (action === "duplicate") {
                    const dupLevel  = args.level || "campaign";
                    const dupStatus = (args.status || "PAUSED").toUpperCase();
                    if (!args.target) {
                        result = { error: "'target' is required for duplicate. Run list_campaigns or list_adsets first to find the name." };
                    } else {
                        const targetSearch = args.target.toLowerCase();
                        const all  = dupLevel === "campaign" ? await getMetaCampaigns(accountId) : await getMetaAdsets(accountId);
                        const item = all.find(i => i.name.toLowerCase().includes(targetSearch));
                        if (!item) {
                            result = { error: `No ${dupLevel} matching '${args.target}'`, available: all.map(i => i.name) };
                        } else {
                            const copyName = args.new_name || `Copy of ${item.name}`;
                            if (!confirm) {
                                result = {
                                    dry_run: true,
                                    message: "DRY RUN — set confirm=true to duplicate",
                                    account:      acctInfo.name,
                                    source:       { id: item.id, name: item.name, level: dupLevel },
                                    new_name:     copyName,
                                    new_status:   dupStatus,
                                    note:         "deep_copy=true — ad sets and ads will be copied too (for campaign level)",
                                };
                            } else {
                                const res = await metaDuplicate(item.id, dupLevel, copyName, dupStatus);
                                result = {
                                    success:    true,
                                    account:    acctInfo.name,
                                    source:     { id: item.id, name: item.name },
                                    new_id:     res.new_id,
                                    new_name:   copyName,
                                    new_status: dupStatus,
                                };
                            }
                        }
                    }

                } else {
                    // pause / resume / set_daily_budget — need a target
                    if (!args.target) {
                        result = { error: `'target' is required for action '${action}'. Run list_campaigns or list_adsets first to find the name.` };
                    } else {
                        const targetSearch = args.target.toLowerCase();
                        let items;

                        if (level === "campaign") {
                            const all = await getMetaCampaigns(accountId);
                            items = all.filter(c => c.name.toLowerCase().includes(targetSearch));
                        } else {
                            const all = await getMetaAdsets(accountId);
                            items = all.filter(s => s.name.toLowerCase().includes(targetSearch));
                        }

                        if (items.length === 0) {
                            const all = level === "campaign" ? await getMetaCampaigns(accountId) : await getMetaAdsets(accountId);
                            result = { error: `No ${level} found matching '${args.target}'`, available: all.map(i => i.name) };
                        } else {
                            // Build preview
                            const changes = items.map(item => {
                                if (action === "pause")   return { id: item.id, name: item.name, level, change: "status → PAUSED",   current_status: item.status };
                                if (action === "resume")  return { id: item.id, name: item.name, level, change: "status → ACTIVE",   current_status: item.status };
                                if (action === "set_daily_budget") {
                                    const bd = args.budget;
                                    return { id: item.id, name: item.name, level, change: `daily_budget → $${bd}`, current_budget: item.daily_budget != null ? `$${item.daily_budget}` : "lifetime" };
                                }
                            });

                            if (!confirm) {
                                result = { dry_run: true, message: "DRY RUN — no changes made. Set confirm=true to apply.", account: acctInfo.name, planned_changes: changes };
                            } else {
                                // Execute
                                const outcomes = [];
                                for (const item of items) {
                                    let body = {};
                                    if (action === "pause")  body = { status: "PAUSED" };
                                    if (action === "resume") body = { status: "ACTIVE" };
                                    if (action === "set_daily_budget") {
                                        if (!args.budget) throw new Error("budget is required for set_daily_budget");
                                        body = { daily_budget: Math.round(args.budget * 100) }; // Meta uses cents
                                    }
                                    const res = await metaPost(item.id, body);
                                    outcomes.push({ id: item.id, name: item.name, success: !!res.success });
                                }
                                result = { success: true, account: acctInfo.name, action, outcomes };
                            }
                        }
                    }
                }
            } catch (e) {
                result = { error: e.message };
            }
        }

    } else if (name === "add_negative_keywords") {
        const search    = (args.account_name || "").toLowerCase();
        const keywords  = args.keywords || [];
        const matchType = (args.match_type || "EXACT").toUpperCase();
        const confirm   = !!args.confirm;

        const acctMatch = Object.entries(GOOGLE_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!acctMatch) {
            result = { error: `No Google account found matching '${args.account_name}'` };
        } else {
            const [cid, info] = acctMatch;
            const { token, error: authErr } = await getGoogleAccessToken();
            if (authErr) { result = { error: `Auth failed: ${authErr}` }; }
            else {
                try {
                    const campaigns = await getCampaigns(token, cid, info.mcc);

                    // No campaign specified — list them
                    if (!args.campaign_name) {
                        result = {
                            account: info.name,
                            message: "Specify a campaign_name to target. Available campaigns:",
                            campaigns: campaigns.map(c => ({ name: c.name, status: c.status })),
                        };
                    } else {
                        const campSearch = args.campaign_name.toLowerCase();
                        const campMatch  = campaigns.find(c => c.name.toLowerCase().includes(campSearch));
                        if (!campMatch) {
                            result = {
                                error: `No campaign found matching '${args.campaign_name}'`,
                                available: campaigns.map(c => c.name),
                            };
                        } else if (keywords.length === 0) {
                            result = { error: "No keywords provided." };
                        } else {
                            const cleanKws = keywords.map(k => k.replace(/^["']|["']$/g, "").trim()).filter(Boolean);

                            if (!confirm) {
                                // Dry run
                                result = {
                                    dry_run: true,
                                    message: "DRY RUN — no changes made. Set confirm=true to apply.",
                                    account: info.name,
                                    campaign: campMatch.name,
                                    match_type: matchType,
                                    keywords_to_add: cleanKws,
                                    count: cleanKws.length,
                                };
                            } else {
                                // Live write
                                const responses = await mutateNegativeKeywords(token, cid, info.mcc, campMatch.resourceName, cleanKws, matchType);
                                result = {
                                    success: true,
                                    account: info.name,
                                    campaign: campMatch.name,
                                    match_type: matchType,
                                    keywords_added: cleanKws,
                                    count: cleanKws.length,
                                    api_results: responses.length,
                                };
                            }
                        }
                    }
                } catch (e) {
                    result = { error: e.message };
                }
            }
        }

    } else if (name === "sync_accounts") {
        const platform           = args.platform || "both";
        const excludeBizIds      = args.exclude_business_ids || [];
        const checkSpend         = args.check_spend !== false; // default true
        result = {};

        if (platform === "google" || platform === "both") {
            const { token, error: authErr } = await getGoogleAccessToken();
            if (authErr) { result.google_error = `Auth: ${authErr}`; }
            else {
                try {
                    const accessibleIds = await listAccessibleCustomers(token);
                    const discovered = {};

                    for (const cid of accessibleIds) {
                        discovered[cid] = discovered[cid] || { id: cid, name: null, mcc: cid, isMCC: false };
                        const children = await listMCCChildren(token, cid);
                        if (children.length) {
                            discovered[cid].isMCC = true;
                            for (const child of children) {
                                if (!child.manager) {
                                    discovered[child.id] = { id: child.id, name: child.name, mcc: cid, isMCC: false };
                                }
                            }
                        }
                    }

                    const trackedIds  = new Set(Object.keys(GOOGLE_ACCOUNTS));
                    const allAccounts = Object.values(discovered).filter(a => !a.isMCC);
                    const newAccounts = allAccounts.filter(a => !trackedIds.has(a.id));

                    // Resolve names for accounts that came back without one
                    for (const acct of newAccounts) {
                        if (!acct.name || acct.name === "(name not fetched)") {
                            acct.name = await getGoogleAccountName(token, acct.id) || "(unknown)";
                        }
                    }

                    // Check spend in parallel and filter out $0 accounts
                    const withSpend = [];
                    const noSpend   = [];
                    if (checkSpend && newAccounts.length) {
                        const spends = await Promise.all(
                            newAccounts.map(a => getGoogleAccountSpend(token, a.id, a.mcc))
                        );
                        for (let i = 0; i < newAccounts.length; i++) {
                            if (spends[i] > 0) withSpend.push({ ...newAccounts[i], last_30d_spend: "$" + spends[i].toFixed(2) });
                            else noSpend.push(newAccounts[i].name);
                        }
                    } else {
                        withSpend.push(...newAccounts);
                    }

                    result.google = {
                        total_discovered:  allAccounts.length,
                        already_tracked:   trackedIds.size,
                        new_with_spend:    withSpend.length,
                        new_no_spend:      noSpend.length,
                        skipped_no_spend:  noSpend,
                        new: withSpend.map(a => ({
                            id:            a.id,
                            name:          a.name,
                            mcc:           a.mcc,
                            last_30d_spend: a.last_30d_spend,
                            note:          "Tell me to add it with a budget",
                        })),
                    };
                } catch (e) { result.google_error = e.message; }
            }
        }

        if (platform === "meta" || platform === "both") {
            try {
                // Build exclusion set from business manager IDs
                const excludedAccountIds = new Set();
                for (const bizId of excludeBizIds) {
                    const ids = await getMetaBusinessAdAccountIds(bizId);
                    for (const id of ids) excludedAccountIds.add(id);
                }

                const allAccounts  = await listMetaAdAccountsAll();
                const trackedIds   = new Set(Object.keys(META_ACCOUNTS));
                const candidates   = allAccounts.filter(a =>
                    !trackedIds.has(a.id) &&
                    !excludedAccountIds.has(a.id) &&
                    a.status === "ACTIVE"
                );

                // Check spend in batch and filter out $0 accounts
                const withSpend = [];
                const noSpend   = [];
                if (checkSpend && candidates.length) {
                    const spendMap = await batchMetaSpend(candidates.map(a => a.id));
                    for (const acct of candidates) {
                        const spend = spendMap.get(acct.id) || 0;
                        if (spend > 0) withSpend.push({ ...acct, last_30d_spend: "$" + spend.toFixed(2) });
                        else noSpend.push(acct.name);
                    }
                } else {
                    withSpend.push(...candidates);
                }

                result.meta = {
                    total_discovered:  allAccounts.length,
                    excluded_by_biz:   excludedAccountIds.size,
                    already_tracked:   trackedIds.size,
                    new_with_spend:    withSpend.length,
                    new_no_spend:      noSpend.length,
                    skipped_no_spend:  noSpend,
                    new: withSpend.map(a => ({
                        id:             a.id,
                        name:           a.name,
                        last_30d_spend: a.last_30d_spend,
                        note:           "Tell me to add it with a budget",
                    })),
                };
            } catch (e) { result.meta_error = e.message; }
        }

    } else if (name === "create_ad_group") {
        const search     = (args.account_name || "").toLowerCase();
        const campSearch = (args.campaign_name || "").toLowerCase();
        const confirm    = !!args.confirm;
        const status     = (args.status || "PAUSED").toUpperCase();
        const keywords   = args.keywords   || [];
        const headlines  = args.headlines  || [];
        const descs      = args.descriptions || [];

        if (!args.ad_group_name) {
            result = { error: "ad_group_name is required." };
        } else {
            const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) {
                result = { error: `No Google account matching '${args.account_name}'` };
            } else {
                const [cid, info] = match;
                const { token, error: authErr } = await getGoogleAccessToken();
                if (authErr) { result = { error: `Auth: ${authErr}` }; }
                else {
                    try {
                        const campaigns = await listGoogleCampaignsFull(token, cid, info.mcc);
                        const camp = campaigns.find(c => c.name.toLowerCase().includes(campSearch));
                        if (!camp) {
                            result = { error: `No campaign matching '${args.campaign_name}'`, available: campaigns.map(c => c.name) };
                        } else if (!confirm) {
                            result = {
                                dry_run: true,
                                message: "DRY RUN — set confirm=true to create",
                                account:       info.name,
                                campaign:      camp.name,
                                planned_ad_group: {
                                    name:          args.ad_group_name,
                                    status,
                                    keyword_count: keywords.length,
                                    keywords:      keywords.map(k => `[${k.match_type || "EXACT"}] ${k.text}`),
                                    has_rsa:       headlines.length >= 3 && descs.length >= 2,
                                    headlines:     headlines.map(h => h.text),
                                    descriptions:  descs.map(d => d.text),
                                },
                            };
                        } else {
                            const res = await createAdGroupInCampaign(token, cid, info.mcc, camp.resource_name, {
                                name:         args.ad_group_name,
                                status,
                                keywords,
                                headlines,
                                descriptions: descs,
                                final_url:    args.final_url || null,
                            });
                            result = {
                                success:  true,
                                account:  info.name,
                                campaign: camp.name,
                                ad_group: args.ad_group_name,
                                status,
                                ...res,
                            };
                        }
                    } catch (e) { result = { error: e.message }; }
                }
            }
        }

    } else if (name === "populate_ad_group") {
        const search      = (args.account_name || "").toLowerCase();
        const agResource  = args.ad_group_resource || "";
        const keywords    = args.keywords    || [];
        const headlines   = args.headlines   || [];
        const descs       = args.descriptions || [];
        const finalUrl    = args.final_url   || null;
        const confirm     = !!args.confirm;
        const hasRsa      = headlines.length >= 3 && descs.length >= 2 && finalUrl;

        if (!agResource) {
            result = { error: "ad_group_resource is required (e.g. customers/123/adGroups/456)" };
        } else if (!keywords.length && !hasRsa) {
            result = { error: "Provide keywords, or headlines + descriptions + final_url for an RSA." };
        } else {
            const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) {
                result = { error: `No Google account matching '${args.account_name}'` };
            } else {
                const [cid, info] = match;
                const { token, error: authErr } = await getGoogleAccessToken();
                if (authErr) { result = { error: `Auth: ${authErr}` }; }
                else {
                    if (!confirm) {
                        result = {
                            dry_run: true,
                            message: "DRY RUN — set confirm=true to apply",
                            account:          info.name,
                            ad_group_resource: agResource,
                            keywords_to_add:  keywords.map(k => `[${k.match_type || "EXACT"}] ${k.text}`),
                            rsa_to_add:       hasRsa ? { headlines: headlines.map(h => h.text), descriptions: descs.map(d => d.text), final_url: finalUrl } : null,
                        };
                    } else {
                        try {
                            let kwCount = 0, adResource = null;
                            if (keywords.length) {
                                const kwRes = await addKeywordsToAdGroup(token, cid, info.mcc, agResource, keywords);
                                kwCount = kwRes.length;
                            }
                            if (hasRsa) {
                                adResource = await addRSAToAdGroup(token, cid, info.mcc, agResource, headlines, descs, finalUrl);
                            }
                            result = {
                                success:           true,
                                account:           info.name,
                                ad_group_resource: agResource,
                                keywords_added:    kwCount,
                                rsa_created:       !!adResource,
                                ad_resource:       adResource,
                            };
                        } catch (e) { result = { error: e.message }; }
                    }
                }
            }
        }

    } else if (name === "get_budget_overview") {
        const platform    = args.platform    || "both";
        const acctFilter  = (args.account_name || "").toLowerCase();
        const activeOnly  = !!args.active_only;
        result = { google: [], meta: [] };

        if (platform === "google" || platform === "both") {
            const { token, error: authErr } = await getGoogleAccessToken();
            if (authErr) { result.google_error = `Auth: ${authErr}`; }
            else {
                for (const [cid, info] of Object.entries(GOOGLE_ACCOUNTS)) {
                    if (acctFilter && !info.name.toLowerCase().includes(acctFilter)) continue;
                    try {
                        const campaigns = await listGoogleCampaignsFull(token, cid, info.mcc);
                        const filtered  = activeOnly ? campaigns.filter(c => c.status === "ENABLED") : campaigns;
                        if (filtered.length) {
                            result.google.push({
                                account: info.name,
                                campaigns: filtered.map(c => ({
                                    name:         c.name,
                                    status:       c.status,
                                    type:         c.type,
                                    daily_budget: c.daily_budget || null,
                                    mtd_spend:    c.mtd_spend,
                                })),
                            });
                        }
                    } catch (e) {
                        result.google.push({ account: info.name, error: e.message });
                    }
                }
            }
        }

        if (platform === "meta" || platform === "both") {
            for (const [accountId, info] of Object.entries(META_ACCOUNTS)) {
                if (acctFilter && !info.name.toLowerCase().includes(acctFilter)) continue;
                try {
                    const campaigns = await getMetaCampaigns(accountId);
                    const adsets    = await getMetaAdsets(accountId);
                    const filtCamp  = activeOnly ? campaigns.filter(c => c.status === "ACTIVE") : campaigns;
                    const filtAds   = activeOnly ? adsets.filter(s => s.status === "ACTIVE") : adsets;
                    result.meta.push({
                        account: info.name,
                        campaigns: filtCamp.map(c => ({
                            name:             c.name,
                            status:           c.status,
                            budget_type:      c.daily_budget ? "daily" : c.lifetime_budget ? "lifetime" : "none",
                            daily_budget:     c.daily_budget    ? "$" + c.daily_budget.toFixed(2)    : null,
                            lifetime_budget:  c.lifetime_budget ? "$" + c.lifetime_budget.toFixed(2) : null,
                            note:             !c.daily_budget && !c.lifetime_budget ? "Budget set at ad set level" : null,
                        })),
                        adsets: filtAds.map(s => ({
                            name:            s.name,
                            campaign:        s.campaign,
                            status:          s.status,
                            budget_type:     s.daily_budget ? "daily" : s.lifetime_budget ? "lifetime" : "inherited",
                            daily_budget:    s.daily_budget    ? "$" + s.daily_budget.toFixed(2)    : null,
                            lifetime_budget: s.lifetime_budget ? "$" + s.lifetime_budget.toFixed(2) : null,
                        })),
                    });
                } catch (e) {
                    result.meta.push({ account: info.name, error: e.message });
                }
            }
        }

    } else if (name === "set_bidding_strategy") {
        const search     = (args.account_name || "").toLowerCase();
        const campSearch = (args.campaign_name || "").toLowerCase();
        const strategy   = (args.strategy || "").toUpperCase();
        const confirm    = !!args.confirm;

        const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account matching '${args.account_name}'` };
        } else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken();
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    const campaigns = await listGoogleCampaignsFull(token, cid, info.mcc);
                    const camp = campaigns.find(c => c.name.toLowerCase().includes(campSearch));
                    if (!camp) {
                        result = { error: `No campaign matching '${args.campaign_name}'`, available: campaigns.map(c => c.name) };
                    } else {
                        // Build preview of what the strategy change will do
                        const { campaignFields, updateMask } = buildBiddingUpdateBody(strategy, {
                            target_cpa:      args.target_cpa,
                            target_roas:     args.target_roas,
                            cpc_bid_ceiling: args.cpc_bid_ceiling,
                        });
                        const preview = { strategy, update_mask: updateMask, fields: campaignFields };

                        if (!confirm) {
                            result = { dry_run: true, message: "DRY RUN — set confirm=true to apply", account: info.name, campaign: camp.name, planned_change: preview };
                        } else {
                            await setBiddingStrategy(token, cid, info.mcc, camp.resource_name, strategy, {
                                target_cpa:      args.target_cpa,
                                target_roas:     args.target_roas,
                                cpc_bid_ceiling: args.cpc_bid_ceiling,
                            });
                            result = { success: true, account: info.name, campaign: camp.name, new_strategy: strategy, change: preview };
                        }
                    }
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "create_campaign") {
        const search  = (args.account_name || "").toLowerCase();
        const confirm = !!args.confirm;

        if (!args.campaign_name || !args.daily_budget || !args.ad_groups?.length) {
            result = { error: "campaign_name, daily_budget, and at least one ad_group are required." };
        } else {
            const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) {
                result = { error: `No Google account matching '${args.account_name}'` };
            } else {
                const [cid, info] = match;
                const { token, error: authErr } = await getGoogleAccessToken();
                if (authErr) { result = { error: `Auth: ${authErr}` }; }
                else {
                    const config = {
                        campaign_name:    args.campaign_name,
                        daily_budget:     args.daily_budget,
                        campaign_type:    args.campaign_type || "SEARCH",
                        bidding_strategy: args.bidding_strategy || "MANUAL_CPC",
                        ad_groups:        args.ad_groups,
                    };

                    if (!confirm) {
                        // Dry run — summarize what would be created
                        const totalKw = config.ad_groups.reduce((s, ag) => s + (ag.keywords?.length || 0), 0);
                        result = {
                            dry_run: true,
                            message: "DRY RUN — set confirm=true to create. Campaign will start PAUSED.",
                            account: info.name,
                            planned_campaign: {
                                name:             config.campaign_name,
                                type:             config.campaign_type,
                                daily_budget:     "$" + config.daily_budget.toFixed(2),
                                bidding_strategy: config.bidding_strategy,
                                status:           "PAUSED (default for new campaigns)",
                                ad_groups:        config.ad_groups.map(ag => ({
                                    name:          ag.name,
                                    keyword_count: ag.keywords?.length || 0,
                                    keywords:      (ag.keywords || []).map(k => `[${k.match_type || "BROAD"}] ${k.text}`),
                                })),
                                total_keywords: totalKw,
                            },
                        };
                    } else {
                        try {
                            const res = await createGoogleCampaignFull(token, cid, info.mcc, config);
                            result = {
                                success: true,
                                account:           info.name,
                                campaign_name:     config.campaign_name,
                                campaign_resource: res.campaign_resource,
                                budget_resource:   res.budget_resource,
                                total_ops:         res.total_ops,
                                status:            "PAUSED — review in Google Ads before enabling",
                            };
                        } catch (e) { result = { error: e.message }; }
                    }
                }
            }
        }

    } else if (name === "update_ad_copy") {
        const search     = (args.account_name || "").toLowerCase();
        const campSearch = (args.campaign_name || "").toLowerCase();
        const agSearch   = args.ad_group_name ? args.ad_group_name.toLowerCase() : null;
        const confirm    = !!args.confirm;
        const headlines  = args.headlines  || null;
        const descs      = args.descriptions || null;

        const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account matching '${args.account_name}'` };
        } else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken();
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    const ads = await getAdGroupAds(token, cid, info.mcc, campSearch, agSearch);
                    if (!ads.length) {
                        result = { error: `No responsive search ads found for campaign '${args.campaign_name}'${agSearch ? ` / ad group '${args.ad_group_name}'` : ""}` };
                    } else if (!headlines && !descs) {
                        // Preview mode — just show current copy
                        result = { account: info.name, message: "Current RSA copy — provide headlines and descriptions to update", ads };
                    } else if (ads.length > 1 && !agSearch) {
                        // Multiple ads found — require narrowing down
                        result = {
                            error: `Found ${ads.length} RSAs across multiple ad groups. Specify ad_group_name to target one.`,
                            ads: ads.map(a => ({ resource_name: a.resource_name, campaign: a.campaign, ad_group: a.ad_group })),
                        };
                    } else {
                        const ad = ads[0];
                        if (!headlines || headlines.length < 3) {
                            result = { error: "At least 3 headlines are required for a responsive search ad." };
                        } else if (!descs || descs.length < 2) {
                            result = { error: "At least 2 descriptions are required for a responsive search ad." };
                        } else if (!confirm) {
                            result = {
                                dry_run: true,
                                message: "DRY RUN — set confirm=true to apply",
                                account:      info.name,
                                campaign:     ad.campaign,
                                ad_group:     ad.ad_group,
                                resource_name: ad.resource_name,
                                current_headlines:    ad.headlines,
                                current_descriptions: ad.descriptions,
                                new_headlines:    headlines,
                                new_descriptions: descs,
                            };
                        } else {
                            await updateRSA(token, cid, info.mcc, ad.resource_name, headlines, descs);
                            result = {
                                success: true,
                                account:       info.name,
                                campaign:      ad.campaign,
                                ad_group:      ad.ad_group,
                                resource_name: ad.resource_name,
                                headlines_set: headlines.length,
                                descriptions_set: descs.length,
                            };
                        }
                    }
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "add_ad_extension") {
        const search     = (args.account_name || "").toLowerCase();
        const campSearch = (args.campaign_name || "").toLowerCase();
        const extType    = (args.extension_type || "").toUpperCase();
        const assets     = args.assets || [];
        const confirm    = !!args.confirm;

        if (!extType || !assets.length) {
            result = { error: "extension_type and at least one asset are required." };
        } else {
            const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) {
                result = { error: `No Google account matching '${args.account_name}'` };
            } else {
                const [cid, info] = match;
                const { token, error: authErr } = await getGoogleAccessToken();
                if (authErr) { result = { error: `Auth: ${authErr}` }; }
                else {
                    try {
                        const campaigns = await listGoogleCampaignsFull(token, cid, info.mcc);
                        const camp = campaigns.find(c => c.name.toLowerCase().includes(campSearch));
                        if (!camp) {
                            result = { error: `No campaign matching '${args.campaign_name}'`, available: campaigns.map(c => c.name) };
                        } else if (!confirm) {
                            result = {
                                dry_run: true,
                                message: "DRY RUN — set confirm=true to apply",
                                account:        info.name,
                                campaign:       camp.name,
                                extension_type: extType,
                                assets_to_add:  assets,
                                count:          assets.length,
                            };
                        } else {
                            const res = await addCampaignExtensions(token, cid, info.mcc, camp.resource_name, extType, assets);
                            result = {
                                success: true,
                                account:        info.name,
                                campaign:       camp.name,
                                extension_type: extType,
                                ...res,
                            };
                        }
                    } catch (e) { result = { error: e.message }; }
                }
            }
        }

    } else {
        result = { error: `Unknown tool: ${name}` };
    }

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

async function main() {
    const PORT = process.env.PORT;

    if (PORT) {
        // ── HTTP/SSE mode (Railway) ──────────────────────────────────────────
        const transports = {};

        const httpServer = http.createServer(async (req, res) => {
            const url = new URL(req.url, `http://localhost`);

            if (url.pathname === "/sse") {
                const transport = new SSEServerTransport("/messages", res);
                transports[transport.sessionId] = transport;
                res.on("close", () => delete transports[transport.sessionId]);
                await server.connect(transport);

            } else if (url.pathname === "/messages") {
                const sessionId = url.searchParams.get("sessionId");
                const transport = transports[sessionId];
                if (!transport) { res.writeHead(404); res.end("Session not found"); return; }
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                const body = JSON.parse(Buffer.concat(chunks).toString());
                await transport.handlePostMessage(req, res, body);

            } else {
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("KayComm MCP Server v2 — running");
            }
        });

        httpServer.listen(parseInt(PORT), () => {
            console.error(`KayComm MCP running on port ${PORT} (SSE mode)`);
        });

    } else {
        // ── stdio mode (local Claude Desktop) ───────────────────────────────
        const transport = new StdioServerTransport();
        await server.connect(transport);
    }
}

main().catch(console.error);
