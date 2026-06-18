#!/usr/bin/env node
/**
 * KayComm Pacing MCP Server
 * Tools: get_google_pacing, get_meta_pacing, get_full_pacing,
 *        get_account_detail, get_search_terms
 */

const http    = require("http");
const fs      = require("fs");
const path    = require("path");
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
const GOOGLE_API_VERSION     = "v21";

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_API_VERSION  = "v21.0";

const STACKADAPT_API_KEY = process.env.STACKADAPT_API_KEY;
const STACKADAPT_URL     = "https://api.stackadapt.com/graphql";

// ── Accounts — loaded from accounts.json ─────────────────────────────────────
// Google fields: name, budget, mcc (login-customer-id), nc_budget?, ga4?,
//                budget_schedule? [{from, budget, nc_budget?}], flight_start?, flight_end?
// Meta fields:   name, budget, budget_schedule?, flight_start?, flight_end?
// Edit via the manage_accounts tool — changes persist to accounts.json.
// NOTE: on Railway the filesystem is ephemeral; commit accounts.json to git
// so cloud deploys pick up account changes.
const ACCOUNTS_FILE = path.join(__dirname, "accounts.json");
let GOOGLE_ACCOUNTS = {};
let META_ACCOUNTS = {};
let STACKADAPT_ADVERTISERS = {};

function loadAccounts() {
    const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
    GOOGLE_ACCOUNTS        = data.google     || {};
    META_ACCOUNTS          = data.meta       || {};
    STACKADAPT_ADVERTISERS = data.stackadapt || {};
}

function saveAccounts() {
    const data = { google: GOOGLE_ACCOUNTS, meta: META_ACCOUNTS, stackadapt: STACKADAPT_ADVERTISERS };
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2) + "\n");
}

loadAccounts();

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
    if (!dom)    return { status: "NO_COMPLETE_DAYS_YET", note: "First day of the month — no complete days to pace against yet.", remaining: Math.round((budget - spent) * 100) / 100 };
    const expected    = budget * (dom / dim);
    const pctBudget   = Math.round((spent / budget) * 100 * 10) / 10;
    const pctExpected = expected > 0 ? Math.round((spent / expected) * 100 * 10) / 10 : 0;
    const remaining   = Math.round((budget - spent) * 100) / 100;
    const status      = pctExpected >= 105 ? "OVERPACING" : pctExpected <= 85 ? "UNDERPACING" : "ON PACE";
    const projected   = Math.round((spent / dom) * dim * 100) / 100;
    return {
        status, pct_budget: pctBudget, pct_expected: pctExpected, remaining,
        projected_month_end: projected,
        projected_vs_budget: Math.round((projected - budget) * 100) / 100,
    };
}

// Pacing for flight-based budgets (fixed start/end dates instead of calendar months)
function getFlightPacing(spent, budget, flightStart, flightEnd, yesterday) {
    const day = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
    const totalDays   = day(flightEnd) - day(flightStart) + 1;
    const elapsedDays = Math.max(0, Math.min(totalDays, day(yesterday) - day(flightStart) + 1));
    const remaining   = Math.round((budget - spent) * 100) / 100;
    const base = {
        flight: `${flightStart} → ${flightEnd}`,
        flight_days: totalDays,
        complete_days_elapsed: elapsedDays,
        budget, remaining,
        pct_budget: budget ? Math.round((spent / budget) * 100 * 10) / 10 : null,
    };
    if (elapsedDays <= 0) return { status: "FLIGHT_NOT_STARTED", ...base };
    if (day(yesterday) >= day(flightEnd)) {
        return { status: "FLIGHT_ENDED", ...base, note: spent < budget * 0.95 ? "Flight ended under budget." : "Flight delivered in full." };
    }
    const expected    = budget * (elapsedDays / totalDays);
    const pctExpected = expected > 0 ? Math.round((spent / expected) * 100 * 10) / 10 : 0;
    const daysLeft    = totalDays - elapsedDays;
    const status      = pctExpected >= 105 ? "OVERPACING" : pctExpected <= 85 ? "UNDERPACING" : "ON PACE";
    return {
        status, ...base,
        pct_expected: pctExpected,
        days_remaining: daysLeft,
        needed_per_day: daysLeft > 0 ? Math.round((remaining / daysLeft) * 100) / 100 : null,
        projected_flight_end: Math.round((spent / elapsedDays) * totalDays * 100) / 100,
    };
}

function getDateInfo() {
    // All date math pinned to the agency timezone so the local Mac (ET) and
    // Railway (UTC) produce identical reports, and "yesterday" matches the
    // ad platforms' reporting day.
    const TZ = process.env.REPORT_TIMEZONE || "America/New_York";
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
        .format(new Date()); // en-CA → YYYY-MM-DD
    const [y, m, d] = today.split("-").map(Number);
    const yday = new Date(Date.UTC(y, m - 1, d - 1));
    const fmt  = dt => dt.toISOString().split("T")[0];
    return {
        today,
        yesterday:   fmt(yday),
        month_start: `${y}-${String(m).padStart(2, "0")}-01`,
        dom:         d,                                  // actual calendar day (for display)
        // Complete days elapsed this month. On the 1st, yesterday belongs to the
        // previous month — 0 complete days, not yesterday's date (which would be 28-31).
        pace_dom:    d === 1 ? 0 : yday.getUTCDate(),
        dim:         new Date(Date.UTC(y, m, 0)).getUTCDate(),
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
        if (info.flight_start && info.flight_end) {
            // Flight-based budget: spend over the flight window, paced against flight days
            const until = yesterday < info.flight_end ? yesterday : info.flight_end;
            const { spend, error } = await fetchGoogleMTD(token, cid, info.mcc, info.flight_start, until);
            if (error) { rows.push({ account: info.name, error }); continue; }
            rows.push({
                account: info.name, flight_spend: Math.round(spend * 100) / 100,
                ...getFlightPacing(spend, budget, info.flight_start, info.flight_end, yesterday),
            });
        } else if (nc_budget) {
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
        if (info.flight_start && info.flight_end) {
            // Flight-based budget: spend over the flight window, paced against flight days
            const until = yesterday < info.flight_end ? yesterday : info.flight_end;
            const { spend, error } = await fetchMetaMTD(id, info.flight_start, until);
            if (error) { rows.push({ account: info.name, error }); continue; }
            rows.push({
                account: info.name, flight_spend: Math.round(spend * 100) / 100,
                ...getFlightPacing(spend, budget, info.flight_start, info.flight_end, yesterday),
            });
            continue;
        }
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
        case "LAST_90_DAYS":  return { startDate: "90daysAgo", endDate: "yesterday" };
        case "YEAR_TO_DATE": return { startDate: fmt(new Date(today.getFullYear(), 0, 1)), endDate: "yesterday" };
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

async function fetchGA4Report(token, propertyId, dateRange, breakdownBy = "channel", customStart, customEnd) {
    const { startDate, endDate } = (dateRange === "CUSTOM" && customStart && customEnd)
        ? { startDate: customStart, endDate: customEnd }
        : getGA4DateRange(dateRange);
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
async function fetchGoogleCampaignPerf(token, customerId, mccId, dateRange, startDate, endDate) {
    const dateClause = resolveGaqlDateClause(dateRange, startDate, endDate);
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT campaign.name, campaign.status, campaign.advertising_channel_type,
               metrics.cost_micros, metrics.clicks, metrics.impressions,
               metrics.conversions, metrics.conversions_value,
               metrics.ctr, metrics.average_cpc, metrics.search_impression_share
        FROM campaign
        WHERE segments.date ${dateClause}
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

async function fetchMetaCampaignPerf(accountId, datePreset, timeRange) {
    const params = new URLSearchParams({
        access_token: META_ACCESS_TOKEN,
        fields: "campaign_name,spend,clicks,impressions,ctr,cpc,actions,cost_per_action_type,purchase_roas",
        level: "campaign",
        limit: 100,
    });
    if (timeRange) {
        params.set("time_range", JSON.stringify(timeRange));
    } else {
        params.set("date_preset", datePreset);
    }
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

// ── Monthly trend ─────────────────────────────────────────────────────────────
async function fetchGoogleMonthlyTrend(token, customerId, mccId, year) {
    const { today } = getDateInfo();
    const yearStart = `${year}-01-01`;
    const yearEnd = year < parseInt(today.slice(0, 4)) ? `${year}-12-31` : today;
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT segments.month,
               metrics.cost_micros, metrics.clicks, metrics.impressions,
               metrics.conversions, metrics.conversions_value
        FROM campaign
        WHERE segments.date BETWEEN '${yearStart}' AND '${yearEnd}'
        ORDER BY segments.month`);

    const byMonth = {};
    for (const row of rows) {
        const m = row.segments.month;
        if (!byMonth[m]) byMonth[m] = { month: m, spend: 0, clicks: 0, impressions: 0, conversions: 0, conv_value: 0 };
        byMonth[m].spend       += parseInt(row.metrics.costMicros || 0) / 1_000_000;
        byMonth[m].clicks      += parseInt(row.metrics.clicks || 0);
        byMonth[m].impressions += parseInt(row.metrics.impressions || 0);
        byMonth[m].conversions += parseFloat(row.metrics.conversions || 0);
        byMonth[m].conv_value  += parseFloat(row.metrics.conversionsValue || 0);
    }
    const months = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));
    let ytdSpend = 0, ytdConv = 0, ytdValue = 0;
    for (const m of months) {
        m.spend      = Math.round(m.spend * 100) / 100;
        m.conv_value = Math.round(m.conv_value * 100) / 100;
        m.conversions = Math.round(m.conversions * 10) / 10;
        m.cpa  = m.conversions > 0 ? Math.round((m.spend / m.conversions) * 100) / 100 : null;
        m.roas = m.spend > 0 && m.conv_value > 0 ? Math.round((m.conv_value / m.spend) * 100) / 100 : null;
        ytdSpend += m.spend; ytdConv += m.conversions; ytdValue += m.conv_value;
    }
    return {
        months,
        ytd_totals: {
            spend: Math.round(ytdSpend * 100) / 100,
            conversions: Math.round(ytdConv * 10) / 10,
            conv_value: Math.round(ytdValue * 100) / 100,
            cpa: ytdConv > 0 ? Math.round((ytdSpend / ytdConv) * 100) / 100 : null,
            roas: ytdSpend > 0 && ytdValue > 0 ? Math.round((ytdValue / ytdSpend) * 100) / 100 : null,
        },
    };
}

async function fetchMetaMonthlyTrend(accountId, year) {
    const { today } = getDateInfo();
    const since = `${year}-01-01`;
    const until = year < parseInt(today.slice(0, 4)) ? `${year}-12-31` : today;
    const params = new URLSearchParams({
        access_token: META_ACCESS_TOKEN,
        fields: "spend,clicks,impressions,actions,purchase_roas",
        time_range: JSON.stringify({ since, until }),
        time_increment: "monthly",
        level: "account",
        limit: 100,
    });
    const resp = await fetchFn(`https://graph.facebook.com/${META_API_VERSION}/${accountId}/insights?${params}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);

    let ytdSpend = 0, ytdConv = 0;
    const months = (data.data || []).map(row => {
        const actions = row.actions || [];
        const leads = parseFloat(actions.find(a => a.action_type === "lead")?.value || 0);
        const purchases = parseFloat(actions.find(a => a.action_type === "purchase")?.value || 0);
        const convs = leads + purchases;
        const spend = parseFloat(row.spend || 0);
        const cpa = convs > 0 ? Math.round((spend / convs) * 100) / 100 : null;
        ytdSpend += spend; ytdConv += convs;
        return {
            month: row.date_start,
            spend: Math.round(spend * 100) / 100,
            clicks: parseInt(row.clicks || 0),
            impressions: parseInt(row.impressions || 0),
            conversions: convs,
            cpa,
        };
    });
    return {
        months,
        ytd_totals: {
            spend: Math.round(ytdSpend * 100) / 100,
            conversions: ytdConv,
            cpa: ytdConv > 0 ? Math.round((ytdSpend / ytdConv) * 100) / 100 : null,
        },
    };
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
async function fetchGoogleKeywordPerf(token, customerId, mccId, dateRange, startDate, endDate) {
    const dateClause = resolveGaqlDateClause(dateRange, startDate, endDate);
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
        WHERE segments.date ${dateClause}
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

// ── Meta date resolver ───────────────────────────────────────────────────────
function resolveMetaDateOpts(dateRange, startDate, endDate, presetMap) {
    if (dateRange === "CUSTOM" && startDate && endDate) {
        return { preset: null, timeRange: { since: startDate, until: endDate } };
    }
    return { preset: presetMap[dateRange] || "this_month", timeRange: null };
}

// ── GAQL date clause resolver ────────────────────────────────────────────────
function resolveGaqlDateClause(dateRange, startDate, endDate) {
    if (dateRange === "YEAR_TO_DATE") {
        const { today } = getDateInfo();
        const yd = new Date(today); yd.setDate(yd.getDate() - 1);
        const yearStart = `${today.slice(0, 4)}-01-01`;
        const yFmt = `${yd.getFullYear()}-${String(yd.getMonth()+1).padStart(2,"0")}-${String(yd.getDate()).padStart(2,"0")}`;
        return `BETWEEN '${yearStart}' AND '${yFmt}'`;
    }
    if (dateRange === "CUSTOM" && startDate && endDate) {
        return `BETWEEN '${startDate}' AND '${endDate}'`;
    }
    return `DURING ${dateRange}`;
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
    if (comparison === "year_over_year") {
        const yearStart = new Date(today.getFullYear(), 0, 1);
        const lastYearStart = new Date(today.getFullYear() - 1, 0, 1);
        const lastYearEnd = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
        lastYearEnd.setDate(lastYearEnd.getDate() - 1);
        return {
            p1: { start: fmt(yearStart),     end: fmt(shift(today, -1)), label: `${today.getFullYear()} YTD` },
            p2: { start: fmt(lastYearStart), end: fmt(lastYearEnd),      label: `${today.getFullYear() - 1} Same Period` },
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
async function fetchSearchTerms(token, customerId, mccId, dateRange, startDate, endDate) {
    const dateClause = resolveGaqlDateClause(dateRange, startDate, endDate);
    const campRows = await googleSearch(token, customerId, mccId, `
        SELECT campaign.name, ad_group.name,
               metrics.cost_micros, metrics.clicks, metrics.impressions,
               metrics.conversions, metrics.average_cpc, metrics.ctr
        FROM ad_group
        WHERE segments.date ${dateClause} AND metrics.impressions > 0
        ORDER BY metrics.cost_micros DESC`);

    const termRows = await googleSearch(token, customerId, mccId, `
        SELECT search_term_view.search_term, search_term_view.status,
               campaign.name, metrics.cost_micros, metrics.clicks,
               metrics.impressions, metrics.conversions, metrics.ctr, metrics.average_cpc
        FROM search_term_view
        WHERE segments.date ${dateClause} AND metrics.impressions > 0
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

// ── PMax-adjacent search terms (DSA / catch-all campaigns) ───────────────────
async function fetchPmaxSearchTermInsights(token, customerId, mccId, dateRange, startDate, endDate) {
    const dateClause = resolveGaqlDateClause(dateRange, startDate, endDate);

    const termRows = await googleSearch(token, customerId, mccId, `
        SELECT search_term_view.search_term, search_term_view.status,
               campaign.name, campaign.advertising_channel_type,
               metrics.cost_micros, metrics.clicks, metrics.impressions,
               metrics.conversions, metrics.conversions_value,
               metrics.ctr, metrics.average_cpc
        FROM search_term_view
        WHERE segments.date ${dateClause}
          AND metrics.impressions > 0
          AND campaign.advertising_channel_type IN ('MULTI_CHANNEL', 'SEARCH')
        ORDER BY metrics.cost_micros DESC LIMIT 500`);

    const terms = termRows.map(row => ({
        term:         row.searchTermView.searchTerm,
        status:       row.searchTermView.status || "",
        campaign:     row.campaign.name,
        channel_type: row.campaign.advertisingChannelType,
        cost:         parseInt(row.metrics.costMicros || 0) / 1_000_000,
        clicks:       parseInt(row.metrics.clicks || 0),
        impressions:  parseInt(row.metrics.impressions || 0),
        convs:        parseFloat(row.metrics.conversions || 0),
        conv_value:   parseFloat(row.metrics.conversionsValue || 0),
        ctr:          (parseFloat(row.metrics.ctr || 0) * 100).toFixed(1) + "%",
        avg_cpc:      (parseInt(row.metrics.averageCpc || 0) / 1_000_000).toFixed(2),
    }));

    return {
        total_terms: terms.length,
        wasted:      terms.filter(t => t.cost > 3 && t.convs === 0).slice(0, 25),
        converting:  terms.filter(t => t.convs > 0),
        all_terms:   terms,
        note: "These are search terms from DSA and catch-all Search campaigns (the API-visible traffic running alongside PMax). True PMax search themes are only available in the Google Ads UI under the PMax campaign Insights tab → Search categories.",
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

// ── StackAdapt ────────────────────────────────────────────────────────────────
async function stackAdaptGQL(query) {
    if (!STACKADAPT_API_KEY) throw new Error("STACKADAPT_API_KEY env var not set.");
    const resp = await fetchFn(STACKADAPT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${STACKADAPT_API_KEY}` },
        body: JSON.stringify({ query }),
    });
    if (!resp.ok) throw new Error(`StackAdapt API ${resp.status}: ${await resp.text()}`);
    const json = await resp.json();
    if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join("; "));
    return json.data;
}

async function fetchStackAdaptSpend(advertiserId, from, to) {
    const data = await stackAdaptGQL(`{
        campaignDelivery(
            dataType: TABLE
            granularity: TOTAL
            date: { from: "${from}", to: "${to}" }
            filterBy: { advertiserIds: [${parseInt(advertiserId)}] }
        ) {
            ... on CampaignDeliveryOutcome {
                records { nodes { campaign { id name } metrics { cost } } }
            }
        }
    }`);
    const nodes = data?.campaignDelivery?.records?.nodes || [];
    const spend = nodes.reduce((s, n) => s + parseFloat(n.metrics?.cost || 0), 0);
    return { spend, campaigns: nodes.map(n => ({ name: n.campaign?.name, cost: parseFloat(n.metrics?.cost || 0) })) };
}

async function buildStackAdaptRows(pace_dom, dim, today, monthStart, yesterday) {
    const rows = [];
    for (const [advId, info] of Object.entries(STACKADAPT_ADVERTISERS)) {
        const { budget } = getEffectiveBudget(info, today);
        try {
            if (info.flight_start && info.flight_end) {
                const until = yesterday < info.flight_end ? yesterday : info.flight_end;
                const { spend } = await fetchStackAdaptSpend(advId, info.flight_start, until);
                rows.push({ account: info.name, flight_spend: Math.round(spend * 100) / 100,
                    ...getFlightPacing(spend, budget, info.flight_start, info.flight_end, yesterday) });
            } else {
                const { spend } = await fetchStackAdaptSpend(advId, monthStart, yesterday);
                rows.push({ account: info.name, mtd_spend: Math.round(spend * 100) / 100,
                    budget, ...getPacingLabel(spend, budget, pace_dom, dim) });
            }
        } catch (e) { rows.push({ account: info.name, error: e.message }); }
    }
    return rows;
}

// ── Account health helpers ────────────────────────────────────────────────────

function gaqlEsc(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function daysAgo(n, fromDate) {
    const [y, m, d] = fromDate.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d - n)).toISOString().split("T")[0];
}

async function fetchConversionHealth(token, customerId, mccId) {
    // All enabled conversion actions, then 30d/7d volume to spot ones that went silent
    const actions = await googleSearch(token, customerId, mccId, `
        SELECT conversion_action.name, conversion_action.type, conversion_action.category,
               conversion_action.primary_for_goal
        FROM conversion_action
        WHERE conversion_action.status = 'ENABLED'`);
    const volumeQuery = range => googleSearch(token, customerId, mccId, `
        SELECT conversion_action.name, metrics.all_conversions
        FROM conversion_action
        WHERE segments.date DURING ${range}`).catch(() => []);
    const [d30, d7] = await Promise.all([volumeQuery("LAST_30_DAYS"), volumeQuery("LAST_7_DAYS")]);
    const vol = rows => Object.fromEntries(rows.map(r => [r.conversionAction.name, parseFloat(r.metrics?.allConversions || 0)]));
    const v30 = vol(d30), v7 = vol(d7);

    return actions.map(r => {
        const name = r.conversionAction.name;
        const c30 = v30[name] || 0, c7 = v7[name] || 0;
        let health;
        if (c7 > 0)       health = "OK";
        else if (c30 > 0) health = "GONE_SILENT";   // fired in the last 30d but not the last 7d
        else              health = "INACTIVE_30D";  // nothing in 30 days
        return {
            conversion_action: name,
            type:     r.conversionAction.type,
            category: r.conversionAction.category,
            primary:  !!r.conversionAction.primaryForGoal,
            conversions_30d: c30,
            conversions_7d:  c7,
            health,
        };
    });
}

async function fetchAdDisapprovals(token, customerId, mccId) {
    // Ads in enabled campaigns whose policy status is anything other than clean APPROVED
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT campaign.name, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.type,
               ad_group_ad.status,
               ad_group_ad.policy_summary.approval_status,
               ad_group_ad.policy_summary.review_status,
               ad_group_ad.policy_summary.policy_topic_entries
        FROM ad_group_ad
        WHERE ad_group_ad.status != 'REMOVED'
          AND campaign.status = 'ENABLED'
          AND ad_group.status != 'REMOVED'`);
    return rows
        .filter(r => (r.adGroupAd.policySummary?.approvalStatus || "APPROVED") !== "APPROVED")
        .map(r => ({
            campaign:        r.campaign.name,
            ad_group:        r.adGroup.name,
            ad_id:           r.adGroupAd.ad.id,
            ad_type:         r.adGroupAd.ad.type,
            ad_status:       r.adGroupAd.status,
            approval_status: r.adGroupAd.policySummary?.approvalStatus,
            review_status:   r.adGroupAd.policySummary?.reviewStatus,
            policy_topics:   (r.adGroupAd.policySummary?.policyTopicEntries || []).map(t => ({ topic: t.topic, type: t.type })),
        }));
}

async function fetchGoogleDailySpend(token, customerId, mccId, startDate, endDate) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT segments.date, metrics.cost_micros, metrics.clicks
        FROM customer
        WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'`);
    const byDate = {};
    for (const r of rows) {
        byDate[r.segments.date] = (byDate[r.segments.date] || 0) + parseInt(r.metrics?.costMicros || 0) / 1_000_000;
    }
    return byDate;
}

async function fetchMetaDailySpend(accountId, startDate, endDate) {
    const params = new URLSearchParams({
        access_token: META_ACCESS_TOKEN,
        fields: "spend",
        time_range: JSON.stringify({ since: startDate, until: endDate }),
        time_increment: "1",
        level: "account",
    });
    const resp = await fetchFn(`https://graph.facebook.com/${META_API_VERSION}/${accountId}/insights?${params}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);
    const byDate = {};
    for (const row of (data.data || [])) byDate[row.date_start] = parseFloat(row.spend || 0);
    return byDate;
}

function detectSpendAnomaly(byDate, yesterday) {
    // Compare yesterday against the trailing 7-day average before it
    const ydaySpend = byDate[yesterday] || 0;
    const prior = [];
    for (let i = 1; i <= 7; i++) prior.push(byDate[daysAgo(i, yesterday)] ?? 0);
    const avg = prior.reduce((s, v) => s + v, 0) / prior.length;
    if (avg < 5 && ydaySpend < 5) return null; // too small to be meaningful
    const pct = avg > 0 ? Math.round(((ydaySpend - avg) / avg) * 100) : (ydaySpend > 0 ? Infinity : 0);
    if (pct >= 75)  return { type: "SPEND_SPIKE", yesterday: ydaySpend, trailing_7d_avg: Math.round(avg * 100) / 100, change: `+${pct}%` };
    if (pct <= -60) return { type: "SPEND_DROP",  yesterday: ydaySpend, trailing_7d_avg: Math.round(avg * 100) / 100, change: `${pct}%` };
    return null;
}

async function fetchZeroImpressionCampaigns(token, customerId, mccId, yesterday) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT campaign.name, campaign.status, metrics.impressions
        FROM campaign
        WHERE segments.date = '${yesterday}'
          AND campaign.status = 'ENABLED'`);
    return rows.filter(r => parseInt(r.metrics?.impressions || 0) === 0).map(r => r.campaign.name);
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

// ── Helpers for new tools ─────────────────────────────────────────────────────

// list_ad_groups — all non-removed ad groups, optionally filtered by campaign name
async function listAdGroupsFull(token, customerId, mccId, campaignSearch) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT ad_group.resource_name, ad_group.id, ad_group.name, ad_group.status,
               ad_group.type, campaign.name, campaign.resource_name, campaign.status
        FROM ad_group
        WHERE ad_group.status != 'REMOVED'
        ORDER BY campaign.name, ad_group.name`);
    let filtered = rows;
    if (campaignSearch) {
        filtered = rows.filter(r => r.campaign.name.toLowerCase().includes(campaignSearch.toLowerCase()));
    }
    return filtered.map(r => ({
        ad_group_resource: r.adGroup.resourceName,
        ad_group_id:       r.adGroup.id,
        name:              r.adGroup.name,
        status:            r.adGroup.status,
        type:              r.adGroup.type,
        campaign:          r.campaign.name,
        campaign_status:   r.campaign.status,
    }));
}

// get_bidding_strategy — reads current strategy + CPC caps from the campaign resource
async function fetchBiddingStrategies(token, customerId, mccId, campaignSearch) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT campaign.name, campaign.status, campaign.bidding_strategy_type,
               campaign.maximize_clicks.cpc_bid_ceiling_micros,
               campaign.maximize_conversions.target_spend_micros,
               campaign.target_cpa.target_cpa_micros,
               campaign.target_roas.target_roas,
               campaign.manual_cpc.enhanced_cpc_enabled
        FROM campaign
        WHERE campaign.status != 'REMOVED'
        ORDER BY campaign.name`);
    let filtered = rows;
    if (campaignSearch) {
        filtered = rows.filter(r => r.campaign.name.toLowerCase().includes(campaignSearch.toLowerCase()));
    }
    return filtered.map(r => {
        const c = r.campaign;
        const out = {
            campaign:         c.name,
            status:           c.status,
            bidding_strategy: c.biddingStrategyType,
        };
        if (c.maximizeClicks?.cpcBidCeilingMicros) {
            out.cpc_bid_ceiling = "$" + (parseInt(c.maximizeClicks.cpcBidCeilingMicros) / 1_000_000).toFixed(2);
        } else if (c.biddingStrategyType === "MAXIMIZE_CLICKS") {
            out.cpc_bid_ceiling = null; // strategy active but no cap set
        }
        if (c.targetCpa?.targetCpaMicros) {
            out.target_cpa = "$" + (parseInt(c.targetCpa.targetCpaMicros) / 1_000_000).toFixed(2);
        }
        if (c.targetRoas?.targetRoas) {
            out.target_roas = c.targetRoas.targetRoas;
        }
        if (c.manualCpc != null) {
            out.enhanced_cpc = !!c.manualCpc.enhancedCpcEnabled;
        }
        if (c.maximizeConversions?.targetSpendMicros) {
            out.target_spend_cap = "$" + (parseInt(c.maximizeConversions.targetSpendMicros) / 1_000_000).toFixed(2);
        }
        return out;
    });
}

// get_change_history — queries the change_event resource for audit trail
async function fetchChangeHistory(token, customerId, mccId, days, resourceType) {
    const periodMap = { 7: "LAST_7_DAYS", 14: "LAST_14_DAYS", 30: "LAST_30_DAYS" };
    const period = periodMap[days] || "LAST_14_DAYS";
    let where = `change_event.change_date_time DURING ${period}`;
    if (resourceType) where += ` AND change_event.change_resource_type = '${resourceType}'`;
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT change_event.change_date_time,
               change_event.change_resource_type,
               change_event.resource_change_operation,
               change_event.changed_fields,
               change_event.campaign,
               change_event.ad_group
        FROM change_event
        WHERE ${where}
        ORDER BY change_event.change_date_time DESC
        LIMIT 200`);
    return rows.map(r => {
        const e = r.changeEvent;
        return {
            timestamp:      e.changeDateTime,
            resource_type:  e.changeResourceType,
            operation:      e.resourceChangeOperation,
            changed_fields: e.changedFields || null,
            campaign:       e.campaign  || null,
            ad_group:       e.adGroup   || null,
        };
    });
}

// set_google_budget — campaign lookup without the THIS_MONTH date filter so it
// finds campaigns regardless of whether they've spent anything this month.
async function listGoogleCampaignsAll(token, customerId, mccId) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT campaign.name, campaign.status, campaign.advertising_channel_type,
               campaign_budget.amount_micros, campaign.resource_name
        FROM campaign
        WHERE campaign.status != 'REMOVED'
        ORDER BY campaign.name`);
    return rows.map(r => ({
        name:          r.campaign.name,
        status:        r.campaign.status,
        type:          r.campaign.advertisingChannelType,
        daily_budget:  r.campaignBudget?.amountMicros
                           ? "$" + (parseInt(r.campaignBudget.amountMicros) / 1_000_000).toFixed(2)
                           : null,
        resource_name: r.campaign.resourceName,
    }));
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
                        description: "THIS_MONTH (default), LAST_7_DAYS, LAST_30_DAYS, LAST_90_DAYS, LAST_MONTH, YEAR_TO_DATE, or CUSTOM (requires start_date + end_date)",
                        enum: ["THIS_MONTH", "LAST_7_DAYS", "LAST_30_DAYS", "LAST_90_DAYS", "LAST_MONTH", "YEAR_TO_DATE", "CUSTOM"],
                    },
                    start_date: { type: "string", description: "Start date YYYY-MM-DD (only with CUSTOM)" },
                    end_date:   { type: "string", description: "End date YYYY-MM-DD (only with CUSTOM)" },
                },
                required: ["account_name"],
            },
        },
        {
            name: "get_pmax_search_terms",
            description: "Pull search terms from DSA (Dynamic Search Ads) and catch-all campaigns that run alongside PMax. True PMax search themes are only visible in the Google Ads UI (Insights tab → Search categories) and cannot be pulled via the API. This tool surfaces the API-visible equivalent: DSA and branded campaign queries with spend, clicks, conversions. Useful for finding keyword migration opportunities.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    date_range: {
                        type: "string",
                        description: "THIS_MONTH (default), LAST_7_DAYS, LAST_30_DAYS, LAST_90_DAYS, LAST_MONTH, YEAR_TO_DATE, or CUSTOM (requires start_date + end_date)",
                        enum: ["THIS_MONTH", "LAST_7_DAYS", "LAST_30_DAYS", "LAST_90_DAYS", "LAST_MONTH", "YEAR_TO_DATE", "CUSTOM"],
                    },
                    start_date: { type: "string", description: "Start date YYYY-MM-DD (only with CUSTOM)" },
                    end_date:   { type: "string", description: "End date YYYY-MM-DD (only with CUSTOM)" },
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
                        description: "THIS_MONTH (default), LAST_7_DAYS, LAST_30_DAYS, LAST_90_DAYS, LAST_MONTH, YEAR_TO_DATE, or CUSTOM (requires start_date + end_date)",
                        enum: ["THIS_MONTH", "LAST_7_DAYS", "LAST_30_DAYS", "LAST_90_DAYS", "LAST_MONTH", "YEAR_TO_DATE", "CUSTOM"],
                    },
                    start_date: { type: "string", description: "Start date YYYY-MM-DD (only with CUSTOM)" },
                    end_date:   { type: "string", description: "End date YYYY-MM-DD (only with CUSTOM)" },
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
            description: "Pull full campaign-level performance metrics — spend, clicks, impressions, CTR, CPC, conversions, CPA, ROAS — for Google Ads and/or Meta accounts. Supports YTD and custom date ranges.",
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
                        description: "THIS_MONTH (default), LAST_7_DAYS, LAST_30_DAYS, LAST_90_DAYS, LAST_MONTH, YEAR_TO_DATE, or CUSTOM (requires start_date + end_date)",
                        enum: ["THIS_MONTH", "LAST_7_DAYS", "LAST_30_DAYS", "LAST_90_DAYS", "LAST_MONTH", "YEAR_TO_DATE", "CUSTOM"],
                    },
                    start_date: { type: "string", description: "Start date YYYY-MM-DD (only with CUSTOM)" },
                    end_date:   { type: "string", description: "End date YYYY-MM-DD (only with CUSTOM)" },
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
            description: "Pull keyword-level metrics including Quality Score, impression share, CPC, CTR, and conversions for a Google Ads account. Supports YTD and custom date ranges.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    date_range: {
                        type: "string",
                        description: "THIS_MONTH (default), LAST_7_DAYS, LAST_30_DAYS, LAST_90_DAYS, LAST_MONTH, YEAR_TO_DATE, or CUSTOM (requires start_date + end_date)",
                        enum: ["THIS_MONTH", "LAST_7_DAYS", "LAST_30_DAYS", "LAST_90_DAYS", "LAST_MONTH", "YEAR_TO_DATE", "CUSTOM"],
                    },
                    start_date: { type: "string", description: "Start date YYYY-MM-DD (only with CUSTOM)" },
                    end_date:   { type: "string", description: "End date YYYY-MM-DD (only with CUSTOM)" },
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
            description: "Compare performance metrics across two time periods for an account — this month vs last, last 7 vs prior 7, last 30 vs prior 30, or year-over-year (YTD this year vs same days last year). Shows % change for spend, clicks, CPC, conversions, CPA, ROAS.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    comparison: {
                        type: "string",
                        description: "this_month_vs_last_month | last_7_days_vs_prior_7_days | last_30_days_vs_prior_30_days | year_over_year",
                        enum: ["this_month_vs_last_month", "last_7_days_vs_prior_7_days", "last_30_days_vs_prior_30_days", "year_over_year"],
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
            name: "get_monthly_trend",
            description: "Month-by-month performance breakdown for the current year (or custom range). Returns spend, clicks, impressions, conversions, CPA, and ROAS per month. Great for spotting trends and seasonality.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    platform: {
                        type: "string",
                        description: "google (default), meta, or both",
                        enum: ["google", "meta", "both"],
                    },
                    year: { type: "number", description: "Year to analyze (default: current year)" },
                },
                required: ["account_name"],
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
            name: "get_conversion_health",
            description: "Check Google Ads conversion tracking health — lists every enabled conversion action with 30-day and 7-day volume and flags actions that have GONE_SILENT (fired in 30d but not 7d — possible broken tag) or are INACTIVE_30D. Run across all accounts or one.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok). Omit to check all accounts." },
                },
                required: [],
            },
        },
        {
            name: "get_ad_disapprovals",
            description: "Find disapproved or limited ads across Google Ads accounts — pulls policy approval status and policy topics for every ad in enabled campaigns. Run across all accounts or one.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok). Omit to check all accounts." },
                },
                required: [],
            },
        },
        {
            name: "check_anomalies",
            description: "Scan all accounts for spend anomalies — yesterday's spend vs trailing 7-day average (spikes ≥ +75%, drops ≤ -60%) on Google and Meta, plus enabled Google campaigns that served zero impressions yesterday.",
            inputSchema: {
                type: "object",
                properties: {
                    platform: { type: "string", enum: ["google", "meta", "both"], description: "Platform to scan (default: both)" },
                },
                required: [],
            },
        },
        {
            name: "health_check",
            description: "Verify API credentials are working — Google Ads token refresh, Meta token validity and expiration date (Meta tokens expire ~every 60 days). Run this if tools start failing, or weekly as a precaution.",
            inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
            name: "manage_accounts",
            description: "List, add, update, or remove tracked client accounts (Google Ads, Meta, StackAdapt) without code changes. " +
                "Writes to accounts.json. Dry run by default — set confirm=true to save. " +
                "After saving, commit accounts.json to git so Railway picks up the change.",
            inputSchema: {
                type: "object",
                properties: {
                    action:   { type: "string", enum: ["list", "add", "update", "remove"], description: "What to do (default: list)" },
                    platform: { type: "string", enum: ["google", "meta", "stackadapt"], description: "Which platform the account belongs to. Required for add/update/remove." },
                    id:       { type: "string", description: "Account ID — Google customer ID (10 digits), Meta act_XXX, or StackAdapt advertiser ID. Required for add/update/remove." },
                    name:     { type: "string", description: "Client display name (required for add)" },
                    budget:   { type: "number", description: "Monthly budget in dollars (required for add; flights use total flight budget)" },
                    mcc:      { type: "string", description: "Google only: managing MCC login-customer-id (defaults to the account ID itself)" },
                    ga4:      { type: "string", description: "Google only: GA4 property ID" },
                    nc_budget: { type: "number", description: "Google only: NC sub-budget (Boulevard Carroll pattern)" },
                    flight_start: { type: "string", description: "YYYY-MM-DD — set with flight_end for flight-based pacing instead of monthly" },
                    flight_end:   { type: "string", description: "YYYY-MM-DD — last day of the flight" },
                    budget_schedule: {
                        type: "array",
                        description: "Future budget changes: [{from: 'YYYY-MM-DD', budget: 2000}]",
                        items: { type: "object", properties: { from: { type: "string" }, budget: { type: "number" }, nc_budget: { type: "number" } }, required: ["from"] },
                    },
                    confirm: { type: "boolean", description: "Set true to write accounts.json. Omit for dry run." },
                },
                required: [],
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
        {
            name: "duplicate_meta_campaign",
            description: "Duplicate a Meta campaign (deep copy including ad sets and ads). " +
                "Designed for monthly campaign cloning — e.g. copying NSW's campaign at the start of each month. " +
                "Dry run by default — set confirm=true to apply.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:     { type: "string", description: "Meta account name (partial match ok)" },
                    source_campaign:  { type: "string", description: "Name of the campaign to duplicate (partial match ok)" },
                    new_name:         { type: "string", description: "Name for the new campaign. Defaults to 'Copy of [original name]'." },
                    status:           { type: "string", enum: ["PAUSED", "ACTIVE", "INHERITED_FROM_SOURCE"], description: "Status for the copy (default: PAUSED)" },
                    confirm:          { type: "boolean", description: "Set true to create the copy. Omit for dry-run preview." },
                },
                required: ["account_name", "source_campaign"],
            },
        },
        {
            name: "get_change_history",
            description: "Pull the Google Ads change event log for an account — who changed what and when. " +
                "Useful for investigating removed keywords, budget changes, or status changes. " +
                "Covers the last 7, 14, or 30 days. Optionally filter to a specific resource type.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:  { type: "string", description: "Client name (partial match ok)" },
                    days:          { type: "number", enum: [7, 14, 30], description: "How far back to look (default: 14)" },
                    resource_type: {
                        type: "string",
                        description: "Filter to a specific resource type. AD_GROUP_CRITERION = keywords, CAMPAIGN_CRITERION = campaign negatives.",
                        enum: ["CAMPAIGN", "AD_GROUP", "AD", "AD_GROUP_CRITERION", "CAMPAIGN_CRITERION", "CAMPAIGN_BUDGET"],
                    },
                },
                required: ["account_name"],
            },
        },
        {
            name: "get_bidding_strategy",
            description: "Read the current bidding strategy and any CPC caps or target values for all campaigns in a Google Ads account. " +
                "Use to check whether a MAXIMIZE_CLICKS campaign has a CPC cap set, or to see current Target CPA/ROAS targets. " +
                "Optionally filter to a specific campaign.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:  { type: "string", description: "Client name (partial match ok)" },
                    campaign_name: { type: "string", description: "Campaign name filter (partial match ok). Omit to see all campaigns." },
                },
                required: ["account_name"],
            },
        },
        {
            name: "list_ad_groups",
            description: "List all ad groups (with resource names) in a Google Ads account or campaign. " +
                "Returns the ad_group_resource needed for populate_ad_group and add_negative_keywords. " +
                "Optionally filter to a specific campaign.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:  { type: "string", description: "Client name (partial match ok)" },
                    campaign_name: { type: "string", description: "Filter to a specific campaign (partial match ok). Omit for all campaigns." },
                },
                required: ["account_name"],
            },
        },
        {
            name: "set_google_budget",
            description: "Set the daily budget for a Google Ads campaign. Unlike update_budget, this works even for campaigns with no spend this month. " +
                "Dry run by default — set confirm=true to apply.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:  { type: "string", description: "Client name (partial match ok)" },
                    campaign_name: { type: "string", description: "Campaign name (partial match ok)" },
                    daily_budget:  { type: "number", description: "New daily budget in dollars" },
                    confirm:       { type: "boolean", description: "Set true to apply. Omit for dry run." },
                },
                required: ["account_name", "campaign_name", "daily_budget"],
            },
        },
    ],
}));

async function handleToolCall(name, args = {}) {
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
        if (Object.keys(STACKADAPT_ADVERTISERS).length) {
            result.stackadapt = await buildStackAdaptRows(pace_dom, dim, today, month_start, yesterday);
        }

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
        const startDate = args.start_date;
        const endDate   = args.end_date;
        const match     = Object.entries(GOOGLE_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account found matching '${args.account_name}'` };
        } else {
            const [cid, info] = match;
            const { token, error } = await getGoogleAccessToken();
            if (error) { result = { error: `Auth failed: ${error}` }; }
            else {
                try {
                    result = { account: info.name, date_range: dateRange, ...(await fetchSearchTerms(token, cid, info.mcc, dateRange, startDate, endDate)) };
                } catch (e) {
                    result = { error: e.message };
                }
            }
        }

    } else if (name === "get_pmax_search_terms") {
        const search    = (args.account_name || "").toLowerCase();
        const dateRange = args.date_range || "THIS_MONTH";
        const startDate = args.start_date;
        const endDate   = args.end_date;
        const match     = Object.entries(GOOGLE_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account found matching '${args.account_name}'` };
        } else {
            const [cid, info] = match;
            const { token, error } = await getGoogleAccessToken();
            if (error) { result = { error: `Auth failed: ${error}` }; }
            else {
                try {
                    result = { account: info.name, date_range: dateRange, ...(await fetchPmaxSearchTermInsights(token, cid, info.mcc, dateRange, startDate, endDate)) };
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
                        const effectiveRange = (dateRange === "CUSTOM" && args.start_date && args.end_date) ? "CUSTOM" : dateRange;
                        const report = await fetchGA4Report(token, info.ga4, effectiveRange, breakdown, args.start_date, args.end_date);
                        result = { account: info.name, ga4_property: info.ga4, date_range: dateRange, breakdown, ...report };
                    } catch (e) { result = { error: e.message }; }
                }
            }
        }

    } else if (name === "get_campaign_performance") {
        const search    = (args.account_name || "").toLowerCase();
        const platform  = args.platform || "google";
        const dateRange = args.date_range || "THIS_MONTH";
        const startDate = args.start_date;
        const endDate   = args.end_date;
        const metaPresetMap = {
            THIS_MONTH: "this_month", LAST_MONTH: "last_month",
            LAST_30_DAYS: "last_30_days", LAST_90_DAYS: "last_90_days", LAST_7_DAYS: "last_7_days",
            YEAR_TO_DATE: "this_year",
        };

        result = { account: args.account_name, date_range: dateRange };
        if (startDate) result.start_date = startDate;
        if (endDate)   result.end_date = endDate;

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
                        result.google = { account: info.name, campaigns: await fetchGoogleCampaignPerf(token, cid, info.mcc, dateRange, startDate, endDate) };
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
                    const metaDateOpts = resolveMetaDateOpts(dateRange, startDate, endDate, metaPresetMap);
                    result.meta = { account: info.name, campaigns: await fetchMetaCampaignPerf(accountId, metaDateOpts.preset, metaDateOpts.timeRange) };
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
        const startDate = args.start_date;
        const endDate   = args.end_date;
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
                    let keywords = await fetchGoogleKeywordPerf(token, cid, info.mcc, dateRange, startDate, endDate);
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

    } else if (name === "get_monthly_trend") {
        const search   = (args.account_name || "").toLowerCase();
        const platform = args.platform || "google";
        const year     = args.year || new Date().getFullYear();
        result = { account: args.account_name, year, platform };

        try {
            if (platform === "google" || platform === "both") {
                const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
                if (!match) { result.google_error = `No Google account matching '${args.account_name}'`; }
                else {
                    const [cid, info] = match;
                    const { token, error: authErr } = await getGoogleAccessToken();
                    if (authErr) { result.google_error = authErr; }
                    else {
                        result.google = { account: info.name, ...(await fetchGoogleMonthlyTrend(token, cid, info.mcc, year)) };
                    }
                }
            }
            if (platform === "meta" || platform === "both") {
                const match = Object.entries(META_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
                if (!match) { result.meta_error = `No Meta account matching '${args.account_name}'`; }
                else {
                    const [accountId, info] = match;
                    result.meta = { account: info.name, ...(await fetchMetaMonthlyTrend(accountId, year)) };
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

    } else if (name === "get_conversion_health") {
        const search = (args.account_name || "").toLowerCase();
        const { token, error: authErr } = await getGoogleAccessToken();
        if (authErr) { result = { error: `Auth: ${authErr}` }; }
        else {
            const targets = Object.entries(GOOGLE_ACCOUNTS)
                .filter(([, i]) => !search || i.name.toLowerCase().includes(search));
            if (!targets.length) { result = { error: `No Google account matching '${args.account_name}'` }; }
            else {
                const accounts = [];
                for (const [cid, info] of targets) {
                    try {
                        const actions = await fetchConversionHealth(token, cid, info.mcc);
                        const silent   = actions.filter(a => a.health === "GONE_SILENT");
                        const inactive = actions.filter(a => a.health === "INACTIVE_30D");
                        const allSilent = actions.length > 0 && actions.every(a => a.conversions_7d === 0);
                        accounts.push({
                            account: info.name,
                            total_actions: actions.length,
                            alert: allSilent ? "⚠️ NO conversion action fired in 7 days — tracking may be broken account-wide"
                                 : silent.length ? `${silent.length} action(s) gone silent in the last 7 days`
                                 : null,
                            gone_silent: silent,
                            inactive_30d: inactive,
                            healthy: actions.filter(a => a.health === "OK"),
                        });
                    } catch (e) { accounts.push({ account: info.name, error: e.message }); }
                }
                result = { checked: accounts.length, accounts };
            }
        }

    } else if (name === "get_ad_disapprovals") {
        const search = (args.account_name || "").toLowerCase();
        const { token, error: authErr } = await getGoogleAccessToken();
        if (authErr) { result = { error: `Auth: ${authErr}` }; }
        else {
            const targets = Object.entries(GOOGLE_ACCOUNTS)
                .filter(([, i]) => !search || i.name.toLowerCase().includes(search));
            if (!targets.length) { result = { error: `No Google account matching '${args.account_name}'` }; }
            else {
                const accounts = [];
                let totalIssues = 0;
                for (const [cid, info] of targets) {
                    try {
                        const issues = await fetchAdDisapprovals(token, cid, info.mcc);
                        totalIssues += issues.length;
                        if (issues.length) accounts.push({ account: info.name, issue_count: issues.length, ads: issues });
                    } catch (e) { accounts.push({ account: info.name, error: e.message }); }
                }
                result = {
                    checked: targets.length,
                    total_flagged_ads: totalIssues,
                    message: totalIssues === 0 ? "✅ All ads in enabled campaigns are fully approved." : `${totalIssues} ad(s) need attention.`,
                    accounts,
                };
            }
        }

    } else if (name === "check_anomalies") {
        const platform = args.platform || "both";
        const start8   = daysAgo(8, yesterday);
        const flags    = [];
        const errors   = [];

        if (platform === "google" || platform === "both") {
            const { token, error: authErr } = await getGoogleAccessToken();
            if (authErr) { errors.push(`Google auth: ${authErr}`); }
            else {
                for (const [cid, info] of Object.entries(GOOGLE_ACCOUNTS)) {
                    if (info.flight_end && info.flight_end < yesterday) continue; // flight over — spend stopping is expected
                    try {
                        const [byDate, zeroImp] = await Promise.all([
                            fetchGoogleDailySpend(token, cid, info.mcc, start8, yesterday),
                            fetchZeroImpressionCampaigns(token, cid, info.mcc, yesterday),
                        ]);
                        const anomaly = detectSpendAnomaly(byDate, yesterday);
                        if (anomaly) flags.push({ platform: "Google", account: info.name, ...anomaly });
                        if (zeroImp.length) flags.push({ platform: "Google", account: info.name, type: "ZERO_IMPRESSIONS_YESTERDAY", campaigns: zeroImp });
                    } catch (e) { errors.push(`${info.name} (Google): ${e.message}`); }
                }
            }
        }

        if (platform === "meta" || platform === "both") {
            for (const [accountId, info] of Object.entries(META_ACCOUNTS)) {
                if (info.flight_end && info.flight_end < yesterday) continue; // flight over — spend stopping is expected
                try {
                    const byDate  = await fetchMetaDailySpend(accountId, start8, yesterday);
                    const anomaly = detectSpendAnomaly(byDate, yesterday);
                    if (anomaly) flags.push({ platform: "Meta", account: info.name, ...anomaly });
                } catch (e) { errors.push(`${info.name} (Meta): ${e.message}`); }
            }
        }

        result = {
            date_checked: yesterday,
            anomalies_found: flags.length,
            message: flags.length === 0 ? "✅ No spend anomalies detected." : `${flags.length} anomaly(ies) found — review below.`,
            anomalies: flags,
            ...(errors.length ? { errors } : {}),
        };

    } else if (name === "health_check") {
        const checks = {};

        // Google: token refresh + a trivial query against the first account
        const { token, error: gErr } = await getGoogleAccessToken();
        if (gErr) {
            checks.google = { status: "❌ FAILING", error: gErr };
        } else {
            try {
                const [cid, info] = Object.entries(GOOGLE_ACCOUNTS)[0];
                await googleSearch(token, cid, info.mcc, "SELECT customer.id FROM customer LIMIT 1");
                checks.google = { status: "✅ OK", note: "Token refresh and API query both working." };
            } catch (e) {
                checks.google = { status: "⚠️ TOKEN OK, QUERY FAILING", error: e.message };
            }
        }

        // Meta: identity + token expiry via debug_token
        try {
            const me = await metaGet("me", { fields: "id,name" });
            let expiry = null;
            try {
                const dbg = await metaGet("debug_token", { input_token: META_ACCESS_TOKEN });
                const exp  = dbg.data?.expires_at;
                const dexp = dbg.data?.data_access_expires_at;
                const days = ts => ts ? Math.floor((ts * 1000 - Date.now()) / 86400000) : null;
                expiry = {
                    token_expires:        exp === 0 ? "never" : exp ? `${days(exp)} days (${new Date(exp * 1000).toISOString().split("T")[0]})` : "unknown",
                    data_access_expires:  dexp ? `${days(dexp)} days (${new Date(dexp * 1000).toISOString().split("T")[0]})` : "unknown",
                };
                const soonest = Math.min(...[exp, dexp].filter(t => t > 0).map(t => days(t)));
                if (isFinite(soonest) && soonest <= 14) expiry.warning = `⚠️ Meta token expires in ${soonest} days — regenerate it soon.`;
            } catch (_) { /* debug_token can fail on some token types; identity check already passed */ }
            checks.meta = { status: "✅ OK", authenticated_as: me.name, ...(expiry ? { expiry } : {}) };
        } catch (e) {
            checks.meta = { status: "❌ FAILING", error: e.message };
        }

        checks.accounts_tracked = {
            google: Object.keys(GOOGLE_ACCOUNTS).length,
            meta: Object.keys(META_ACCOUNTS).length,
            stackadapt: Object.keys(STACKADAPT_ADVERTISERS).length,
        };
        result = checks;

    } else if (name === "manage_accounts") {
        const action   = args.action || "list";
        const platform = args.platform;
        const confirm  = !!args.confirm;
        const stores   = { google: GOOGLE_ACCOUNTS, meta: META_ACCOUNTS, stackadapt: STACKADAPT_ADVERTISERS };

        if (action === "list") {
            result = {
                accounts_file: ACCOUNTS_FILE,
                google:     Object.entries(GOOGLE_ACCOUNTS).map(([id, a]) => ({ id, ...a })),
                meta:       Object.entries(META_ACCOUNTS).map(([id, a]) => ({ id, ...a })),
                stackadapt: Object.entries(STACKADAPT_ADVERTISERS).map(([id, a]) => ({ id, ...a })),
            };
        } else if (!platform || !stores[platform]) {
            result = { error: "platform (google | meta | stackadapt) is required for add/update/remove." };
        } else if (!args.id) {
            result = { error: "id is required for add/update/remove." };
        } else {
            const store = stores[platform];
            const id    = platform === "meta" && !args.id.startsWith("act_") ? `act_${args.id}` : args.id;

            if (action === "add") {
                if (store[id]) {
                    result = { error: `${id} already exists (${store[id].name}). Use action=update to modify it.` };
                } else if (!args.name || args.budget == null) {
                    result = { error: "name and budget are required for add." };
                } else {
                    const entry = { name: args.name, budget: args.budget };
                    if (platform === "google") entry.mcc = args.mcc || id;
                    for (const f of ["ga4", "nc_budget", "flight_start", "flight_end", "budget_schedule"]) {
                        if (args[f] != null) entry[f] = args[f];
                    }
                    if (!confirm) {
                        result = { dry_run: true, message: "DRY RUN — set confirm=true to save", platform, id, entry };
                    } else {
                        store[id] = entry;
                        saveAccounts();
                        result = { success: true, platform, id, entry, note: "Saved to accounts.json. Commit + push to git so Railway picks it up." };
                    }
                }
            } else if (action === "update") {
                if (!store[id]) {
                    result = { error: `${id} not found in ${platform} accounts.`, available: Object.entries(store).map(([k, a]) => `${k} (${a.name})`) };
                } else {
                    const changes = {};
                    for (const f of ["name", "budget", "mcc", "ga4", "nc_budget", "flight_start", "flight_end", "budget_schedule"]) {
                        if (args[f] != null) changes[f] = args[f];
                    }
                    if (!Object.keys(changes).length) {
                        result = { error: "No fields to update. Provide name, budget, mcc, ga4, nc_budget, flight_start, flight_end, or budget_schedule." };
                    } else if (!confirm) {
                        result = { dry_run: true, message: "DRY RUN — set confirm=true to save", platform, id, current: store[id], changes };
                    } else {
                        Object.assign(store[id], changes);
                        saveAccounts();
                        result = { success: true, platform, id, account: store[id], note: "Saved to accounts.json. Commit + push to git so Railway picks it up." };
                    }
                }
            } else if (action === "remove") {
                if (!store[id]) {
                    result = { error: `${id} not found in ${platform} accounts.` };
                } else if (!confirm) {
                    result = { dry_run: true, message: "DRY RUN — set confirm=true to remove", platform, id, account: store[id] };
                } else {
                    const removed = store[id];
                    delete store[id];
                    saveAccounts();
                    result = { success: true, removed: { id, ...removed }, note: "Saved to accounts.json. Commit + push to git so Railway picks it up." };
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

    } else if (name === "duplicate_meta_campaign") {
        const search       = (args.account_name || "").toLowerCase();
        const campSearch   = (args.source_campaign || "").toLowerCase();
        const confirm      = !!args.confirm;
        const dupStatus    = (args.status || "PAUSED").toUpperCase();

        const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!acctMatch) {
            result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
        } else {
            const [accountId, acctInfo] = acctMatch;
            try {
                const campaigns = await getMetaCampaigns(accountId);
                const camp = campaigns.find(c => c.name.toLowerCase().includes(campSearch));
                if (!camp) {
                    result = { error: `No campaign matching '${args.source_campaign}'`, available: campaigns.map(c => c.name) };
                } else {
                    const copyName = args.new_name || `Copy of ${camp.name}`;
                    if (!confirm) {
                        result = {
                            dry_run:    true,
                            message:    "DRY RUN — set confirm=true to create the copy",
                            account:    acctInfo.name,
                            source:     { id: camp.id, name: camp.name, status: camp.status },
                            new_name:   copyName,
                            new_status: dupStatus,
                            note:       "deep_copy=true — ad sets and ads will be duplicated",
                        };
                    } else {
                        const res = await metaDuplicate(camp.id, "campaign", copyName, dupStatus);
                        result = {
                            success:    true,
                            account:    acctInfo.name,
                            source:     { id: camp.id, name: camp.name },
                            new_id:     res.new_id,
                            new_name:   copyName,
                            new_status: dupStatus,
                        };
                    }
                }
            } catch (e) {
                result = { error: e.message };
            }
        }

    } else if (name === "get_change_history") {
        const search       = (args.account_name || "").toLowerCase();
        const days         = args.days || 14;
        const resourceType = args.resource_type || null;

        const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account found matching '${args.account_name}'` };
        } else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken();
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    const events = await fetchChangeHistory(token, cid, info.mcc, days, resourceType);
                    const summary = {};
                    for (const e of events) {
                        const key = `${e.resource_type}:${e.operation}`;
                        summary[key] = (summary[key] || 0) + 1;
                    }
                    result = {
                        account:       info.name,
                        days_back:     days,
                        resource_type: resourceType || "all",
                        total_changes: events.length,
                        summary,
                        changes:       events,
                    };
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "get_bidding_strategy") {
        const search     = (args.account_name || "").toLowerCase();
        const campSearch = args.campaign_name ? args.campaign_name.toLowerCase() : null;

        const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account found matching '${args.account_name}'` };
        } else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken();
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    const campaigns = await fetchBiddingStrategies(token, cid, info.mcc, campSearch);
                    result = {
                        account:        info.name,
                        campaign_count: campaigns.length,
                        campaigns,
                    };
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "list_ad_groups") {
        const search     = (args.account_name || "").toLowerCase();
        const campSearch = args.campaign_name ? args.campaign_name.toLowerCase() : null;

        const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account found matching '${args.account_name}'` };
        } else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken();
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    const adGroups = await listAdGroupsFull(token, cid, info.mcc, campSearch);
                    result = {
                        account:       info.name,
                        campaign_filter: campSearch || "all",
                        ad_group_count: adGroups.length,
                        ad_groups:     adGroups,
                    };
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "set_google_budget") {
        const search     = (args.account_name || "").toLowerCase();
        const campSearch = (args.campaign_name || "").toLowerCase();
        const daily      = args.daily_budget;
        const confirm    = !!args.confirm;

        if (!daily || daily <= 0) {
            result = { error: "daily_budget must be a positive number." };
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
                        // Use the no-date-filter listing so paused/new campaigns appear
                        const campaigns = await listGoogleCampaignsAll(token, cid, info.mcc);
                        const camp = campaigns.find(c => c.name.toLowerCase().includes(campSearch));
                        if (!camp) {
                            result = { error: `No campaign matching '${args.campaign_name}'`, available: campaigns.map(c => c.name) };
                        } else if (!confirm) {
                            result = {
                                dry_run:          true,
                                message:          "DRY RUN — set confirm=true to apply",
                                account:          info.name,
                                campaign:         camp.name,
                                status:           camp.status,
                                current_daily_budget: camp.daily_budget,
                                new_daily_budget: "$" + daily.toFixed(2),
                            };
                        } else {
                            const r = await updateGoogleCampaignBudget(token, cid, info.mcc, camp.resource_name, daily);
                            result = { success: true, account: info.name, campaign: camp.name, ...r };
                        }
                    } catch (e) { result = { error: e.message }; }
                }
            }
        }

    } else {
        result = { error: `Unknown tool: ${name}` };
    }

    return result;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await handleToolCall(name, args || {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

async function main() {
    const PORT = process.env.PORT;

    if (PORT) {
        // ── HTTP/SSE mode (Railway) ──────────────────────────────────────────
        // Auth: every /sse connection must present MCP_AUTH_TOKEN, either as
        // "Authorization: Bearer <token>" or "?token=<token>" (EventSource
        // clients can't set headers). /messages is protected by the session ID,
        // which only exists after an authenticated /sse handshake.
        // Fails closed: if MCP_AUTH_TOKEN is unset, all connections are refused.
        const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || null;
        if (!AUTH_TOKEN) {
            console.error("WARNING: MCP_AUTH_TOKEN is not set — refusing all SSE connections until it is configured in Railway Variables.");
        }

        const isAuthorized = (req, url) => {
            if (!AUTH_TOKEN) return false;
            const header = req.headers["authorization"] || "";
            if (header === `Bearer ${AUTH_TOKEN}`) return true;
            if (url.searchParams.get("token") === AUTH_TOKEN) return true;
            return false;
        };

        const transports = {};

        const httpServer = http.createServer(async (req, res) => {
            const url = new URL(req.url, `http://localhost`);

            if (url.pathname === "/sse") {
                if (!isAuthorized(req, url)) {
                    res.writeHead(401, { "Content-Type": "text/plain" });
                    res.end(AUTH_TOKEN ? "Unauthorized" : "Server auth not configured (MCP_AUTH_TOKEN missing)");
                    return;
                }
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
                res.end("KayComm MCP Server v2 — running" + (AUTH_TOKEN ? "" : " (auth not configured)"));
            }
        });

        httpServer.listen(parseInt(PORT), () => {
            console.error(`KayComm MCP running on port ${PORT} (SSE mode, auth ${AUTH_TOKEN ? "enabled" : "NOT CONFIGURED"})`);
        });

    } else {
        // ── stdio mode (local Claude Desktop) ───────────────────────────────
        const transport = new StdioServerTransport();
        await server.connect(transport);
    }
}

module.exports = { handleToolCall };

if (!process.env.MCP_TEST) main().catch(console.error);
