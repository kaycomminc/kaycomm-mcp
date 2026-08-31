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
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

let fetchFn = globalThis.fetch;
if (!fetchFn) fetchFn = require("node-fetch");

// ── Credentials — loaded from environment variables ───────────────────────────
// Set these in Railway → Variables, and in claude_desktop_config.json env block for local use
const GOOGLE_DEVELOPER_TOKEN = process.env.GOOGLE_DEVELOPER_TOKEN;
const GOOGLE_CLIENT_ID       = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET   = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN   = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_API_VERSION     = "v24";

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_APP_ID       = process.env.META_APP_ID;
const META_APP_SECRET   = process.env.META_APP_SECRET;
const META_API_VERSION  = "v25.0";

const STACKADAPT_API_KEY = process.env.STACKADAPT_API_KEY;
const STACKADAPT_URL     = "https://api.stackadapt.com/graphql";

const LINKEDIN_ACCESS_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;
const LINKEDIN_API_VERSION  = "202608";

// When bumping GOOGLE_API_VERSION or META_API_VERSION above, update `released`
// here by hand to the new version's release date — health_check uses these to
// warn before the provider sunsets the pinned version out from under us.
const API_VERSION_INFO = {
    google: { version: GOOGLE_API_VERSION, released: "2026-04-22", warnAfterMonths: 9 },   // Google sunsets ~12mo after release
    meta:   { version: META_API_VERSION,  released: "2026-02-18", warnAfterMonths: 21 },   // Meta sunsets ~24mo after release
};

// ── Accounts — loaded from accounts.json ─────────────────────────────────────
// Google fields: name, budget, mcc (login-customer-id), nc_budget?, ga4?,
//                budget_schedule? [{from, budget, nc_budget?}], flight_start?, flight_end?,
//                health? (object of threshold overrides, or false to exclude from health checks)
// Meta fields:   name, budget, budget_schedule?, flight_start?, flight_end?, health?
// Health thresholds default from top-level health_defaults; accounts without a
// health key are checked with defaults, so new clients are monitored automatically.
// Edit via the manage_accounts tool — changes persist to accounts.json.
// NOTE: on Railway the filesystem is ephemeral; commit accounts.json to git
// so cloud deploys pick up account changes.
const ACCOUNTS_FILE = path.join(__dirname, "accounts.json");
let GOOGLE_ACCOUNTS = {};
let META_ACCOUNTS = {};
let STACKADAPT_ADVERTISERS = {};
let LINKEDIN_ACCOUNTS = {};
let HEALTH_DEFAULTS = {};

const BUILTIN_HEALTH_DEFAULTS = {
    pacing_tolerance_pct: 15,
    conversion_dry_spell_hours: 72,
    cpa_tolerance_pct: 25,
    roas_tolerance_pct: 20,
    spend_spike_pct: 75,
    spend_drop_pct: -60,
    ctr_degradation_pct: -20,
    ctr_lookback_days: 30,
    quality_score_floor: 5,
    zero_spend_days_threshold: 7,
    budget_exhaustion_is_lost_pct: 20,
};

// Top-level keys the code actually reads off a google/meta account entry
// (grepped from info.* accesses across the file, incl. manage_accounts'
// add/update field lists and getEffectiveBudget's budget_schedule).
const KNOWN_ACCOUNT_KEYS = new Set([
    "name", "budget", "mcc", "nc_budget", "ga4", "health", "refresh_token_env",
    "flight_start", "flight_end", "budget_schedule",
    "page_id", "instagram_account_id",
]);

// Per-account health overrides beyond BUILTIN_HEALTH_DEFAULTS that
// run_health_check/getHealthConfig actually read (grepped for `hc.<key>`).
const KNOWN_HEALTH_EXTRA_KEYS = new Set([
    "conversion_type", "cpa_target", "roas_target", "impression_share_floor", "frequency_cap",
]);

// Validate accounts.json shape without ever throwing — the server must still
// boot even if an entry is malformed. Warnings are prefixed "accounts.json:"
// and the entry id so they're greppable in Railway logs.
function validateAccounts(data) {
    const warn = (id, msg) => console.error(`accounts.json: ${id}: ${msg}`);

    for (const platform of ["google", "meta"]) {
        for (const [id, info] of Object.entries(data[platform] || {})) {
            if (typeof info.name !== "string" || !info.name) {
                warn(id, `missing or non-string "name"`);
            }
            if (typeof info.budget !== "number") {
                warn(id, `"budget" is not a number (got ${JSON.stringify(info.budget)})`);
            }
            if (platform === "google" && !info.mcc && !info.refresh_token_env) {
                warn(id, `google entry missing "mcc" (standalone accounts need "refresh_token_env")`);
            }
            if (info.health !== undefined && info.health !== false && typeof info.health !== "object") {
                warn(id, `"health" must be false or an object (got ${JSON.stringify(info.health)})`);
            } else if (info.health && typeof info.health === "object") {
                for (const key of Object.keys(info.health)) {
                    if (!(key in BUILTIN_HEALTH_DEFAULTS) && !KNOWN_HEALTH_EXTRA_KEYS.has(key)) {
                        warn(id, `unknown health key "${key}"`);
                    }
                }
            }
            for (const key of Object.keys(info)) {
                if (!KNOWN_ACCOUNT_KEYS.has(key)) {
                    warn(id, `unknown top-level key "${key}"`);
                }
            }
        }
    }
}

function loadAccounts() {
    const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
    validateAccounts(data);
    GOOGLE_ACCOUNTS        = data.google     || {};
    for (const [cid, info] of Object.entries(GOOGLE_ACCOUNTS)) {
        if (!info.mcc) info.mcc = cid;
    }
    META_ACCOUNTS          = data.meta       || {};
    STACKADAPT_ADVERTISERS = data.stackadapt || {};
    LINKEDIN_ACCOUNTS      = data.linkedin  || {};
    HEALTH_DEFAULTS        = { ...BUILTIN_HEALTH_DEFAULTS, ...(data.health_defaults || {}) };
}

function saveAccounts() {
    const data = { health_defaults: HEALTH_DEFAULTS, google: GOOGLE_ACCOUNTS, meta: META_ACCOUNTS, stackadapt: STACKADAPT_ADVERTISERS, linkedin: LINKEDIN_ACCOUNTS };
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2) + "\n");
}

// Effective health-check thresholds for an account: null = excluded (health: false),
// otherwise health_defaults merged with the account's overrides.
function getHealthConfig(info) {
    if (info.health === false) return null;
    return { ...HEALTH_DEFAULTS, ...(info.health || {}) };
}

loadAccounts();

// ── Write-action audit log ────────────────────────────────────────────────────
// Every confirmed mutation (any tool called with confirm=true) is appended as a
// JSONL entry — a cross-platform record of what the MCP changed and when.
// NOTE: Railway's filesystem resets on deploy, so the local Mac holds the
// authoritative history.
// On Railway, mount a volume and set WRITE_LOG_FILE=/data/write-log.jsonl so
// the audit log survives deploys; unset, it lives next to server.js.
const WRITE_LOG_FILE = process.env.WRITE_LOG_FILE || path.join(__dirname, "write-log.jsonl");

function logWriteAction(tool, args, result) {
    try {
        const entry = {
            ts:   new Date().toISOString(),
            tool,
            args: Object.fromEntries(Object.entries(args || {}).filter(([k]) => k !== "confirm")),
            ok:   !(result && result.error),
        };
        if (result?.error) entry.error = result.error;
        fs.appendFileSync(WRITE_LOG_FILE, JSON.stringify(entry) + "\n");
    } catch (_) { /* logging must never break a write */ }
}

function readWriteLog({ days = 30, account_name, tool, limit = 50 } = {}) {
    if (!fs.existsSync(WRITE_LOG_FILE)) return [];
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const search = account_name ? account_name.toLowerCase() : null;
    const entries = [];
    for (const line of fs.readFileSync(WRITE_LOG_FILE, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch (_) { continue; }
        if (e.ts < cutoff) continue;
        if (tool && e.tool !== tool) continue;
        if (search && !(e.args?.account_name || e.args?.name || "").toLowerCase().includes(search)) continue;
        entries.push(e);
    }
    return entries.slice(-limit).reverse(); // newest first
}

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

// Pacing tolerance: how far pct_expected can drift from 100% before we call it
// over/under pacing. Kept tight (±5%). Daily-budget recommendations still
// target 100% of budget (not a discounted ceiling) — the tolerance only
// governs when we flag drift and when we call a daily budget ON_TRACK.
const PACING_TOLERANCE_PCT = 5;

function getPacingLabel(spent, budget, dom, dim) {
    if (!budget) return { status: "no_cap" };
    if (!dom)    return { status: "NO_COMPLETE_DAYS_YET", note: "First day of the month — no complete days to pace against yet.", remaining: Math.round((budget - spent) * 100) / 100 };
    const expected    = budget * (dom / dim);
    const pctBudget   = Math.round((spent / budget) * 100 * 10) / 10;
    const pctExpected = expected > 0 ? Math.round((spent / expected) * 100 * 10) / 10 : 0;
    const remaining   = Math.round((budget - spent) * 100) / 100;
    const status      = pctExpected >= 100 + PACING_TOLERANCE_PCT ? "OVERPACING" : pctExpected <= 100 - PACING_TOLERANCE_PCT ? "UNDERPACING" : "ON PACE";
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
    const status      = pctExpected >= 100 + PACING_TOLERANCE_PCT ? "OVERPACING" : pctExpected <= 100 - PACING_TOLERANCE_PCT ? "UNDERPACING" : "ON PACE";
    return {
        status, ...base,
        pct_expected: pctExpected,
        days_remaining: daysLeft,
        needed_per_day: daysLeft > 0 ? Math.round((remaining / daysLeft) * 100) / 100 : null,
        projected_flight_end: Math.round((spent / elapsedDays) * totalDays * 100) / 100,
    };
}

// Compare current campaign daily budgets against the per-day spend needed to
// land exactly on budget. daysRemaining includes today (spend is through yesterday).
function buildDailyBudgetRec(currentDaily, remaining, daysRemaining) {
    if (currentDaily == null || daysRemaining == null || daysRemaining <= 0) return null;
    const needed = Math.round((remaining / daysRemaining) * 100) / 100;
    const out = {
        current_daily_budget: Math.round(currentDaily * 100) / 100,
        needed_per_day: needed,
        days_remaining: daysRemaining,
    };
    if (remaining <= 0) {
        out.recommendation = "BUDGET_EXHAUSTED — monthly budget already spent; pause campaigns or raise the budget.";
    } else if (currentDaily <= 0) {
        out.recommendation = `NO_DAILY_BUDGETS — no enabled daily budgets found; set ~$${needed.toFixed(2)}/day to spend the remaining $${remaining.toFixed(2)}.`;
    } else {
        const diffPct = ((needed - currentDaily) / currentDaily) * 100;
        if (Math.abs(diffPct) <= PACING_TOLERANCE_PCT) {
            out.recommendation = `ON_TRACK — current daily budgets land within ±${PACING_TOLERANCE_PCT}% of budget.`;
        } else if (diffPct > 0) {
            out.recommendation = `RAISE daily budgets $${currentDaily.toFixed(2)} → ~$${needed.toFixed(2)}/day (+${Math.round(diffPct)}%) to hit budget.`;
        } else {
            out.recommendation = `LOWER daily budgets $${currentDaily.toFixed(2)} → ~$${needed.toFixed(2)}/day (${Math.round(diffPct)}%) to avoid overspend.`;
        }
    }
    return out;
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

// Retry helper for read-only fetches: transient 429/5xx and network-level
// failures get retried with exponential backoff + jitter. Never use this for
// mutation calls (googleAds:mutate, metaPost, /copies) — a double-fire on a
// write is worse than a failure, and those callers surface errors directly.
async function fetchWithRetry(url, opts, tries = 3) {
    for (let i = 0; ; i++) {
        try {
            const resp = await fetchFn(url, opts);
            if ((resp.status === 429 || resp.status >= 500) && i < tries - 1) {
                await new Promise(r => setTimeout(r, (2 ** i) * 1000 + Math.random() * 250));
                continue;
            }
            return resp;
        } catch (e) {           // network-level failure
            if (i >= tries - 1) throw e;
            await new Promise(r => setTimeout(r, (2 ** i) * 1000 + Math.random() * 250));
        }
    }
}

// ── Google Auth ───────────────────────────────────────────────────────────────
const _googleTokenCache = {};

function getRefreshTokenForAccount(customerId) {
    const info = GOOGLE_ACCOUNTS[customerId];
    if (info?.refresh_token_env) return process.env[info.refresh_token_env] || null;
    return GOOGLE_REFRESH_TOKEN;
}

async function getGoogleAccessToken(customerId) {
    const refreshToken = customerId ? getRefreshTokenForAccount(customerId) : GOOGLE_REFRESH_TOKEN;
    const cacheKey = refreshToken || "__default__";
    const cached = _googleTokenCache[cacheKey];
    if (cached && Date.now() < cached.expiry) return { token: cached.token, error: null };
    const resp = await fetchWithRetry("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
            refresh_token: refreshToken, grant_type: "refresh_token",
        }),
    });
    const data = await resp.json();
    if (!data.access_token) return { token: null, error: data.error_description || JSON.stringify(data) };
    _googleTokenCache[cacheKey] = { token: data.access_token, expiry: Date.now() + (data.expires_in - 60) * 1000 };
    return { token: data.access_token, error: null };
}

// ── Google Ads API ────────────────────────────────────────────────────────────
// Google Ads buries the real failure (error code + field path) in
// error.details[].errors[]; the top-level message is just "Request contains an
// invalid argument." Flatten the detail errors into the message and log the
// full error body so it's visible in Railway logs.
function googleAdsError(data) {
    const detailErrors = (data?.error?.details || []).flatMap(d => d.errors || []);
    if (!detailErrors.length) return data?.error?.message || JSON.stringify(data);
    console.error("Google Ads API error:", JSON.stringify(data.error));
    return detailErrors.map(e => {
        const code = e.errorCode ? Object.values(e.errorCode)[0] : "UNKNOWN";
        const path = (e.location?.fieldPathElements || [])
            .map(p => p.fieldName + (p.index != null ? `[${p.index}]` : ""))
            .join(".");
        return `${code}: ${e.message}${path ? ` (at ${path})` : ""}`;
    }).join("; ");
}

async function googleSearch(token, customerId, mccId, query) {
    const results = [];
    let pageToken = null;
    do {
        const resp = await fetchWithRetry(
            `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers/${customerId}/googleAds:search`,
            {
                method: "POST",
                headers: {
                    "Authorization":       `Bearer ${token}`,
                    "developer-token":     GOOGLE_DEVELOPER_TOKEN,
                    "login-customer-id":   mccId,
                    "Content-Type":        "application/json",
                },
                body: JSON.stringify(pageToken ? { query, pageToken } : { query }),
            }
        );
        const data = await resp.json();
        if (!resp.ok) throw new Error(googleAdsError(data));
        results.push(...(data.results || []));
        pageToken = data.nextPageToken || null;
    } while (pageToken);
    return results;
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

// Sum of enabled campaigns' daily budgets, deduped by budget resource so shared
// budgets count once. NC split follows the same rule as fetchGoogleMTDbyNC.
async function fetchGoogleDailyBudgets(token, customerId, mccId) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT campaign.name, campaign.advertising_channel_type,
               campaign_budget.resource_name, campaign_budget.amount_micros
        FROM campaign
        WHERE campaign.status = 'ENABLED'`);
    const seen = new Set();
    let total = 0, nc = 0, campaigns = 0;
    for (const row of rows) {
        campaigns++;
        const res = row.campaignBudget?.resourceName;
        if (res && seen.has(res)) continue;
        if (res) seen.add(res);
        const amt = parseInt(row.campaignBudget?.amountMicros || 0) / 1_000_000;
        total += amt;
        const isPmax = row.campaign?.advertisingChannelType === "PERFORMANCE_MAX";
        if (row.campaign?.name?.toUpperCase().includes("NC") && !isPmax) nc += amt;
    }
    return { total, nc, other: total - nc, enabled_campaigns: campaigns };
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
    const resp = await fetchWithRetry(`https://graph.facebook.com/${META_API_VERSION}/${accountId}/insights?${params}`);
    const data = await resp.json();
    if (data.error) return { spend: null, error: data.error.message };
    const spend = data.data?.length ? parseFloat(data.data[0].spend || 0) : 0;
    return { spend, error: null };
}

// Sum of active daily budgets across campaigns (CBO) and ad sets (ABO).
// effective_status filters out anything paused directly or via its parent.
async function fetchMetaDailyBudgets(accountId) {
    const [camps, adsets] = await Promise.all([
        metaGet(`${accountId}/campaigns`, { fields: "id,effective_status,daily_budget,lifetime_budget", limit: 200 }),
        metaGet(`${accountId}/adsets`,    { fields: "id,campaign_id,effective_status,daily_budget,lifetime_budget", limit: 500 }),
    ]);
    let total = 0, hasLifetime = false;
    const campHasBudget = new Set();
    for (const c of (camps.data || [])) {
        if (c.effective_status !== "ACTIVE") continue;
        if (c.daily_budget)    { total += parseInt(c.daily_budget) / 100; campHasBudget.add(c.id); }
        if (c.lifetime_budget) { hasLifetime = true; campHasBudget.add(c.id); }
    }
    for (const s of (adsets.data || [])) {
        if (s.effective_status !== "ACTIVE") continue;
        if (campHasBudget.has(s.campaign_id)) continue;
        if (s.daily_budget)    total += parseInt(s.daily_budget) / 100;
        if (s.lifetime_budget) hasLifetime = true;
    }
    return { total, has_lifetime_budgets: hasLifetime };
}

// ── Row builders ──────────────────────────────────────────────────────────────
// On the 1st of the month (or before a flight starts) the spend window is
// empty — monthStart > yesterday. Meta and StackAdapt reject inverted date
// ranges, and the spend is definitionally $0, so skip the fetch entirely.
const emptyWindow = (start, end) => start > end;

// All accounts are fetched in parallel; each row also carries a daily_budget
// block comparing enabled campaigns' daily budgets to the per-day spend needed
// to land on budget (the actionable lever for pacing fixes).
async function buildGoogleRows(defaultToken, pace_dom, dim, today, monthStart, yesterday) {
    return Promise.all(Object.entries(GOOGLE_ACCOUNTS).map(async ([cid, info]) => {
        let token = defaultToken;
        if (info.refresh_token_env) {
            const { token: t, error } = await getGoogleAccessToken(cid);
            if (error) return { account: info.name, error: `Auth failed: ${error}` };
            token = t;
        }
        const { budget, nc_budget } = getEffectiveBudget(info, today);
        const budgetsPromise = fetchGoogleDailyBudgets(token, cid, info.mcc).catch(() => null);

        if (info.flight_start && info.flight_end) {
            // Flight-based budget: spend over the flight window, paced against flight days
            const until = yesterday < info.flight_end ? yesterday : info.flight_end;
            const [{ spend, error }, budgets] = await Promise.all([
                emptyWindow(info.flight_start, until) ? { spend: 0, error: null }
                    : fetchGoogleMTD(token, cid, info.mcc, info.flight_start, until), budgetsPromise]);
            if (error) return { account: info.name, error };
            const pacing = getFlightPacing(spend, budget, info.flight_start, info.flight_end, yesterday);
            const row = { account: info.name, flight_spend: Math.round(spend * 100) / 100, ...pacing };
            if (budgets && pacing.days_remaining > 0) {
                row.daily_budget = buildDailyBudgetRec(budgets.total, pacing.remaining, pacing.days_remaining);
            }
            return row;
        }

        if (nc_budget) {
            const [{ nc, other, error }, budgets] = await Promise.all([
                emptyWindow(monthStart, yesterday) ? { nc: 0, other: 0, error: null }
                    : fetchGoogleMTDbyNC(token, cid, info.mcc, monthStart, yesterday), budgetsPromise]);
            if (error) return { account: info.name, error };
            const total       = nc + other;
            const ncBudget    = nc_budget;
            const otherBudget = budget - ncBudget;
            const daysLeft    = dim - pace_dom;
            const row = {
                account: info.name, mtd_spend: Math.round(total * 100) / 100,
                budget, ...getPacingLabel(total, budget, pace_dom, dim),
                breakdown: {
                    nc:    { spend: Math.round(nc * 100) / 100,    budget: ncBudget,    ...getPacingLabel(nc, ncBudget, pace_dom, dim) },
                    other: { spend: Math.round(other * 100) / 100, budget: otherBudget, ...getPacingLabel(other, otherBudget, pace_dom, dim) },
                },
            };
            if (budgets && budget) {
                row.daily_budget = buildDailyBudgetRec(budgets.total, budget - total, daysLeft);
                row.breakdown.nc.daily_budget    = buildDailyBudgetRec(budgets.nc,    ncBudget - nc,       daysLeft);
                row.breakdown.other.daily_budget = buildDailyBudgetRec(budgets.other, otherBudget - other, daysLeft);
            }
            return row;
        }

        const [{ spend, error }, budgets] = await Promise.all([
            emptyWindow(monthStart, yesterday) ? { spend: 0, error: null }
                : fetchGoogleMTD(token, cid, info.mcc, monthStart, yesterday), budgetsPromise]);
        if (error) return { account: info.name, error };
        const row = {
            account: info.name, mtd_spend: Math.round(spend * 100) / 100,
            budget, ...getPacingLabel(spend, budget, pace_dom, dim),
        };
        if (budgets && budget) {
            row.daily_budget = buildDailyBudgetRec(budgets.total, budget - spend, dim - pace_dom);
        }
        return row;
    }));
}

async function buildMetaRows(pace_dom, dim, today, monthStart, yesterday) {
    return Promise.all(Object.entries(META_ACCOUNTS).map(async ([id, info]) => {
        const { budget } = getEffectiveBudget(info, today);
        const budgetsPromise = fetchMetaDailyBudgets(id).catch(() => null);

        if (info.flight_start && info.flight_end) {
            // Flight-based budget: spend over the flight window, paced against flight days
            const until = yesterday < info.flight_end ? yesterday : info.flight_end;
            const [{ spend, error }, budgets] = await Promise.all([
                emptyWindow(info.flight_start, until) ? { spend: 0, error: null }
                    : fetchMetaMTD(id, info.flight_start, until), budgetsPromise]);
            if (error) return { account: info.name, error };
            const pacing = getFlightPacing(spend, budget, info.flight_start, info.flight_end, yesterday);
            const row = { account: info.name, flight_spend: Math.round(spend * 100) / 100, ...pacing };
            if (budgets && pacing.days_remaining > 0) {
                row.daily_budget = buildDailyBudgetRec(budgets.total, pacing.remaining, pacing.days_remaining);
                if (budgets.has_lifetime_budgets) row.daily_budget.note = "Some budgets are lifetime, not daily — current_daily_budget undercounts.";
            }
            return row;
        }

        const [{ spend, error }, budgets] = await Promise.all([
            emptyWindow(monthStart, yesterday) ? { spend: 0, error: null }
                : fetchMetaMTD(id, monthStart, yesterday), budgetsPromise]);
        if (error) return { account: info.name, error };
        const row = {
            account: info.name, mtd_spend: Math.round(spend * 100) / 100,
            budget, ...getPacingLabel(spend, budget, pace_dom, dim),
        };
        if (budgets && budget) {
            row.daily_budget = buildDailyBudgetRec(budgets.total, budget - spend, dim - pace_dom);
            if (row.daily_budget && budgets.has_lifetime_budgets) row.daily_budget.note = "Some budgets are lifetime, not daily — current_daily_budget undercounts.";
        }
        return row;
    }));
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
    if (!resp.ok) throw new Error(googleAdsError(data));
    return data.mutateOperationResponses || [];
}

// ── Meta write helpers ────────────────────────────────────────────────────────
// Shallow-copy a single Meta object via /copies (stays under the 3-object limit).
// `reparent` is { campaign_id } or { adset_id } to place the copy in a new parent.
async function metaCopyOne(id, status, reparent = {}) {
    const body = {
        access_token:  META_ACCESS_TOKEN,
        deep_copy:     false,
        status_option: status.toUpperCase(),
        ...reparent,
    };
    const resp = await fetchFn(
        `https://graph.facebook.com/${META_API_VERSION}/${id}/copies`,
        {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(body),
        }
    );
    const data = await resp.json();
    if (data.error) {
        const e = data.error;
        const code = e.code;
        // Rate limit — let the caller retry
        if (code === 17 || code === 613 || code === 32) {
            const err = new Error(e.message);
            err.rateLimited = true;
            throw err;
        }
        throw new Error(e.message);
    }
    return data.copied_campaign_id || data.copied_adset_id || data.copied_ad_id || data.id;
}

// Read the full campaign tree: campaign → ad sets → ads per ad set.
async function metaReadCampaignTree(campaignId) {
    const campData = await metaGet(campaignId, {
        fields: "name,objective,status,daily_budget,lifetime_budget,bid_strategy,special_ad_categories,start_time,stop_time",
    });
    const adsets = await metaGetAll(`${campaignId}/adsets`, {
        fields: "id,name,status", limit: 200,
    });
    for (const adset of adsets) {
        const ads = await metaGetAll(`${adset.id}/ads`, {
            fields: "id,name,status", limit: 200,
        });
        adset.ads = ads;
    }
    return { campaign: campData, adsets };
}

// Recursive shallow-copy: campaign shell → each ad set → each ad, one call each.
// Returns { new_campaign_id, id_map: { adsets: [{source,new}], ads: [{source,new}] }, failures: [] }.
async function metaDuplicateCampaign(campaignId, newName, status, opts = {}) {
    const COPY_DELAY_MS = 300;
    const MAX_RETRIES = 3;

    async function copyWithRetry(id, reparent) {
        for (let attempt = 0; ; attempt++) {
            try {
                return await metaCopyOne(id, status, reparent);
            } catch (e) {
                if (e.rateLimited && attempt < MAX_RETRIES - 1) {
                    await new Promise(r => setTimeout(r, (2 ** attempt) * 2000 + Math.random() * 500));
                    continue;
                }
                throw e;
            }
        }
    }

    // 1. Read the source tree
    const tree = await metaReadCampaignTree(campaignId);

    // 2. Copy campaign shell (shallow — no ad sets)
    const newCampaignId = await copyWithRetry(campaignId, {});
    await new Promise(r => setTimeout(r, COPY_DELAY_MS));

    // Set the final name and optional overrides on the new campaign
    const updateBody = { name: newName };
    if (opts.start_time) updateBody.start_time = opts.start_time;
    if (opts.stop_time) updateBody.stop_time = opts.stop_time;
    const dupBudgets = {};
    if (opts.daily_budget != null) dupBudgets.daily_budget = opts.daily_budget;
    if (opts.lifetime_budget != null) dupBudgets.lifetime_budget = opts.lifetime_budget;
    const dupBudgetErrors = validateBudgets(dupBudgets);
    if (dupBudgetErrors) throw new Error("Budget validation failed: " + dupBudgetErrors.join(" | "));
    if (opts.daily_budget != null) updateBody.daily_budget = Math.round(opts.daily_budget * 100);
    if (opts.lifetime_budget != null) updateBody.lifetime_budget = Math.round(opts.lifetime_budget * 100);
    await metaPost(newCampaignId, updateBody);

    const idMap = { adsets: [], ads: [] };
    const failures = [];

    // 3. Copy each ad set into the new campaign
    for (const adset of tree.adsets) {
        let newAdsetId;
        try {
            newAdsetId = await copyWithRetry(adset.id, { campaign_id: newCampaignId });
            idMap.adsets.push({ source_id: adset.id, source_name: adset.name, new_id: newAdsetId });
            await new Promise(r => setTimeout(r, COPY_DELAY_MS));
        } catch (e) {
            failures.push({ level: "adset", source_id: adset.id, source_name: adset.name, error: e.message });
            continue; // skip ads under this ad set
        }

        // 4. Copy each ad into the matching new ad set
        for (const ad of (adset.ads || [])) {
            try {
                const newAdId = await copyWithRetry(ad.id, { adset_id: newAdsetId });
                idMap.ads.push({ source_id: ad.id, source_name: ad.name, new_id: newAdId, adset_source: adset.id, adset_new: newAdsetId });
                await new Promise(r => setTimeout(r, COPY_DELAY_MS));
            } catch (e) {
                failures.push({ level: "ad", source_id: ad.id, source_name: ad.name, parent_adset: adset.name, error: e.message });
            }
        }
    }

    return { new_campaign_id: newCampaignId, new_name: newName, id_map: idMap, failures };
}
async function metaGet(path, extraParams = {}) {
    const params = new URLSearchParams({ access_token: META_ACCESS_TOKEN, ...extraParams });
    const resp = await fetchWithRetry(`https://graph.facebook.com/${META_API_VERSION}/${path}?${params}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);
    return data;
}

async function metaPost(path, body = {}) {
    const url = `https://graph.facebook.com/${META_API_VERSION}/${path}`;
    const payload = { access_token: META_ACCESS_TOKEN, ...body };
    const resp = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (data.error) {
        const e = data.error;
        const parts = [e.message];
        if (e.error_user_msg) parts.push(`Detail: ${e.error_user_msg}`);
        if (e.error_user_title) parts.push(`Title: ${e.error_user_title}`);
        if (e.type) parts.push(`Type: ${e.type}`);
        if (e.code) parts.push(`Code: ${e.code}`);
        if (e.error_subcode) parts.push(`Subcode: ${e.error_subcode}`);
        const err = new Error(parts.join(" | "));
        err.metaPath = path;
        err.metaBody = Object.fromEntries(Object.entries(payload).filter(([k]) => k !== "access_token"));
        throw err;
    }
    return data;
}

async function metaPatch(path, body = {}) {
    const url = `https://graph.facebook.com/${META_API_VERSION}/${path}`;
    const payload = { access_token: META_ACCESS_TOKEN, ...body };
    const resp = await fetchFn(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (data.error) {
        const e = data.error;
        const parts = [e.message];
        if (e.error_user_msg) parts.push(`Detail: ${e.error_user_msg}`);
        if (e.code) parts.push(`Code: ${e.code}`);
        throw new Error(parts.join(" | "));
    }
    return data;
}

async function metaDelete(path) {
    const url = `https://graph.facebook.com/${META_API_VERSION}/${path}?access_token=${META_ACCESS_TOKEN}`;
    const resp = await fetchFn(url, { method: "DELETE" });
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);
    return data;
}

// Single definition of "conversions" for every Meta tool: lead + purchase +
// offsite_conversion.fb_pixel_lead (some accounts report pixel leads only
// under the latter, so dropping it undercounts).
function metaConversions(actions = []) {
    const val = type => parseFloat(actions.find(a => a.action_type === type)?.value || 0);
    const leads      = val("lead");
    const purchases  = val("purchase");
    const pixelLeads = val("offsite_conversion.fb_pixel_lead");
    return { leads, purchases, pixelLeads, conversions: leads + purchases + pixelLeads };
}

// Follows Graph API cursor pagination (paging.next) and returns all rows.
async function metaGetAll(path, extraParams = {}) {
    const rows = [];
    let data = await metaGet(path, extraParams);
    rows.push(...(data.data || []));
    let next = data.paging?.next;
    while (next) {
        const resp = await fetchWithRetry(next); // paging.next carries the access token
        data = await resp.json();
        if (data.error) throw new Error(data.error.message);
        rows.push(...(data.data || []));
        next = data.paging?.next;
    }
    return rows;
}

function metaActId(id) { return id.startsWith("act_") ? id : `act_${id}`; }

// Resolve a get_meta_ad_performance date_range preset to concrete since/until dates.
function metaAdPerfDateRange(dateRange, customStart, customEnd) {
    if (dateRange === "CUSTOM") return { startDate: customStart, endDate: customEnd };
    const { today, yesterday, month_start } = getDateInfo();
    const [y, m] = today.split("-").map(Number);
    const fmt = dt => dt.toISOString().split("T")[0];
    switch (dateRange) {
        case "LAST_7_DAYS":  return { startDate: daysAgo(7, today),  endDate: yesterday };
        case "LAST_MONTH":   return { startDate: fmt(new Date(Date.UTC(y, m - 2, 1))), endDate: fmt(new Date(Date.UTC(y, m - 1, 0))) };
        case "THIS_MONTH":   return { startDate: month_start, endDate: today };
        case "LAST_30_DAYS":
        default:             return { startDate: daysAgo(30, today), endDate: yesterday };
    }
}

const BUDGET_LIMITS = {
    lifetime_budget: 5000,
    spend_cap: 5000,
    lifetime_min_spend_target: 5000,
    lifetime_spend_cap: 5000,
    daily_budget: 500,
    daily_min_spend_target: 500,
    daily_spend_cap: 500,
    bid_amount: 100,
};

function validateBudgets(fields) {
    const errors = [];
    for (const [field, value] of Object.entries(fields)) {
        if (value == null) continue;
        const limit = BUDGET_LIMITS[field];
        if (limit && value > limit) {
            errors.push(`${field} = $${value.toLocaleString()} exceeds safety limit of $${limit.toLocaleString()}. All values must be in DOLLARS (converted to cents automatically). Aborting to prevent overspend.`);
        }
    }
    return errors.length ? errors : null;
}

function budgetConfirmationSummary(fields) {
    const lines = [];
    for (const [field, value] of Object.entries(fields)) {
        if (value != null && BUDGET_LIMITS[field]) {
            lines.push(`  ${field}: $${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
        }
    }
    return lines;
}

async function getMetaPixels(accountId) {
    const rows = await metaGetAll(`${accountId}/adspixels`, { fields: "id,name", limit: 50 });
    return rows.map(p => ({ id: p.id, name: p.name }));
}

async function getMetaCreativeDetails(creativeIds) {
    const results = [];
    for (const cid of creativeIds) {
        const data = await metaGet(cid, { fields: "id,name,object_story_id,object_story_spec,call_to_action_type" });
        results.push({
            id: data.id,
            name: data.name,
            object_story_id: data.object_story_id || null,
            call_to_action_type: data.call_to_action_type || null,
            object_story_spec: data.object_story_spec || null,
        });
    }
    return results;
}

async function getMetaCampaigns(accountId) {
    const rows = await metaGetAll(`${accountId}/campaigns`, {
        fields: "id,name,status,daily_budget,lifetime_budget,objective",
        limit: 100,
    });
    return rows.map(c => ({
        id: c.id, name: c.name, status: c.status,
        daily_budget:    c.daily_budget    ? parseFloat(c.daily_budget) / 100    : null,
        lifetime_budget: c.lifetime_budget ? parseFloat(c.lifetime_budget) / 100 : null,
        objective: c.objective,
        level: "campaign",
    }));
}

async function getMetaAdsets(accountId) {
    const rows = await metaGetAll(`${accountId}/adsets`, {
        fields: "id,name,status,daily_budget,lifetime_budget,campaign_id,campaign{name},targeting",
        limit: 200,
    });
    return rows.map(s => {
        const t = s.targeting || {};
        const interests = (t.flexible_spec || []).flatMap(fs => (fs.interests || []).map(i => ({ id: i.id, name: i.name })));
        const behaviors = (t.flexible_spec || []).flatMap(fs => (fs.behaviors || []).map(b => ({ id: b.id, name: b.name })));
        return {
            id: s.id, name: s.name, status: s.status,
            campaign: s.campaign?.name || s.campaign_id,
            daily_budget:    s.daily_budget    ? parseFloat(s.daily_budget) / 100    : null,
            lifetime_budget: s.lifetime_budget ? parseFloat(s.lifetime_budget) / 100 : null,
            targeting: {
                age_min: t.age_min || null,
                age_max: t.age_max || null,
                geo_locations: t.geo_locations || null,
                interests: interests.length ? interests : null,
                behaviors: behaviors.length ? behaviors : null,
                publisher_platforms: t.publisher_platforms || null,
                facebook_positions: t.facebook_positions || null,
                instagram_positions: t.instagram_positions || null,
                audience_network_positions: t.audience_network_positions || null,
                messenger_positions: t.messenger_positions || null,
            },
            level: "adset",
        };
    });
}

async function getMetaAds(accountId, filterName) {
    const params = {
        fields: "id,name,status,effective_status,creative{id,name,thumbnail_url,object_story_id},adset{id,name}",
        limit: 200,
    };
    if (filterName) {
        params.filtering = JSON.stringify([{ field: "name", operator: "CONTAIN", value: filterName }]);
    }
    const rows = await metaGetAll(`${accountId}/ads`, params);
    return rows.map(a => ({
        id: a.id, name: a.name, status: a.status, effective_status: a.effective_status,
        adset: a.adset?.name || null,
        creative_id: a.creative?.id || null,
        creative_name: a.creative?.name || null,
        object_story_id: a.creative?.object_story_id || null,
        level: "ad",
    }));
}

// ── Meta Campaign Creation Helpers ───────────────────────────────────────────

async function metaSearchGeo(query) {
    return metaGet("search", { type: "adgeolocation", q: query, location_types: '["city"]' });
}

async function metaSearchInterests(query) {
    const data = await metaGet("search", { type: "adinterest", q: query });
    return (data.data || data || []).map(i => ({
        id: i.id, name: i.name,
        audience_size_lower_bound: i.audience_size_lower_bound,
        audience_size_upper_bound: i.audience_size_upper_bound,
        path: i.path, topic: i.topic,
    }));
}

async function metaSearchBehaviors(query) {
    const data = await metaGet("search", { type: "adTargetingCategory", class: "behaviors", q: query });
    return (data.data || data || []).map(b => ({
        id: b.id, name: b.name,
        audience_size_lower_bound: b.audience_size_lower_bound,
        audience_size_upper_bound: b.audience_size_upper_bound,
    }));
}

async function resolveMetaInterestsByName(names) {
    const resolved = [];
    const unresolved = [];
    for (const name of (names || [])) {
        const results = await metaSearchInterests(name);
        const match = results.find(r => r.name.toLowerCase() === name.toLowerCase()) || results[0];
        if (match) resolved.push({ id: match.id, name: match.name });
        else unresolved.push(name);
    }
    return { resolved, unresolved };
}

async function resolveMetaBehaviorsByName(names) {
    const resolved = [];
    const unresolved = [];
    for (const name of (names || [])) {
        const results = await metaSearchBehaviors(name);
        const match = results.find(r => r.name.toLowerCase() === name.toLowerCase()) || results[0];
        if (match) resolved.push({ id: match.id, name: match.name });
        else unresolved.push(name);
    }
    return { resolved, unresolved };
}

async function buildMetaTargetingSpec(targeting) {
    const spec = {};
    const warnings = [];

    // Geo targeting
    if (targeting.geo_raw) {
        spec.geo_locations = targeting.geo_raw;
    } else if (targeting.countries?.length) {
        spec.geo_locations = { countries: targeting.countries };
    } else if (targeting.geo) {
        const geoResult = await metaSearchGeo(targeting.geo);
        const cities = geoResult.data || geoResult || [];
        if (cities.length === 0) {
            warnings.push(`No geo results for '${targeting.geo}'`);
        } else {
            const city = cities[0];
            spec.geo_locations = {
                cities: [{
                    key: city.key,
                    radius: targeting.geo_radius || 25,
                    distance_unit: "mile",
                }],
            };
        }
    }

    // Age
    if (targeting.age_min) spec.age_min = targeting.age_min;
    if (targeting.age_max) spec.age_max = targeting.age_max;

    // Interests + behaviors → flexible_spec
    const flexSpec = {};
    if (targeting.interests?.length) {
        const { resolved, unresolved } = await resolveMetaInterestsByName(targeting.interests);
        if (unresolved.length) warnings.push(`Could not resolve interests: ${unresolved.join(", ")}`);
        if (resolved.length) flexSpec.interests = resolved;
    }
    if (targeting.behaviors?.length) {
        const { resolved, unresolved } = await resolveMetaBehaviorsByName(targeting.behaviors);
        if (unresolved.length) warnings.push(`Could not resolve behaviors: ${unresolved.join(", ")}`);
        if (resolved.length) flexSpec.behaviors = resolved;
    }
    if (Object.keys(flexSpec).length) spec.flexible_spec = [flexSpec];

    // Custom audiences
    if (targeting.custom_audiences?.length) {
        spec.custom_audiences = targeting.custom_audiences.map(id => ({ id }));
    }
    if (targeting.excluded_audiences?.length) {
        spec.exclusions = { custom_audiences: targeting.excluded_audiences.map(id => ({ id })) };
    }

    // Placements (omit for Advantage+)
    if (targeting.placements === "manual") {
        if (targeting.publisher_platforms) spec.publisher_platforms = targeting.publisher_platforms;
        if (targeting.facebook_positions) spec.facebook_positions = targeting.facebook_positions;
        if (targeting.instagram_positions) spec.instagram_positions = targeting.instagram_positions;
    }

    // Pass through any additional targeting fields not handled above
    const handled = new Set(["geo", "geo_radius", "geo_raw", "countries", "age_min", "age_max",
        "interests", "behaviors", "custom_audiences", "excluded_audiences",
        "placements", "publisher_platforms", "facebook_positions", "instagram_positions"]);
    for (const [k, v] of Object.entries(targeting)) {
        if (!handled.has(k) && v != null) spec[k] = v;
    }

    return { spec, warnings };
}

async function createMetaCampaignFull(accountId, pageId, config, instagramAccountId) {
    const results = { campaign: null, ad_sets: [], debug: [] };

    // Validate all budgets upfront
    const campaignBudgets = {};
    if (config.lifetime_budget) campaignBudgets.lifetime_budget = config.lifetime_budget;
    if (config.daily_budget) campaignBudgets.daily_budget = config.daily_budget;
    const campBudgetErrors = validateBudgets(campaignBudgets);
    if (campBudgetErrors) throw new Error("Campaign budget validation failed: " + campBudgetErrors.join(" | "));
    for (const adSet of (config.ad_sets || [])) {
        const adSetBudgets = {};
        if (adSet.daily_budget) adSetBudgets.daily_budget = adSet.daily_budget;
        if (adSet.bid_amount) adSetBudgets.bid_amount = adSet.bid_amount;
        if (adSet.daily_spend_cap) adSetBudgets.daily_spend_cap = adSet.daily_spend_cap;
        if (adSet.daily_min_spend_target) adSetBudgets.daily_min_spend_target = adSet.daily_min_spend_target;
        const adSetBudgetErrors = validateBudgets(adSetBudgets);
        if (adSetBudgetErrors) throw new Error(`Ad set "${adSet.name}" budget validation failed: ` + adSetBudgetErrors.join(" | "));
    }

    try {
        // Step 1: Create campaign
        const campaignBody = {
            name: config.campaign_name,
            objective: config.objective,
            status: "PAUSED",
            special_ad_categories: config.special_ad_categories || [],
            bid_strategy: config.campaign_bid_strategy || "LOWEST_COST_WITHOUT_CAP",
        };
        if (config.cbo) {
            if (config.lifetime_budget) {
                campaignBody.lifetime_budget = Math.round(config.lifetime_budget * 100);
            } else {
                campaignBody.daily_budget = Math.round(config.daily_budget * 100);
            }
        }
        results.debug.push({ step: "campaign", body: campaignBody });
        const campRes = await metaPost(`${accountId}/campaigns`, campaignBody);
        results.campaign = { id: campRes.id, name: config.campaign_name };
    } catch (e) {
        e.message = `Campaign creation failed: ${e.message}`;
        if (e.metaBody) e.message += ` | Request body: ${JSON.stringify(e.metaBody)}`;
        throw e;
    }

    // Step 2: Create ad sets + ads
    for (const adSetDef of (config.ad_sets || [])) {
        const { spec: targetingSpec } = await buildMetaTargetingSpec(adSetDef.targeting || {});

        const adSetBody = {
            name: adSetDef.name,
            campaign_id: results.campaign.id,
            status: "PAUSED",
            optimization_goal: adSetDef.optimization_goal || "LINK_CLICKS",
            billing_event: adSetDef.billing_event || "IMPRESSIONS",
            targeting: targetingSpec,
        };
        if (!config.cbo && adSetDef.daily_budget) {
            adSetBody.daily_budget = Math.round(adSetDef.daily_budget * 100);
        }
        if (adSetDef.bid_strategy) adSetBody.bid_strategy = adSetDef.bid_strategy;
        if (adSetDef.bid_amount)   adSetBody.bid_amount   = Math.round(adSetDef.bid_amount * 100);
        if (adSetDef.roas_control) adSetBody.roas_control  = adSetDef.roas_control;
        if (adSetDef.start_time) adSetBody.start_time = adSetDef.start_time;
        if (adSetDef.end_time) adSetBody.end_time = adSetDef.end_time;
        if (adSetDef.daily_min_spend_target) adSetBody.daily_min_spend_target = Math.round(adSetDef.daily_min_spend_target * 100);
        if (adSetDef.daily_spend_cap) adSetBody.daily_spend_cap = Math.round(adSetDef.daily_spend_cap * 100);
        if (adSetDef.is_dynamic_creative) adSetBody.is_dynamic_creative = true;
        if (adSetDef.url_tags) adSetBody.url_tags = adSetDef.url_tags;
        if (adSetDef.promoted_object) {
            adSetBody.promoted_object = adSetDef.promoted_object;
        } else if (adSetBody.optimization_goal === "OFFSITE_CONVERSIONS") {
            const pixels = await getMetaPixels(accountId);
            if (pixels.length === 1) {
                adSetBody.promoted_object = { pixel_id: pixels[0].id, custom_event_type: "LEAD" };
                results.auto_pixel = { id: pixels[0].id, name: pixels[0].name };
            } else if (pixels.length > 1) {
                results.available_pixels = pixels;
                throw new Error(`Multiple pixels found — pass promoted_object: {pixel_id: "...", custom_event_type: "Lead"}. Available: ${pixels.map(p => `${p.name} (${p.id})`).join(", ")}`);
            }
        }

        let adSetRes;
        try {
            results.debug.push({ step: "adset", name: adSetDef.name, body: adSetBody });
            adSetRes = await metaPost(`${accountId}/adsets`, adSetBody);
        } catch (e) {
            e.message = `Ad set "${adSetDef.name}" creation failed: ${e.message}`;
            if (e.metaBody) e.message += ` | Request body: ${JSON.stringify(e.metaBody)}`;
            throw e;
        }
        const adSetResult = { name: adSetDef.name, id: adSetRes.id, ads: [] };

        // Step 3: Create ads (creative + ad for each)
        for (const adDef of (adSetDef.ads || [])) {
            let storySpec;
            if (adDef.video_id) {
                let videoThumbHash = adDef.image_hash || null;
                if (!videoThumbHash) {
                    try {
                        const thumbRes = await metaGet(adDef.video_id, { fields: "thumbnails" });
                        const thumbUrl = thumbRes.thumbnails?.data?.[0]?.uri;
                        if (thumbUrl) {
                            // Download thumbnail bytes ourselves — the CDN URL is signed
                            // and Meta's adimages endpoint can't fetch it server-to-server.
                            const imgResp = await fetchFn(thumbUrl);
                            if (imgResp.ok) {
                                const imgBuf = Buffer.from(await imgResp.arrayBuffer());
                                const blob = new Blob([imgBuf]);
                                const formData = new FormData();
                                formData.append("access_token", META_ACCESS_TOKEN);
                                formData.append("filename", blob, "thumbnail.jpg");
                                const uploadResp = await fetchFn(
                                    `https://graph.facebook.com/${META_API_VERSION}/${accountId}/adimages`,
                                    { method: "POST", body: formData }
                                );
                                const uploadData = await uploadResp.json();
                                if (!uploadData.error) {
                                    const imgData = uploadData.images ? Object.values(uploadData.images)[0] : uploadData;
                                    videoThumbHash = imgData.hash;
                                }
                            }
                        }
                    } catch (e) {
                        results.debug.push({ step: "thumbnail_auto", video_id: adDef.video_id, error: e.message });
                    }
                }
                storySpec = {
                    page_id: pageId,
                    video_data: {
                        message: adDef.primary_text,
                        video_id: adDef.video_id,
                        title: adDef.headline,
                        link_description: adDef.description || "",
                        call_to_action: {
                            type: adDef.cta || "LEARN_MORE",
                            value: { link: adDef.url },
                        },
                        ...(videoThumbHash ? { image_hash: videoThumbHash } : {}),
                    },
                };
            } else if (adDef.carousel_cards?.length) {
                const childAttachments = adDef.carousel_cards.map(card => ({
                    image_hash: card.image_hash,
                    link: card.url || adDef.url,
                    name: card.headline || adDef.headline,
                    description: card.description || adDef.description || "",
                    call_to_action: { type: card.cta || adDef.cta || "LEARN_MORE", value: { link: card.url || adDef.url } },
                }));
                storySpec = {
                    page_id: pageId,
                    link_data: {
                        message: adDef.primary_text,
                        link: adDef.url,
                        child_attachments: childAttachments,
                        multi_share_end_card: false,
                    },
                };
            } else {
                storySpec = {
                    page_id: pageId,
                    link_data: {
                        message: adDef.primary_text,
                        link: adDef.url,
                        name: adDef.headline,
                        description: adDef.description || "",
                        call_to_action: {
                            type: adDef.cta || "LEARN_MORE",
                            value: { link: adDef.url },
                        },
                    },
                };
                if (adDef.image_hash) storySpec.link_data.image_hash = adDef.image_hash;
            }

            if (instagramAccountId) storySpec.instagram_actor_id = instagramAccountId;

            let finalCreativeId;
            if (adDef.creative_id) {
                finalCreativeId = adDef.creative_id;
                results.debug.push({ step: "creative_reuse", name: adDef.name, creative_id: adDef.creative_id });
            } else {
                let creativeRes;
                try {
                    const creativeBody = adDef.object_story_id
                        ? { name: `${adDef.name} Creative`, object_story_id: adDef.object_story_id }
                        : { name: `${adDef.name} Creative`, object_story_spec: storySpec };
                    results.debug.push({ step: "creative", name: adDef.name, body: creativeBody });
                    creativeRes = await metaPost(`${accountId}/adcreatives`, creativeBody);
                } catch (e) {
                    e.message = `Creative "${adDef.name}" creation failed: ${e.message}`;
                    if (e.metaBody) e.message += ` | Request body: ${JSON.stringify(e.metaBody)}`;
                    throw e;
                }
                finalCreativeId = creativeRes.id;
            }

            try {
                const adBody = { name: adDef.name, adset_id: adSetRes.id, creative: { creative_id: finalCreativeId }, status: "PAUSED" };
                results.debug.push({ step: "ad", name: adDef.name, body: adBody });
                const adRes = await metaPost(`${accountId}/ads`, adBody);
                adSetResult.ads.push({ name: adDef.name, ad_id: adRes.id, creative_id: finalCreativeId });
            } catch (e) {
                e.message = `Ad "${adDef.name}" creation failed: ${e.message}`;
                if (e.metaBody) e.message += ` | Request body: ${JSON.stringify(e.metaBody)}`;
                throw e;
            }
        }

        results.ad_sets.push(adSetResult);
    }

    return results;
}

// ── Google Analytics 4 ───────────────────────────────────────────────────────
function getGA4DateRange(range) {
    const { today, month_start } = getDateInfo();
    const [y, m] = today.split("-").map(Number);
    const fmt = dt => dt.toISOString().split("T")[0];
    switch (range) {
        case "THIS_MONTH":   return { startDate: month_start, endDate: "today" };
        case "LAST_MONTH":   return { startDate: fmt(new Date(Date.UTC(y, m - 2, 1))), endDate: fmt(new Date(Date.UTC(y, m - 1, 0))) };
        case "LAST_7_DAYS":  return { startDate: "7daysAgo",  endDate: "yesterday" };
        case "LAST_30_DAYS": return { startDate: "30daysAgo", endDate: "yesterday" };
        case "LAST_90_DAYS":  return { startDate: "90daysAgo", endDate: "yesterday" };
        case "YEAR_TO_DATE": return { startDate: `${y}-01-01`, endDate: "yesterday" };
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

    const resp = await fetchWithRetry(
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
async function fetchGoogleCampaignPerf(token, customerId, mccId, dateRange, startDate, endDate, segmentBy) {
    const dateClause = resolveGaqlDateClause(dateRange, startDate, endDate);
    const byConvAction = segmentBy === "conversion_action";

    if (byConvAction) {
        const rows = await googleSearch(token, customerId, mccId, `
            SELECT campaign.name, campaign.status, campaign.advertising_channel_type,
                   segments.conversion_action, segments.conversion_action_name,
                   segments.conversion_action_category,
                   metrics.conversions, metrics.conversions_value
            FROM campaign
            WHERE segments.date ${dateClause}
              AND metrics.conversions > 0
            ORDER BY metrics.conversions DESC`);
        const byCampaign = {};
        for (const row of rows) {
            const name = row.campaign.name;
            if (!byCampaign[name]) {
                byCampaign[name] = {
                    campaign: name,
                    status:   row.campaign.status,
                    type:     row.campaign.advertisingChannelType,
                    conversion_actions: [],
                };
            }
            const convs   = parseFloat(row.metrics.conversions || 0);
            const convVal = parseFloat(row.metrics.conversionsValue || 0);
            if (convs === 0 && convVal === 0) continue;
            byCampaign[name].conversion_actions.push({
                conversion_action: row.segments?.conversionActionName || "Unknown",
                category:          row.segments?.conversionActionCategory || null,
                conversions:       convs,
                conv_value:        Math.round(convVal * 100) / 100,
            });
        }
        for (const c of Object.values(byCampaign)) {
            c.conversion_actions.sort((a, b) => b.conversions - a.conversions);
        }
        return Object.values(byCampaign);
    }

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
    const resp = await fetchWithRetry(`https://graph.facebook.com/${META_API_VERSION}/${accountId}/insights?${params}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);

    return (data.data || []).map(row => {
        const { leads, purchases, conversions: convs } = metaConversions(row.actions);
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
    const resp = await fetchWithRetry(`https://graph.facebook.com/${META_API_VERSION}/${accountId}/insights?${params}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);

    let ytdSpend = 0, ytdConv = 0;
    const months = (data.data || []).map(row => {
        const { conversions: convs } = metaConversions(row.actions);
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
        const { today, yesterday } = getDateInfo();
        const yearStart = `${today.slice(0, 4)}-01-01`;
        const end = yesterday >= yearStart ? yesterday : today;
        return `BETWEEN '${yearStart}' AND '${end}'`;
    }
    if (dateRange === "LAST_90_DAYS") {
        const { yesterday } = getDateInfo();
        const d = new Date(yesterday);
        d.setDate(d.getDate() - 89);
        return `BETWEEN '${d.toISOString().slice(0, 10)}' AND '${yesterday}'`;
    }
    if (dateRange === "CUSTOM" && startDate && endDate) {
        return `BETWEEN '${startDate}' AND '${endDate}'`;
    }
    return `DURING ${dateRange}`;
}

// ── Period comparison helpers ─────────────────────────────────────────────────
function getCompareDateRanges(comparison) {
    const { today, month_start } = getDateInfo();
    const [y, m, d] = today.split("-").map(Number);
    const fmt = dt => dt.toISOString().split("T")[0];
    const shift = n => fmt(new Date(Date.UTC(y, m - 1, d + n)));

    if (comparison === "this_month_vs_last_month") {
        return {
            p1: { start: month_start,                     end: shift(-1),                        label: "This Month MTD" },
            p2: { start: fmt(new Date(Date.UTC(y, m - 2, 1))), end: fmt(new Date(Date.UTC(y, m - 1, 0))), label: "Last Month (Full)" },
        };
    }
    if (comparison === "last_7_days_vs_prior_7_days") {
        return {
            p1: { start: shift(-7), end: shift(-1), label: "Last 7 Days" },
            p2: { start: shift(-14), end: shift(-8), label: "Prior 7 Days" },
        };
    }
    if (comparison === "last_30_days_vs_prior_30_days") {
        return {
            p1: { start: shift(-30), end: shift(-1), label: "Last 30 Days" },
            p2: { start: shift(-60), end: shift(-31), label: "Prior 30 Days" },
        };
    }
    if (comparison === "year_over_year") {
        return {
            p1: { start: `${y}-01-01`,     end: shift(-1),                                label: `${y} YTD` },
            p2: { start: `${y - 1}-01-01`, end: fmt(new Date(Date.UTC(y - 1, m - 1, d - 1))), label: `${y - 1} Same Period` },
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
    const resp = await fetchWithRetry(`https://graph.facebook.com/${META_API_VERSION}/${accountId}/insights?${params}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);

    const row     = data.data?.[0] || {};
    const { conversions: convs } = metaConversions(row.actions);
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

// ── PMax search terms + DSA/catch-all fallback ───────────────────────────────
async function fetchPmaxSearchTermInsights(token, customerId, mccId, dateRange, startDate, endDate, topN = 50) {
    const dateClause = resolveGaqlDateClause(dateRange, startDate, endDate);
    const mapTerm = (row, source) => ({
        term:         row.campaignSearchTermView?.searchTerm || row.searchTermView?.searchTerm,
        campaign:     row.campaign.name,
        source,
        cost:         parseInt(row.metrics.costMicros || 0) / 1_000_000,
        clicks:       parseInt(row.metrics.clicks || 0),
        impressions:  parseInt(row.metrics.impressions || 0),
        convs:        parseFloat(row.metrics.conversions || 0),
        conv_value:   parseFloat(row.metrics.conversionsValue || 0),
        ctr:          (parseFloat(row.metrics.ctr || 0) * 100).toFixed(1) + "%",
        avg_cpc:      (parseInt(row.metrics.averageCpc || 0) / 1_000_000).toFixed(2),
    });

    // Primary: PMax search terms via campaign_search_term_view
    let pmaxTerms = [];
    let pmaxError = null;
    try {
        const pmaxRows = await googleSearch(token, customerId, mccId, `
            SELECT campaign_search_term_view.search_term,
                   campaign.name,
                   metrics.cost_micros, metrics.clicks, metrics.impressions,
                   metrics.conversions, metrics.conversions_value,
                   metrics.ctr, metrics.average_cpc
            FROM campaign_search_term_view
            WHERE segments.date ${dateClause}
              AND metrics.impressions > 0
            ORDER BY metrics.impressions DESC`);
        pmaxTerms = pmaxRows.map(r => mapTerm(r, "pmax"));
    } catch (e) {
        pmaxError = e.message;
    }

    // Secondary: DSA / catch-all search terms running alongside PMax
    let dsaTerms = [];
    try {
        const dsaRows = await googleSearch(token, customerId, mccId, `
            SELECT search_term_view.search_term, search_term_view.status,
                   campaign.name,
                   metrics.cost_micros, metrics.clicks, metrics.impressions,
                   metrics.conversions, metrics.conversions_value,
                   metrics.ctr, metrics.average_cpc
            FROM search_term_view
            WHERE segments.date ${dateClause}
              AND metrics.impressions > 0
              AND campaign.advertising_channel_type IN ('MULTI_CHANNEL', 'SEARCH')
            ORDER BY metrics.cost_micros DESC LIMIT 500`);
        dsaTerms = dsaRows.map(r => {
            const t = mapTerm(r, "dsa");
            t.status = r.searchTermView.status || "";
            return t;
        });
    } catch (_) {}

    const result = {};

    // Every list below is capped and a rollup is returned alongside it. Dumping
    // the full term list overflows a model context window on busy accounts.
    const summarise = (terms, label) => {
        const totals = terms.reduce((a, t) => ({
            spend: a.spend + t.cost, clicks: a.clicks + t.clicks,
            impressions: a.impressions + t.impressions,
            conversions: a.conversions + t.convs, conv_value: a.conv_value + t.conv_value,
        }), { spend: 0, clicks: 0, impressions: 0, conversions: 0, conv_value: 0 });
        const bySpend  = [...terms].sort((a, b) => b.cost - a.cost);
        const wastedAll = bySpend.filter(t => t.cost > 3 && t.convs === 0);
        const convAll   = [...terms].filter(t => t.convs > 0).sort((a, b) => b.convs - a.convs);
        const wastedSpend = wastedAll.reduce((s, t) => s + t.cost, 0);
        return {
            total: terms.length,
            totals: {
                spend:       Math.round(totals.spend * 100) / 100,
                clicks:      totals.clicks,
                impressions: totals.impressions,
                conversions: Math.round(totals.conversions * 100) / 100,
                conv_value:  Math.round(totals.conv_value * 100) / 100,
            },
            wasted_spend_total: Math.round(wastedSpend * 100) / 100,
            wasted_terms_total: wastedAll.length,
            converting_total:   convAll.length,
            top_terms:  bySpend.slice(0, topN),
            wasted:     wastedAll.slice(0, topN),
            converting: convAll.slice(0, topN),
            truncated:  terms.length > topN,
            note:       terms.length > topN
                ? `Showing the top ${topN} ${label} terms by spend. Totals above cover all ${terms.length}. Raise top_n for more.`
                : undefined,
        };
    };

    if (pmaxTerms.length > 0) {
        result.pmax_terms = summarise(pmaxTerms, "PMax");
    } else {
        result.pmax_terms = { total: 0, note: pmaxError || "No PMax search term data returned. Check the Google Ads UI (PMax campaign → Insights → Search categories) for theme-level data." };
    }

    if (dsaTerms.length > 0) result.dsa_catch_all = summarise(dsaTerms, "DSA/catch-all");

    return result;
}

// ── Geo target resolution ────────────────────────────────────────────────────
const geoTargetCache = new Map();

async function resolveGeoTarget(token, mccId, locationString) {
    if (locationString.startsWith("geoTargetConstants/")) return locationString;

    const cacheKey = locationString.toLowerCase().trim();
    if (geoTargetCache.has(cacheKey)) return geoTargetCache.get(cacheKey);

    const resp = await fetchFn(
        `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/geoTargetConstants:suggest`,
        {
            method: "POST",
            headers: {
                "Authorization":     `Bearer ${token}`,
                "developer-token":   GOOGLE_DEVELOPER_TOKEN,
                "login-customer-id": mccId,
                "Content-Type":      "application/json",
            },
            body: JSON.stringify({
                locale: "en",
                countryCode: "US",
                locationNames: { names: [locationString] },
            }),
        }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(`Geo lookup failed: ${googleAdsError(data)}`);

    const suggestions = data.geoTargetConstantSuggestions || [];
    if (!suggestions.length) throw new Error(`No geo target found for "${locationString}"`);

    const best = suggestions[0].geoTargetConstant;
    const resourceName = best.resourceName;
    geoTargetCache.set(cacheKey, resourceName);
    return resourceName;
}

// ── Geo targeting (campaign criteria) ─────────────────────────────────────────

async function getCampaignGeoTargets(token, customerId, mccId, campaignResourceName) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT campaign_criterion.resource_name,
               campaign_criterion.location.geo_target_constant,
               campaign_criterion.negative
        FROM campaign_criterion
        WHERE campaign_criterion.type = 'LOCATION'
          AND campaign.resource_name = '${campaignResourceName}'`);
    const geoIds = rows
        .filter(r => !r.campaignCriterion.negative)
        .map(r => r.campaignCriterion.location.geoTargetConstant);
    if (!geoIds.length) return [];
    const nameRows = await googleSearch(token, customerId, mccId, `
        SELECT geo_target_constant.resource_name,
               geo_target_constant.name,
               geo_target_constant.canonical_name,
               geo_target_constant.target_type
        FROM geo_target_constant
        WHERE geo_target_constant.resource_name IN (${geoIds.map(id => `'${id}'`).join(", ")})`);
    const nameMap = {};
    for (const r of nameRows) {
        nameMap[r.geoTargetConstant.resourceName] = {
            name: r.geoTargetConstant.name,
            canonical_name: r.geoTargetConstant.canonicalName,
            target_type: r.geoTargetConstant.targetType,
        };
    }
    return rows
        .filter(r => !r.campaignCriterion.negative)
        .map(r => ({
            criterion_resource_name: r.campaignCriterion.resourceName,
            geo_target_constant: r.campaignCriterion.location.geoTargetConstant,
            ...(nameMap[r.campaignCriterion.location.geoTargetConstant] || {}),
        }));
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

async function callKeywordPlannerIdeas(token, customerId, mccId, seedKeywords, url, geoTargetConstant) {
    let seed = {};
    if (url && seedKeywords.length) seed = { keywordAndUrlSeed: { keywords: seedKeywords, url } };
    else if (url)                    seed = { urlSeed: { url } };
    else                             seed = { keywordSeed: { keywords: seedKeywords } };

    const body = {
        ...seed,
        language:            "languageConstants/1000",
        keywordPlanNetwork:  "GOOGLE_SEARCH",
        includeAdultKeywords: false,
    };
    if (geoTargetConstant) body.geoTargetConstants = [geoTargetConstant];

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
            body: JSON.stringify(body),
        }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(googleAdsError(data));
    return (data.results || []).map(r => parseKwMetric(r));
}

async function fetchKeywordHistoricalMetrics(token, customerId, mccId, keywords, showTrend, geoTargetConstant) {
    const body = {
        keywords,
        language:           "languageConstants/1000",
        keywordPlanNetwork: "GOOGLE_SEARCH",
    };
    if (geoTargetConstant) body.geoTargetConstants = [geoTargetConstant];

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
            body: JSON.stringify(body),
        }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(googleAdsError(data));

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
    // Two queries merged: a date-filtered metrics query alone would hide
    // campaigns with zero spend this month (they have no data rows).
    //
    // THIS_MONTH includes today's partial spend, unlike fetchGoogleMTD, which
    // stops at yesterday so pacing math isn't skewed by an incomplete day. Both
    // windows are intentional, so the field is named for the one it uses —
    // mtd_spend here would look comparable to the pacing report and isn't.
    const [all, spendRows] = await Promise.all([
        listGoogleCampaignsAll(token, customerId, mccId),
        googleSearch(token, customerId, mccId, `
            SELECT campaign.resource_name, metrics.cost_micros
            FROM campaign
            WHERE campaign.status != 'REMOVED'
              AND segments.date DURING THIS_MONTH`).catch(() => []),
    ]);
    const spend = {};
    for (const r of spendRows) {
        spend[r.campaign.resourceName] = (spend[r.campaign.resourceName] || 0) + parseInt(r.metrics?.costMicros || 0);
    }
    return all
        .map(c => ({ ...c, mtd_spend_incl_today: "$" + ((spend[c.resource_name] || 0) / 1_000_000).toFixed(2) }))
        .sort((a, b) => (spend[b.resource_name] || 0) - (spend[a.resource_name] || 0));
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
    if (!resp.ok) throw new Error(googleAdsError(data));
    return data;
}

async function updateGoogleAdGroupStatus(token, customerId, mccId, resourceName, status) {
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
                    adGroupOperation: {
                        update:     { resourceName, status },
                        updateMask: "status",
                    },
                }],
            }),
        }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(googleAdsError(data));
    return data;
}

async function listKeywordCriteria(token, customerId, mccId, campaignSearch, adGroupSearch) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT campaign.name, ad_group.name,
               ad_group_criterion.resource_name,
               ad_group_criterion.keyword.text,
               ad_group_criterion.keyword.match_type,
               ad_group_criterion.status
        FROM ad_group_criterion
        WHERE ad_group_criterion.type = 'KEYWORD'
          AND ad_group_criterion.negative = FALSE
          AND ad_group_criterion.status != 'REMOVED'
          AND ad_group.status != 'REMOVED'
          AND campaign.status != 'REMOVED'`);
    return rows
        .map(row => ({
            resource_name: row.adGroupCriterion.resourceName,
            keyword:       row.adGroupCriterion.keyword.text,
            match_type:    row.adGroupCriterion.keyword.matchType,
            status:        row.adGroupCriterion.status,
            ad_group:      row.adGroup.name,
            campaign:      row.campaign.name,
        }))
        .filter(k => !campaignSearch || k.campaign.toLowerCase().includes(campaignSearch))
        .filter(k => !adGroupSearch || k.ad_group.toLowerCase().includes(adGroupSearch));
}

async function findKeywordInventory(token, customerId, mccId) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT ad_group_criterion.criterion_id,
               ad_group_criterion.keyword.text,
               ad_group_criterion.keyword.match_type,
               ad_group_criterion.status,
               ad_group_criterion.negative,
               ad_group.id,
               ad_group.name,
               ad_group.status,
               campaign.id,
               campaign.name,
               campaign.status,
               campaign.advertising_channel_type
        FROM ad_group_criterion
        WHERE ad_group_criterion.type = 'KEYWORD'
          AND ad_group_criterion.negative = FALSE`);
    return rows.map(row => ({
        keyword:          row.adGroupCriterion.keyword.text,
        match_type:       row.adGroupCriterion.keyword.matchType,
        status:           row.adGroupCriterion.status,
        criterion_id:     row.adGroupCriterion.criterionId,
        campaign:         row.campaign.name,
        campaign_id:      row.campaign.id,
        campaign_status:  row.campaign.status,
        campaign_type:    row.campaign.advertisingChannelType,
        ad_group:         row.adGroup.name,
        ad_group_id:      row.adGroup.id,
        ad_group_status:  row.adGroup.status,
    }));
}

async function updateGoogleKeywordStatus(token, customerId, mccId, resourceNames, status) {
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
                mutateOperations: resourceNames.map(resourceName => ({
                    adGroupCriterionOperation: {
                        update:     { resourceName, status },
                        updateMask: "status",
                    },
                })),
            }),
        }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(googleAdsError(data));
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
    if (!resp.ok) throw new Error(googleAdsError(data));
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
    if (!resp.ok) throw new Error(googleAdsError(data));
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
            `https://graph.facebook.com/${META_API_VERSION}/${accountId}/insights?fields=spend&date_preset=last_30d&access_token=${META_ACCESS_TOKEN}`
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
            relative_url: `${id}/insights?fields=spend&date_preset=last_30d`,
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

// googleAdsError is defined near the top of the Google Ads API section

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

async function fetchStackAdaptDailySpend(advertiserId, from, to) {
    const data = await stackAdaptGQL(`{
        campaignDelivery(
            dataType: TABLE
            granularity: DAILY
            date: { from: "${from}", to: "${to}" }
            filterBy: { advertiserIds: [${parseInt(advertiserId)}] }
        ) {
            ... on CampaignDeliveryOutcome {
                records { nodes { granularity { time } metrics { cost } } }
            }
        }
    }`);
    const byDate = {};
    for (const n of (data?.campaignDelivery?.records?.nodes || [])) {
        const dt = String(n.granularity?.time || "").slice(0, 10);
        if (dt) byDate[dt] = (byDate[dt] || 0) + parseFloat(n.metrics?.cost || 0);
    }
    return byDate;
}

async function fetchStackAdaptCampaignPerf(advertiserId, from, to) {
    const data = await stackAdaptGQL(`{
        campaignDelivery(
            dataType: TABLE
            granularity: TOTAL
            date: { from: "${from}", to: "${to}" }
            filterBy: { advertiserIds: [${parseInt(advertiserId)}] }
        ) {
            ... on CampaignDeliveryOutcome {
                records { nodes { campaign { id name } metrics { cost impressionsBigint clicksBigint conversions } } }
            }
        }
    }`);
    return (data?.campaignDelivery?.records?.nodes || []).map(n => {
        const m     = n.metrics || {};
        const spend = parseFloat(m.cost || 0);
        const imps  = parseInt(m.impressionsBigint || 0);
        const clicks = parseInt(m.clicksBigint || 0);
        const convs = parseFloat(m.conversions || 0);
        return {
            campaign:    n.campaign?.name,
            spend:       Math.round(spend * 100) / 100,
            impressions: imps,
            clicks,
            ctr:         imps > 0 ? (clicks / imps * 100).toFixed(2) + "%" : "0%",
            avg_cpm:     imps > 0 ? "$" + (spend / imps * 1000).toFixed(2) : null,
            conversions: convs,
            cpa:         convs > 0 ? "$" + (Math.round((spend / convs) * 100) / 100) : null,
        };
    });
}

// Resolve a report date_range to concrete from/to dates (StackAdapt has no presets)
function rangeToDates(dateRange, startDate, endDate) {
    const { today, yesterday, month_start } = getDateInfo();
    if (dateRange === "CUSTOM" && startDate && endDate) return { from: startDate, to: endDate };
    const [y, m] = today.split("-").map(Number);
    const fmt = dt => dt.toISOString().split("T")[0];
    switch (dateRange) {
        case "LAST_7_DAYS":  return { from: daysAgo(7, today),  to: yesterday };
        case "LAST_30_DAYS": return { from: daysAgo(30, today), to: yesterday };
        case "LAST_90_DAYS": return { from: daysAgo(90, today), to: yesterday };
        case "LAST_MONTH":   return { from: fmt(new Date(Date.UTC(y, m - 2, 1))), to: fmt(new Date(Date.UTC(y, m - 1, 0))) };
        case "YEAR_TO_DATE": {
            const yearStart = `${y}-01-01`;
            return { from: yearStart, to: yesterday >= yearStart ? yesterday : today };
        }
        case "THIS_MONTH":
        default:
            // On the 1st there are no complete days yet — clamp to a valid single-day window
            return { from: month_start, to: yesterday >= month_start ? yesterday : month_start };
    }
}

async function buildStackAdaptRows(pace_dom, dim, today, monthStart, yesterday) {
    return Promise.all(Object.entries(STACKADAPT_ADVERTISERS).map(async ([advId, info]) => {
        const { budget } = getEffectiveBudget(info, today);
        try {
            if (info.flight_start && info.flight_end) {
                const until = yesterday < info.flight_end ? yesterday : info.flight_end;
                const { spend } = emptyWindow(info.flight_start, until) ? { spend: 0 }
                    : await fetchStackAdaptSpend(advId, info.flight_start, until);
                return { account: info.name, flight_spend: Math.round(spend * 100) / 100,
                    ...getFlightPacing(spend, budget, info.flight_start, info.flight_end, yesterday) };
            }
            const { spend } = emptyWindow(monthStart, yesterday) ? { spend: 0 }
                : await fetchStackAdaptSpend(advId, monthStart, yesterday);
            return { account: info.name, mtd_spend: Math.round(spend * 100) / 100,
                budget, ...getPacingLabel(spend, budget, pace_dom, dim) };
        } catch (e) { return { account: info.name, error: e.message }; }
    }));
}

// ── LinkedIn ─────────────────────────────────────────────────────────────────
async function liGet(apiPath) {
    if (!LINKEDIN_ACCESS_TOKEN) throw new Error("LINKEDIN_ACCESS_TOKEN env var not set.");
    const url = apiPath.startsWith("http") ? apiPath : `https://api.linkedin.com/rest${apiPath}`;
    const resp = await fetchFn(url, {
        headers: {
            "Authorization": `Bearer ${LINKEDIN_ACCESS_TOKEN}`,
            "LinkedIn-Version": LINKEDIN_API_VERSION,
            "X-Restli-Protocol-Version": "2.0.0",
        },
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`LinkedIn API ${resp.status}: ${text.slice(0, 300)}`);
    }
    return resp.json();
}

async function fetchLinkedInMTD(accountId, from, to) {
    const [fy, fm, fd] = from.split("-").map(Number);
    const [ty, tm, td] = to.split("-").map(Number);
    try {
        const data = await liGet(
            `/adAnalytics?q=analytics&pivot=ACCOUNT&timeGranularity=ALL` +
            `&dateRange=(start:(year:${fy},month:${fm},day:${fd}),end:(year:${ty},month:${tm},day:${td}))` +
            `&accounts=List(urn%3Ali%3AsponsoredAccount%3A${accountId})` +
            `&fields=costInLocalCurrency`
        );
        const elems = data.elements || [];
        const spend = elems.reduce((s, e) => {
            const raw = e.costInLocalCurrency;
            return s + (typeof raw === "string" ? parseFloat(raw) : (raw || 0));
        }, 0);
        return { spend };
    } catch (e) {
        return { spend: 0, error: e.message };
    }
}

async function fetchLinkedInDailyBudgets(accountId) {
    try {
        const data = await liGet(
            `/adAccounts/${accountId}/adCampaigns?q=search` +
            `&search=(status:(values:List(ACTIVE)))` +
            `&fields=id,name,dailyBudget,totalBudget,status`
        );
        const campaigns = (data.elements || []);
        let dailyTotal = 0;
        let hasLifetime = false;
        for (const c of campaigns) {
            if (c.dailyBudget?.amount) dailyTotal += parseFloat(c.dailyBudget.amount) / 100;
            if (c.totalBudget?.amount) hasLifetime = true;
        }
        const result = { daily_total: Math.round(dailyTotal * 100) / 100, campaigns: campaigns.length };
        if (hasLifetime && dailyTotal === 0) result.note = "Some budgets are lifetime, not daily — current_daily_budget undercounts.";
        return result;
    } catch (e) {
        return { daily_total: 0, campaigns: 0, error: e.message };
    }
}

async function buildLinkedInRows(pace_dom, dim, today, monthStart, yesterday) {
    return Promise.all(Object.entries(LINKEDIN_ACCOUNTS).map(async ([acctId, info]) => {
        const { budget } = getEffectiveBudget(info, today);
        try {
            if (info.flight_start && info.flight_end) {
                const until = yesterday < info.flight_end ? yesterday : info.flight_end;
                const { spend, error } = emptyWindow(info.flight_start, until) ? { spend: 0 }
                    : await fetchLinkedInMTD(acctId, info.flight_start, until);
                const row = { account: info.name, flight_spend: Math.round(spend * 100) / 100,
                    ...getFlightPacing(spend, budget, info.flight_start, info.flight_end, yesterday) };
                if (error) row.api_error = error;
                const db = await fetchLinkedInDailyBudgets(acctId);
                const fp = getFlightPacing(spend, budget, info.flight_start, info.flight_end, yesterday);
                if (fp.days_remaining > 0) {
                    row.daily_budget = buildDailyBudgetRec(db.daily_total, fp.remaining, fp.days_remaining) || {};
                } else {
                    row.daily_budget = { current_daily_budget: db.daily_total, needed_per_day: fp.needed_per_day, days_remaining: fp.days_remaining };
                }
                if (db.note) row.daily_budget.note = db.note;
                if (db.error) row.daily_budget.error = db.error;
                return row;
            }
            const { spend, error } = emptyWindow(monthStart, yesterday) ? { spend: 0 }
                : await fetchLinkedInMTD(acctId, monthStart, yesterday);
            const row = { account: info.name, mtd_spend: Math.round(spend * 100) / 100,
                budget, ...getPacingLabel(spend, budget, pace_dom, dim) };
            if (error) row.api_error = error;
            return row;
        } catch (e) { return { account: info.name, error: e.message }; }
    }));
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

async function fetchCallTrackingDiagnostics(token, customerId, mccId) {
    // 1. Call assets linked to campaigns (call_asset via campaign_asset)
    const callAssets = await googleSearch(token, customerId, mccId, `
        SELECT campaign.name, campaign.status,
               asset.call_asset.phone_number, asset.call_asset.country_code,
               asset.call_asset.call_conversion_action,
               asset.call_asset.call_conversion_reporting_state,
               campaign_asset.status, campaign_asset.field_type
        FROM campaign_asset
        WHERE campaign_asset.field_type = 'CALL'
          AND campaign.status != 'REMOVED'`).catch(() => []);

    // 2. Customer-level call assets (account-level)
    const customerCallAssets = await googleSearch(token, customerId, mccId, `
        SELECT asset.call_asset.phone_number, asset.call_asset.country_code,
               asset.call_asset.call_conversion_action,
               asset.call_asset.call_conversion_reporting_state,
               customer_asset.status, customer_asset.field_type
        FROM customer_asset
        WHERE customer_asset.field_type = 'CALL'`).catch(() => []);

    // 3. Conversion actions — full detail including phone_call_duration_seconds
    const convActions = await googleSearch(token, customerId, mccId, `
        SELECT conversion_action.name, conversion_action.id, conversion_action.type,
               conversion_action.category, conversion_action.status,
               conversion_action.primary_for_goal,
               conversion_action.phone_call_duration_seconds,
               conversion_action.counting_type
        FROM conversion_action
        WHERE conversion_action.status = 'ENABLED'`);

    // 4. Volume for call-type conversion actions (30d / 7d)
    const callTypes = new Set(["AD_CALL", "WEBSITE_CALL", "CLICK_TO_CALL"]);
    const volumeQuery = range => googleSearch(token, customerId, mccId, `
        SELECT conversion_action.name, metrics.all_conversions
        FROM conversion_action
        WHERE segments.date DURING ${range}`).catch(() => []);
    const [d30, d7] = await Promise.all([volumeQuery("LAST_30_DAYS"), volumeQuery("LAST_7_DAYS")]);
    const vol = rows => Object.fromEntries(rows.map(r => [r.conversionAction.name, parseFloat(r.metrics?.allConversions || 0)]));
    const v30 = vol(d30), v7 = vol(d7);

    // 5. Enabled campaigns (to flag ones without call assets)
    const campaigns = await googleSearch(token, customerId, mccId, `
        SELECT campaign.name, campaign.id, campaign.advertising_channel_type
        FROM campaign
        WHERE campaign.status = 'ENABLED'`);

    // Build call asset map: campaign name → asset details
    const campaignCallAssets = {};
    for (const r of callAssets) {
        const cn = r.campaign.name;
        if (!campaignCallAssets[cn]) campaignCallAssets[cn] = [];
        campaignCallAssets[cn].push({
            phone_number: `+${r.asset?.callAsset?.countryCode || ""} ${r.asset?.callAsset?.phoneNumber || ""}`.trim(),
            status: r.campaignAsset?.status,
            conversion_reporting: r.asset?.callAsset?.callConversionReportingState,
        });
    }

    // Account-level call assets
    const accountCallAssets = customerCallAssets.map(r => ({
        phone_number: `+${r.asset?.callAsset?.countryCode || ""} ${r.asset?.callAsset?.phoneNumber || ""}`.trim(),
        status: r.customerAsset?.status,
        conversion_reporting: r.asset?.callAsset?.callConversionReportingState,
    }));

    // Campaign coverage
    const campaignCoverage = campaigns.map(r => ({
        campaign: r.campaign.name,
        type: r.campaign.advertisingChannelType,
        has_call_asset: !!(campaignCallAssets[r.campaign.name]?.length || accountCallAssets.length),
        call_assets: campaignCallAssets[r.campaign.name] || [],
        inherits_account_level: !campaignCallAssets[r.campaign.name]?.length && accountCallAssets.length > 0,
    }));

    // Call-related conversion actions with detail
    const callConvActions = convActions
        .filter(r => callTypes.has(r.conversionAction.type))
        .map(r => {
            const name = r.conversionAction.name;
            return {
                conversion_action: name,
                id: r.conversionAction.id,
                type: r.conversionAction.type,
                category: r.conversionAction.category,
                primary: !!r.conversionAction.primaryForGoal,
                min_call_duration_seconds: parseInt(r.conversionAction.phoneCallDurationSeconds || 0),
                counting_type: r.conversionAction.countingType,
                conversions_30d: v30[name] || 0,
                conversions_7d: v7[name] || 0,
            };
        });

    // Detect duplicates: same type + both primary
    const duplicates = [];
    const byType = {};
    for (const a of callConvActions) {
        const key = a.type;
        if (!byType[key]) byType[key] = [];
        byType[key].push(a);
    }
    for (const [type, actions] of Object.entries(byType)) {
        const primaries = actions.filter(a => a.primary);
        if (primaries.length > 1) {
            duplicates.push({
                type,
                count: primaries.length,
                actions: primaries.map(a => a.conversion_action),
                warning: `${primaries.length} primary ${type} actions — risk of double-counting if both fire`,
            });
        }
    }

    // Campaigns with no call coverage at all
    const noCoverage = campaignCoverage.filter(c => !c.has_call_asset);

    // Website call actions — flag if present but inactive
    const websiteCallActions = callConvActions.filter(a => a.type === "WEBSITE_CALL");

    // Build alerts
    const alerts = [];
    if (noCoverage.length) alerts.push(`${noCoverage.length} enabled campaign(s) have no call asset — AD_CALL conversions won't fire for them`);
    if (duplicates.length) alerts.push(...duplicates.map(d => d.warning));
    for (const wc of websiteCallActions) {
        if (wc.conversions_30d === 0) alerts.push(`"${wc.conversion_action}" (WEBSITE_CALL) has 0 conversions in 30d — verify the phone snippet is deployed and the number matches`);
        if (wc.min_call_duration_seconds >= 60) alerts.push(`"${wc.conversion_action}" minimum call duration is ${wc.min_call_duration_seconds}s — short calls won't count`);
    }
    for (const ac of callConvActions.filter(a => a.type === "AD_CALL")) {
        if (ac.conversions_30d === 0 && noCoverage.length === campaignCoverage.length) {
            alerts.push(`"${ac.conversion_action}" (AD_CALL) has 0 conversions — no campaigns have call assets attached`);
        } else if (ac.conversions_30d === 0) {
            alerts.push(`"${ac.conversion_action}" (AD_CALL) has 0 conversions in 30d but call assets exist — check if the asset is enabled`);
        }
    }

    return {
        account_level_call_assets: accountCallAssets,
        campaign_coverage: campaignCoverage,
        call_conversion_actions: callConvActions,
        duplicates,
        campaigns_without_call_asset: noCoverage.map(c => c.campaign),
        alerts,
    };
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
    if (avg === 0) {
        // No trailing spend at all — a percentage is meaningless
        return ydaySpend > 0
            ? { type: "SPEND_SPIKE", yesterday: ydaySpend, trailing_7d_avg: 0, change: "new spend" }
            : null;
    }
    const pct = Math.round(((ydaySpend - avg) / avg) * 100);
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
    // Update masks may only list leaf fields (parent scheme fields are rejected
    // with FIELD_HAS_SUBFIELDS), so strategy switches set bidding_strategy_type
    // directly; Maximize Clicks is the TARGET_SPEND scheme.
    if (s === "MANUAL_CPC") {
        return { campaignFields: { biddingStrategyType: "MANUAL_CPC" }, updateMask: "bidding_strategy_type" };
    } else if (s === "ENHANCED_CPC") {
        throw new Error("Enhanced CPC was sunset by Google and can no longer be set via the API — use MANUAL_CPC or MAXIMIZE_CLICKS instead.");
    } else if (s === "MAXIMIZE_CLICKS") {
        if (options.cpc_bid_ceiling) {
            return {
                campaignFields: { biddingStrategyType: "TARGET_SPEND", targetSpend: { cpcBidCeilingMicros: String(Math.round(options.cpc_bid_ceiling * 1_000_000)) } },
                updateMask: "bidding_strategy_type,target_spend.cpc_bid_ceiling_micros",
            };
        }
        return { campaignFields: { biddingStrategyType: "TARGET_SPEND" }, updateMask: "bidding_strategy_type" };
    } else if (s === "MAXIMIZE_CONVERSIONS") {
        if (options.target_cpa) {
            return {
                campaignFields: { biddingStrategyType: "MAXIMIZE_CONVERSIONS", maximizeConversions: { targetCpaMicros: String(Math.round(options.target_cpa * 1_000_000)) } },
                updateMask: "bidding_strategy_type,maximize_conversions.target_cpa_micros",
            };
        }
        return { campaignFields: { biddingStrategyType: "MAXIMIZE_CONVERSIONS" }, updateMask: "bidding_strategy_type" };
    } else if (s === "TARGET_CPA") {
        if (!options.target_cpa) throw new Error("target_cpa (dollars) is required for TARGET_CPA strategy");
        return {
            campaignFields: { biddingStrategyType: "TARGET_CPA", targetCpa: { targetCpaMicros: String(Math.round(options.target_cpa * 1_000_000)) } },
            updateMask: "bidding_strategy_type,target_cpa.target_cpa_micros",
        };
    } else if (s === "TARGET_ROAS") {
        if (!options.target_roas) throw new Error("target_roas is required for TARGET_ROAS strategy (e.g. 3.0 = 300% ROAS)");
        return {
            campaignFields: { biddingStrategyType: "TARGET_ROAS", targetRoas: { targetRoas: options.target_roas } },
            updateMask: "bidding_strategy_type,target_roas.target_roas",
        };
    } else if (s === "MAXIMIZE_CONVERSION_VALUE") {
        if (options.target_roas) {
            return {
                campaignFields: { biddingStrategyType: "MAXIMIZE_CONVERSION_VALUE", maximizeConversionValue: { targetRoas: options.target_roas } },
                updateMask: "bidding_strategy_type,maximize_conversion_value.target_roas",
            };
        }
        return { campaignFields: { biddingStrategyType: "MAXIMIZE_CONVERSION_VALUE" }, updateMask: "bidding_strategy_type" };
    } else {
        throw new Error(`Unknown strategy: ${strategy}. Valid: MANUAL_CPC, MAXIMIZE_CLICKS, MAXIMIZE_CONVERSIONS, TARGET_CPA, TARGET_ROAS`);
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
    if (!resp.ok) throw new Error(googleAdsError(data));
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
                resourceName:    budgetTempName,
                name:            `${config.campaign_name} Budget`,
                amountMicros:    String(Math.round(config.daily_budget * 1_000_000)),
                deliveryMethod:  "STANDARD",
                explicitlyShared: false,
            },
        },
    });

    // Op 1: Campaign. campaign.bidding_strategy_type is read-only, so a create
    // must set the bidding scheme oneof field — buildBiddingUpdateBody's output
    // only works for updates.
    const strategy = (config.bidding_strategy || "MANUAL_CPC").toUpperCase();
    let biddingFields;
    if (strategy === "MANUAL_CPC") {
        biddingFields = { manualCpc: {} };
    } else if (strategy === "MAXIMIZE_CLICKS") {
        biddingFields = { targetSpend: {} };
    } else if (strategy === "MAXIMIZE_CONVERSIONS") {
        biddingFields = { maximizeConversions: {} };
    } else if (strategy === "ENHANCED_CPC") {
        throw new Error("Enhanced CPC was sunset by Google and can no longer be set via the API — use MANUAL_CPC or MAXIMIZE_CLICKS instead.");
    } else if (strategy === "TARGET_CPA" || strategy === "TARGET_ROAS") {
        throw new Error(`${strategy} needs a target value, which create_campaign doesn't collect — create with MANUAL_CPC or MAXIMIZE_CONVERSIONS, then switch via set_bidding_strategy.`);
    } else {
        throw new Error(`Unknown strategy: ${strategy}. Valid for creation: MANUAL_CPC, MAXIMIZE_CLICKS, MAXIMIZE_CONVERSIONS`);
    }
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
                    targetSearchNetwork: false,
                    targetContentNetwork: false,
                },
                geoTargetTypeSetting: {
                    positiveGeoTargetType: "PRESENCE",
                },
                containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
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

    // Language targeting: English
    mutateOperations.push({
        campaignCriterionOperation: {
            create: {
                campaign: campaignTempName,
                language: { languageConstant: "languageConstants/1000" },
            },
        },
    });

    // Geo targeting
    for (const geoId of (config.geo_targets || [])) {
        mutateOperations.push({
            campaignCriterionOperation: {
                create: {
                    campaign: campaignTempName,
                    location: { geoTargetConstant: `geoTargetConstants/${geoId}` },
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
    if (!resp.ok) throw new Error(googleAdsError(data));

    const results = data.mutateOperationResponses || [];
    return {
        campaign_resource: results[1]?.campaignResult?.resourceName,
        budget_resource:   results[0]?.campaignBudgetResult?.resourceName,
        total_ops:         mutateOperations.length,
        results_count:     results.length,
    };
}

async function getAdGroupAds(token, customerId, mccId, campaignSearch, adGroupSearch, adResourceName) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT
            ad_group_ad.ad.resource_name,
            ad_group_ad.ad.final_urls,
            ad_group_ad.ad.responsive_search_ad.headlines,
            ad_group_ad.ad.responsive_search_ad.descriptions,
            ad_group.name,
            campaign.name
        FROM ad_group_ad
        WHERE ad_group_ad.status != 'REMOVED'
          AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'`);
    let filtered = rows;
    if (adResourceName) {
        filtered = filtered.filter(r => r.adGroupAd.ad.resourceName === adResourceName);
    } else {
        if (campaignSearch) {
            const exact = filtered.filter(r => r.campaign.name.toLowerCase() === campaignSearch.toLowerCase());
            filtered = exact.length ? exact : filtered.filter(r => r.campaign.name.toLowerCase().includes(campaignSearch.toLowerCase()));
        }
        if (adGroupSearch) {
            const exact = filtered.filter(r => r.adGroup.name.toLowerCase() === adGroupSearch.toLowerCase());
            filtered = exact.length ? exact : filtered.filter(r => r.adGroup.name.toLowerCase().includes(adGroupSearch.toLowerCase()));
        }
    }
    return filtered.map(r => ({
        resource_name: r.adGroupAd.ad.resourceName,
        campaign:      r.campaign.name,
        ad_group:      r.adGroup.name,
        final_urls:    r.adGroupAd.ad.finalUrls || [],
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
                    adOperation: {
                        update: {
                            resourceName: adResourceName,
                            responsiveSearchAd: { headlines: headlineObjs, descriptions: descObjs },
                        },
                        updateMask: "responsive_search_ad.headlines,responsive_search_ad.descriptions",
                    },
                }],
            }),
        }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(googleAdsError(data));
    return data;
}

async function updateAdFinalUrl(token, customerId, mccId, adResourceName, finalUrl) {
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
                    adOperation: {
                        update: {
                            resourceName: adResourceName,
                            finalUrls: [finalUrl],
                        },
                        updateMask: "final_urls",
                    },
                }],
            }),
        }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(googleAdsError(data));
    return data;
}

async function listAccountAssets(token, customerId, mccId, assetTypes) {
    // assetTypes: optional array of IMAGE, TEXT, YOUTUBE_VIDEO
    let where = "asset.type != 'UNKNOWN'";
    if (assetTypes?.length) where = `asset.type IN (${assetTypes.map(t => `'${t}'`).join(",")})`;
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT asset.resource_name, asset.name, asset.type,
               asset.text_asset.text,
               asset.image_asset.full_size.url,
               asset.image_asset.full_size.width_pixels,
               asset.image_asset.full_size.height_pixels,
               asset.youtube_video_asset.youtube_video_id,
               asset.youtube_video_asset.youtube_video_title
        FROM asset
        WHERE ${where}
        ORDER BY asset.type`);
    return rows.map(r => {
        const a = r.asset;
        const base = { resource_name: a.resourceName, name: a.name || null, type: a.type };
        if (a.type === "TEXT")  return { ...base, text: a.textAsset?.text };
        if (a.type === "IMAGE") {
            const img = a.imageAsset?.fullSize || {};
            const w = parseInt(img.widthPixels || 0), h = parseInt(img.heightPixels || 0);
            let ratio = null;
            if (w && h) {
                const r = w / h;
                if (Math.abs(r - 1.91) < 0.1) ratio = "landscape_1.91:1";
                else if (Math.abs(r - 1) < 0.1)   ratio = "square_1:1";
                else if (Math.abs(r - 4) < 0.2)   ratio = "landscape_4:1";
                else if (Math.abs(r - 0.8) < 0.1) ratio = "portrait_4:5";
                else ratio = `${w}x${h}`;
            }
            return { ...base, url: img.url || null, width: w, height: h, ratio };
        }
        if (a.type === "YOUTUBE_VIDEO") return { ...base, video_id: a.youtubeVideoAsset?.youtubeVideoId, title: a.youtubeVideoAsset?.youtubeVideoTitle };
        return base;
    });
}

async function createPmaxCampaignFull(token, customerId, mccId, config) {
    // config: {
    //   campaign_name, daily_budget, bidding_strategy (MAXIMIZE_CONVERSIONS|MAXIMIZE_CONVERSION_VALUE),
    //   final_url, business_name_asset (resource_name), logo_asset (resource_name),
    //   asset_group_name,
    //   headlines: [{text}], long_headlines: [{text}], descriptions: [{text}],
    //   marketing_images: [resource_name], square_marketing_images: [resource_name],
    //   youtube_videos: [resource_name] (optional),
    //   geo_targets: [int] (required),
    // }
    const mutateOperations = [];
    const budgetTemp   = `customers/${customerId}/campaignBudgets/-1`;
    const campaignTemp = `customers/${customerId}/campaigns/-2`;
    const agTemp       = `customers/${customerId}/assetGroups/-3`;

    // 1. Budget
    mutateOperations.push({
        campaignBudgetOperation: {
            create: {
                resourceName:    budgetTemp,
                name:            `${config.campaign_name} Budget`,
                amountMicros:    String(Math.round(config.daily_budget * 1_000_000)),
                deliveryMethod:  "STANDARD",
                explicitlyShared: false,
            },
        },
    });

    // 2. Text assets (must be created before asset group links)
    let tempId = -10;
    const headlineRefs = [], longHeadlineRefs = [], descriptionRefs = [];
    for (const h of (config.headlines || [])) {
        const ref = `customers/${customerId}/assets/${tempId--}`;
        mutateOperations.push({ assetOperation: { create: { resourceName: ref, textAsset: { text: h.text } } } });
        headlineRefs.push(ref);
    }
    for (const lh of (config.long_headlines || [])) {
        const ref = `customers/${customerId}/assets/${tempId--}`;
        mutateOperations.push({ assetOperation: { create: { resourceName: ref, textAsset: { text: lh.text } } } });
        longHeadlineRefs.push(ref);
    }
    for (const d of (config.descriptions || [])) {
        const ref = `customers/${customerId}/assets/${tempId--}`;
        mutateOperations.push({ assetOperation: { create: { resourceName: ref, textAsset: { text: d.text } } } });
        descriptionRefs.push(ref);
    }

    // 3. Campaign
    const strategy = (config.bidding_strategy || "MAXIMIZE_CONVERSIONS").toUpperCase();
    let biddingFields;
    if (strategy === "MAXIMIZE_CONVERSIONS") biddingFields = { maximizeConversions: {} };
    else if (strategy === "MAXIMIZE_CONVERSION_VALUE") biddingFields = { maximizeConversionValue: {} };
    else throw new Error(`PMax only supports MAXIMIZE_CONVERSIONS or MAXIMIZE_CONVERSION_VALUE, not ${strategy}`);

    mutateOperations.push({
        campaignOperation: {
            create: {
                resourceName:           campaignTemp,
                name:                   config.campaign_name,
                status:                 "PAUSED",
                advertisingChannelType: "PERFORMANCE_MAX",
                campaignBudget:         budgetTemp,
                containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
                ...biddingFields,
            },
        },
    });

    // 4. Campaign-level brand assets (business name + logo)
    mutateOperations.push({
        campaignAssetOperation: {
            create: { campaign: campaignTemp, asset: config.business_name_asset, fieldType: "BUSINESS_NAME" },
        },
    });
    mutateOperations.push({
        campaignAssetOperation: {
            create: { campaign: campaignTemp, asset: config.logo_asset, fieldType: "LOGO" },
        },
    });

    // 5. Asset group
    mutateOperations.push({
        assetGroupOperation: {
            create: {
                resourceName: agTemp,
                campaign:     campaignTemp,
                name:         config.asset_group_name || config.campaign_name,
                status:       "PAUSED",
                finalUrls:    [config.final_url],
            },
        },
    });

    // 6. Asset group asset links — all in one block after the asset group
    const assetLinks = [];
    for (const ref of headlineRefs)     assetLinks.push({ asset: ref, fieldType: "HEADLINE" });
    for (const ref of longHeadlineRefs) assetLinks.push({ asset: ref, fieldType: "LONG_HEADLINE" });
    for (const ref of descriptionRefs)  assetLinks.push({ asset: ref, fieldType: "DESCRIPTION" });
    for (const ref of (config.marketing_images || []))        assetLinks.push({ asset: ref, fieldType: "MARKETING_IMAGE" });
    for (const ref of (config.square_marketing_images || [])) assetLinks.push({ asset: ref, fieldType: "SQUARE_MARKETING_IMAGE" });
    for (const ref of (config.youtube_videos || []))          assetLinks.push({ asset: ref, fieldType: "YOUTUBE_VIDEO" });
    for (const ref of (config.logo_assets || []))             assetLinks.push({ asset: ref, fieldType: "LOGO" });

    for (const link of assetLinks) {
        mutateOperations.push({
            assetGroupAssetOperation: {
                create: { assetGroup: agTemp, ...link },
            },
        });
    }

    // 7. Geo targeting + language (English)
    mutateOperations.push({
        campaignCriterionOperation: {
            create: { campaign: campaignTemp, language: { languageConstant: "languageConstants/1000" } },
        },
    });
    for (const geoId of (config.geo_targets || [])) {
        mutateOperations.push({
            campaignCriterionOperation: {
                create: { campaign: campaignTemp, location: { geoTargetConstant: `geoTargetConstants/${geoId}` } },
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
    if (!resp.ok) throw new Error(googleAdsError(data));

    const results = data.mutateOperationResponses || [];
    return {
        campaign_resource: results.find(r => r.campaignResult)?.campaignResult?.resourceName,
        budget_resource:   results.find(r => r.campaignBudgetResult)?.campaignBudgetResult?.resourceName,
        asset_group_resource: results.find(r => r.assetGroupResult)?.assetGroupResult?.resourceName,
        total_ops:         mutateOperations.length,
        results_count:     results.length,
    };
}

async function createVideoCampaignFull(token, customerId, mccId, config) {
    // config: {
    //   campaign_name, daily_budget, bidding_strategy (MANUAL_CPV|MAXIMIZE_CONVERSIONS|TARGET_CPM),
    //   final_url, geo_targets: [int],
    //   ad_groups: [{ name, youtube_video (asset resource name OR YouTube video ID/URL), headline, call_to_action }]
    // }
    const mutateOperations = [];
    const budgetTemp   = `customers/${customerId}/campaignBudgets/-1`;
    const campaignTemp = `customers/${customerId}/campaigns/-2`;

    // 0. Normalize youtube_videos array and resolve video references
    // Each entry can be a string (URL/ID/resource) or object { url, final_url, ad_name }
    let assetTempId = -100;
    for (const ag of (config.ad_groups || [])) {
        if (!ag.youtube_videos) ag.youtube_videos = ag.youtube_video ? [ag.youtube_video] : [];
        const resolved = [];
        for (const entry of ag.youtube_videos) {
            const isObj = typeof entry === "object" && entry !== null;
            const vid = isObj ? (entry.url || entry.video || "") : entry;
            const meta = isObj ? entry : {};
            let ref;
            if (vid.startsWith("customers/")) {
                ref = vid;
            } else {
                const idMatch = vid.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/);
                const videoId = idMatch ? idMatch[1] : vid.replace(/^https?:\/\//, "").trim();
                ref = `customers/${customerId}/assets/${assetTempId--}`;
                mutateOperations.push({
                    assetOperation: {
                        create: { resourceName: ref, youtubeVideoAsset: { youtubeVideoId: videoId } },
                    },
                });
            }
            resolved.push({ ref, final_url: meta.final_url || null, ad_name: meta.ad_name || null });
        }
        ag._resolved_videos = resolved;
    }

    // 1. Budget
    mutateOperations.push({
        campaignBudgetOperation: {
            create: {
                resourceName:    budgetTemp,
                name:            `${config.campaign_name} Budget`,
                amountMicros:    String(Math.round(config.daily_budget * 1_000_000)),
                deliveryMethod:  "STANDARD",
                explicitlyShared: false,
            },
        },
    });

    // 2. Campaign
    const strategy = (config.bidding_strategy || "TARGET_CPM").toUpperCase();
    let biddingFields;
    if (strategy === "TARGET_CPM" || strategy === "MANUAL_CPV" || strategy === "TARGET_CPV")
        biddingFields = { targetCpm: {} };
    else if (strategy === "MAXIMIZE_CONVERSIONS") biddingFields = { maximizeConversions: {} };
    else throw new Error(`Unsupported bidding strategy for Video: ${strategy}. Valid: TARGET_CPM, MAXIMIZE_CONVERSIONS`);

    mutateOperations.push({
        campaignOperation: {
            create: {
                resourceName:           campaignTemp,
                name:                   config.campaign_name,
                status:                 "PAUSED",
                advertisingChannelType: "VIDEO",
                campaignBudget:         budgetTemp,
                containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
                ...biddingFields,
            },
        },
    });

    // 3. Ad groups + in-stream video ads
    let tempCounter = -3;
    for (const ag of (config.ad_groups || [])) {
        const agTemp = `customers/${customerId}/adGroups/${tempCounter--}`;
        mutateOperations.push({
            adGroupOperation: {
                create: {
                    resourceName: agTemp,
                    name:         ag.name,
                    campaign:     campaignTemp,
                    status:       "ENABLED",
                    type:         "VIDEO_TRUE_VIEW_IN_STREAM",
                },
            },
        });

        for (let vi = 0; vi < ag._resolved_videos.length; vi++) {
            const rv = ag._resolved_videos[vi];
            mutateOperations.push({
                adGroupAdOperation: {
                    create: {
                        adGroup: agTemp,
                        status:  "ENABLED",
                        ad: {
                            name:      rv.ad_name || (ag._resolved_videos.length > 1
                                ? `${ag.name} - Video ${vi + 1}`
                                : (ag.ad_name || `${ag.name} - Video Ad`)),
                            finalUrls: [rv.final_url || config.final_url],
                            videoAd: {
                                video: { asset: rv.ref },
                                inStream: {
                                    actionButtonLabel: ag.call_to_action || "Learn More",
                                    actionHeadline:    ag.headline || config.campaign_name,
                                },
                            },
                        },
                    },
                },
            });
        }
    }

    // 4. Language targeting (English)
    mutateOperations.push({
        campaignCriterionOperation: {
            create: { campaign: campaignTemp, language: { languageConstant: "languageConstants/1000" } },
        },
    });

    // 5. Geo targeting
    for (const geoId of (config.geo_targets || [])) {
        mutateOperations.push({
            campaignCriterionOperation: {
                create: { campaign: campaignTemp, location: { geoTargetConstant: `geoTargetConstants/${geoId}` } },
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
    if (!resp.ok) throw new Error(googleAdsError(data));

    const results = data.mutateOperationResponses || [];
    return {
        campaign_resource: results.find(r => r.campaignResult)?.campaignResult?.resourceName,
        budget_resource:   results.find(r => r.campaignBudgetResult)?.campaignBudgetResult?.resourceName,
        ad_groups:         results.filter(r => r.adGroupResult).map(r => r.adGroupResult.resourceName),
        ads:               results.filter(r => r.adGroupAdResult).map(r => r.adGroupAdResult.resourceName),
        total_ops:         mutateOperations.length,
        results_count:     results.length,
    };
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
    if (!resp.ok) throw new Error(googleAdsError(data));

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
               campaign.target_spend.cpc_bid_ceiling_micros,
               campaign.maximize_conversions.target_cpa_micros,
               campaign.target_cpa.target_cpa_micros,
               campaign.target_roas.target_roas,
               campaign.maximize_conversion_value.target_roas,
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
        if (c.targetSpend?.cpcBidCeilingMicros) {
            out.cpc_bid_ceiling = "$" + (parseInt(c.targetSpend.cpcBidCeilingMicros) / 1_000_000).toFixed(2);
        } else if (c.biddingStrategyType === "TARGET_SPEND" || c.biddingStrategyType === "MAXIMIZE_CLICKS") {
            out.cpc_bid_ceiling = null; // Maximize Clicks active but no cap set
        }
        if (c.targetCpa?.targetCpaMicros) {
            out.target_cpa = "$" + (parseInt(c.targetCpa.targetCpaMicros) / 1_000_000).toFixed(2);
        }
        if (c.targetRoas?.targetRoas) {
            out.target_roas = c.targetRoas.targetRoas;
        } else if (c.maximizeConversionValue?.targetRoas) {
            out.target_roas = c.maximizeConversionValue.targetRoas;
        }
        if (c.manualCpc != null) {
            out.enhanced_cpc = !!c.manualCpc.enhancedCpcEnabled;
        }
        if (!out.target_cpa && c.maximizeConversions?.targetCpaMicros) {
            out.target_cpa = "$" + (parseInt(c.maximizeConversions.targetCpaMicros) / 1_000_000).toFixed(2);
        }
        return out;
    });
}

// get_change_history — queries the change_event resource for audit trail
// change_event requires explicit BETWEEN dates (DURING not supported), max 30 days back.
async function fetchChangeHistory(token, customerId, mccId, days, resourceType) {
    const { today, yesterday } = getDateInfo();
    const lookbackDays = Math.min(days || 14, 30);
    const startDate = daysAgo(lookbackDays, today);
    let where = `change_event.change_date_time BETWEEN '${startDate}' AND '${today}'`;
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

// Campaign lookup without the THIS_MONTH date filter so it
// finds campaigns regardless of whether they've spent anything this month.
async function listGoogleCampaignsAll(token, customerId, mccId) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
               campaign_budget.amount_micros, campaign.resource_name
        FROM campaign
        WHERE campaign.status != 'REMOVED'
        ORDER BY campaign.name`);
    return rows.map(r => ({
        id:            r.campaign.id,
        name:          r.campaign.name,
        status:        r.campaign.status,
        type:          r.campaign.advertisingChannelType,
        daily_budget:  r.campaignBudget?.amountMicros
                           ? "$" + (parseInt(r.campaignBudget.amountMicros) / 1_000_000).toFixed(2)
                           : null,
        resource_name: r.campaign.resourceName,
    }));
}

// Generic googleAds:mutate wrapper for typed mutate operations
async function googleMutateOps(token, customerId, mccId, mutateOperations) {
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
    if (!resp.ok) throw new Error(googleAdsError(data));
    return data.mutateOperationResponses || [];
}

// ── Shopping / product-level reporting ───────────────────────────────────────
// shopping_performance_view is the product-level report in the Google Ads API.
// It covers Shopping *and* Performance Max retail campaigns, segmented by the
// Merchant Center product dimensions.
//
// Two field-naming traps, both verified against the v24 resource definitions:
//   * There is no `product_custom_label*` segment. Feed custom labels come back
//     as segments.product_custom_attribute0-4, so group_by names are mapped.
//   * Product type is levelled (product_type_l1..l5); `product_type` alone is
//     not a field. We group on l1, the level people actually merchandise on.
//
// MERCHANT CENTER (future integration point): everything below is Ads-side, so
// a product only appears once it has served. Feed attributes that only Merchant
// Center knows — full titles, GTIN/MPN, availability, price, and above all
// disapprovals/product status — require the Merchant Center Content API and the
// separate https://www.googleapis.com/auth/content OAuth scope. That would slot
// in here as a fetchMerchantProducts() joined to these rows on item_id. See
// README "Merchant Center (future)". Deliberately out of scope for this pass.
const SHOPPING_GROUP_DIMENSIONS = {
    item_id:        { field: "segments.product_item_id",           key: "productItemId" },
    title:          { field: "segments.product_title",             key: "productTitle" },
    product_type:   { field: "segments.product_type_l1",           key: "productTypeL1" },
    brand:          { field: "segments.product_brand",             key: "productBrand" },
    custom_label_0: { field: "segments.product_custom_attribute0", key: "productCustomAttribute0" },
    custom_label_1: { field: "segments.product_custom_attribute1", key: "productCustomAttribute1" },
    custom_label_2: { field: "segments.product_custom_attribute2", key: "productCustomAttribute2" },
    custom_label_3: { field: "segments.product_custom_attribute3", key: "productCustomAttribute3" },
    custom_label_4: { field: "segments.product_custom_attribute4", key: "productCustomAttribute4" },
};

// Row caps keep these reports inside a model context window. Anything that can
// return thousands of rows (products, search terms, listing nodes) must cap.
const TOP_N_MAX = 500;
function clampTopN(value, fallback) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, TOP_N_MAX);
}

const emptyAgg = () => ({ spend: 0, impressions: 0, clicks: 0, conversions: 0, conv_value: 0 });

function addAgg(agg, r) {
    agg.spend       += parseInt(r.metrics?.costMicros || 0) / 1_000_000;
    agg.impressions += parseInt(r.metrics?.impressions || 0);
    agg.clicks      += parseInt(r.metrics?.clicks || 0);
    agg.conversions += parseFloat(r.metrics?.conversions || 0);
    agg.conv_value  += parseFloat(r.metrics?.conversionsValue || 0);
}

function mergeAgg(target, src) {
    for (const k of Object.keys(target)) target[k] += src[k];
}

// Derived metrics are computed from the summed totals, never averaged from the
// API's per-row ctr/average_cpc — averaging those across rolled-up rows is wrong.
function shapeAgg(agg) {
    const { spend, impressions, clicks, conversions, conv_value } = agg;
    const cpa  = conversions > 0 ? Math.round((spend / conversions) * 100) / 100 : null;
    const roas = spend > 0 && conv_value > 0 ? Math.round((conv_value / spend) * 100) / 100 : null;
    return {
        spend:       Math.round(spend * 100) / 100,
        impressions,
        clicks,
        ctr:         impressions > 0 ? ((clicks / impressions) * 100).toFixed(2) + "%" : "0.00%",
        avg_cpc:     "$" + (clicks > 0 ? (spend / clicks).toFixed(2) : "0.00"),
        conversions: Math.round(conversions * 100) / 100,
        conv_value:  Math.round(conv_value * 100) / 100,
        cpa:         cpa != null ? "$" + cpa : null,
        roas,
    };
}

async function fetchShoppingPerformance(token, customerId, mccId, dateClause, groupBy, topN) {
    const dim = SHOPPING_GROUP_DIMENSIONS[groupBy];
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT ${dim.field},
               metrics.cost_micros, metrics.impressions, metrics.clicks,
               metrics.conversions, metrics.conversions_value
        FROM shopping_performance_view
        WHERE segments.date ${dateClause}`);

    // The API returns one row per combination of every selected segment, so the
    // same dimension value can appear more than once — roll up client-side.
    const byValue = new Map();
    const totals  = emptyAgg();
    for (const r of rows) {
        const value = r.segments?.[dim.key] ?? "(not set)";
        if (!byValue.has(value)) byValue.set(value, emptyAgg());
        addAgg(byValue.get(value), r);
        addAgg(totals, r);
    }

    const all = [...byValue.entries()]
        .map(([value, agg]) => ({ value, agg }))
        .sort((a, b) => b.agg.spend - a.agg.spend);

    const shown = all.slice(0, topN);
    const shownSpend = shown.reduce((s, x) => s + x.agg.spend, 0);

    return {
        rows: shown.map(({ value, agg }) => ({ [groupBy]: value, ...shapeAgg(agg) })),
        totals: {
            ...shapeAgg(totals),
            [`distinct_${groupBy}_values`]: all.length,
        },
        returned: {
            rows_returned:      shown.length,
            rows_total:         all.length,
            spend_returned:     Math.round(shownSpend * 100) / 100,
            share_of_spend:     totals.spend > 0 ? ((shownSpend / totals.spend) * 100).toFixed(1) + "%" : "0.0%",
            truncated:          all.length > shown.length,
        },
    };
}

// Campaign-level spend for the campaign types that can serve product ads, used
// to reconcile the product report against get_campaign_performance.
async function fetchProductServingCampaignSpend(token, customerId, mccId, dateClause) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT campaign.name, campaign.advertising_channel_type, metrics.cost_micros
        FROM campaign
        WHERE segments.date ${dateClause}
          AND campaign.advertising_channel_type IN ('SHOPPING', 'PERFORMANCE_MAX')`);
    const campaigns = new Map();
    let spend = 0;
    for (const r of rows) {
        const cost = parseInt(r.metrics?.costMicros || 0) / 1_000_000;
        const name = r.campaign.name;
        if (!campaigns.has(name)) campaigns.set(name, { campaign: name, type: r.campaign.advertisingChannelType, spend: 0 });
        campaigns.get(name).spend += cost;
        spend += cost;
    }
    return {
        spend,
        campaigns: [...campaigns.values()]
            .map(c => ({ ...c, spend: Math.round(c.spend * 100) / 100 }))
            .sort((a, b) => b.spend - a.spend),
    };
}

// ── PMax listing groups (product partitioning inside an asset group) ─────────
// Structure lives on asset_group_listing_group_filter; metrics are only exposed
// through asset_group_product_group_view, which joins back on the filter's
// resource name. Verified against the v24 resource definitions.
function listingCaseValueLabel(cv) {
    if (!cv) return null;   // root node — the whole inventory
    const val = v => (v === undefined || v === null || v === "" ? "(everything else)" : v);
    if (cv.productItemId)   return `item_id = ${val(cv.productItemId.value)}`;
    if (cv.productBrand)    return `brand = ${val(cv.productBrand.value)}`;
    if (cv.productType)     return `product_type_${(cv.productType.level || "LEVEL1").toLowerCase()} = ${val(cv.productType.value)}`;
    if (cv.productCategory) return `category_${(cv.productCategory.level || "LEVEL1").toLowerCase()} = ${val(cv.productCategory.categoryId)}`;
    if (cv.productCondition) return `condition = ${val(cv.productCondition.condition)}`;
    if (cv.productChannel)  return `channel = ${val(cv.productChannel.channel)}`;
    if (cv.productCustomAttribute) {
        // INDEX0..INDEX4 map to the feed's custom_label_0..4
        const idx = (cv.productCustomAttribute.index || "INDEX0").replace("INDEX", "");
        return `custom_label_${idx} = ${val(cv.productCustomAttribute.value)}`;
    }
    if (cv.webpage) return "webpage condition";
    return null;
}

async function fetchPmaxListingGroups(token, customerId, mccId, dateClause, topN) {
    const structRows = await googleSearch(token, customerId, mccId, `
        SELECT campaign.name, campaign.advertising_channel_type,
               asset_group.name, asset_group.id,
               asset_group_listing_group_filter.id,
               asset_group_listing_group_filter.type,
               asset_group_listing_group_filter.listing_source,
               asset_group_listing_group_filter.parent_listing_group_filter,
               asset_group_listing_group_filter.case_value.product_item_id.value,
               asset_group_listing_group_filter.case_value.product_brand.value,
               asset_group_listing_group_filter.case_value.product_type.value,
               asset_group_listing_group_filter.case_value.product_type.level,
               asset_group_listing_group_filter.case_value.product_category.category_id,
               asset_group_listing_group_filter.case_value.product_category.level,
               asset_group_listing_group_filter.case_value.product_condition.condition,
               asset_group_listing_group_filter.case_value.product_channel.channel,
               asset_group_listing_group_filter.case_value.product_custom_attribute.value,
               asset_group_listing_group_filter.case_value.product_custom_attribute.index
        FROM asset_group_listing_group_filter`);

    // Metrics are reported separately; if the view is unavailable we still
    // return the tree rather than failing the whole call.
    const metricsBy = new Map();
    let metricsError = null;
    try {
        const metricRows = await googleSearch(token, customerId, mccId, `
            SELECT asset_group_product_group_view.asset_group_listing_group_filter,
                   metrics.cost_micros, metrics.impressions, metrics.clicks,
                   metrics.conversions, metrics.conversions_value
            FROM asset_group_product_group_view
            WHERE segments.date ${dateClause}`);
        for (const r of metricRows) {
            const key = r.assetGroupProductGroupView?.assetGroupListingGroupFilter;
            if (!key) continue;
            if (!metricsBy.has(key)) metricsBy.set(key, emptyAgg());
            addAgg(metricsBy.get(key), r);
        }
    } catch (e) {
        metricsError = e.message;
    }

    // Group nodes by asset group, keeping only PMax (the resource is also used
    // by other channel types whose listing_source is WEBPAGE).
    const groups = new Map();
    for (const r of structRows) {
        if (r.campaign?.advertisingChannelType !== "PERFORMANCE_MAX") continue;
        const f   = r.assetGroupListingGroupFilter;
        const key = `${r.campaign.name}||${r.assetGroup.name}`;
        if (!groups.has(key)) {
            groups.set(key, { campaign: r.campaign.name, asset_group: r.assetGroup.name, nodes: [] });
        }
        groups.get(key).nodes.push({
            resource_name:  f.resourceName,
            id:             f.id,
            type:           f.type,
            listing_source: f.listingSource || null,
            parent:         f.parentListingGroupFilter || null,
            dimension:      listingCaseValueLabel(f.caseValue),
            agg:            metricsBy.get(f.resourceName) || null,
        });
    }

    const assetGroups = [];
    const rollup = emptyAgg();
    for (const g of groups.values()) {
        const byResource = new Map(g.nodes.map(n => [n.resource_name, n]));
        const depthOf = n => {
            let d = 0, cur = n;
            while (cur?.parent && byResource.has(cur.parent) && d < 20) { d++; cur = byResource.get(cur.parent); }
            return d;
        };
        const units = g.nodes.filter(n => n.type === "UNIT_INCLUDED" || n.type === "UNIT_EXCLUDED");
        // A single included unit hanging off the root with no dimension test means
        // the whole feed is one undifferentiated bucket — the thing worth spotting.
        const isCatchAll = units.length === 1 && units[0].type === "UNIT_INCLUDED" && !units[0].dimension;

        // Roll up leaf (unit) nodes only. Subdivisions report the aggregate of
        // their children, so summing every node would double-count.
        const groupAgg = emptyAgg();
        for (const n of units) if (n.agg) mergeAgg(groupAgg, n.agg);
        mergeAgg(rollup, groupAgg);

        const shaped = g.nodes
            .map(n => ({
                dimension:      n.dimension || (n.parent ? "(everything else)" : "(root — all products)"),
                type:           n.type,
                depth:          depthOf(n),
                listing_source: n.listing_source,
                ...(n.agg ? shapeAgg(n.agg) : {}),
                _spend:         n.agg ? n.agg.spend : 0,
            }))
            .sort((a, b) => b._spend - a._spend);
        const shown = shaped.slice(0, topN).map(({ _spend, ...rest }) => rest);

        assetGroups.push({
            campaign:        g.campaign,
            asset_group:     g.asset_group,
            _spend:          groupAgg.spend,
            ...(metricsError ? {} : { asset_group_totals: shapeAgg(groupAgg) }),
            total_nodes:     g.nodes.length,
            subdivisions:    g.nodes.filter(n => n.type === "SUBDIVISION").length,
            units_included:  g.nodes.filter(n => n.type === "UNIT_INCLUDED").length,
            units_excluded:  g.nodes.filter(n => n.type === "UNIT_EXCLUDED").length,
            max_depth:       g.nodes.reduce((m, n) => Math.max(m, depthOf(n)), 0),
            is_single_catch_all: isCatchAll,
            partitioning:    isCatchAll
                ? "Single catch-all node — all products are in one bucket, so bidding and reporting cannot separate them."
                : `Partitioned into ${units.length} unit node(s).`,
            nodes_returned:  shown.length,
            nodes_truncated: shaped.length > shown.length,
            nodes:           shown,
        });
    }

    assetGroups.sort((a, b) => b._spend - a._spend);
    for (const g of assetGroups) delete g._spend;

    const out = {
        total_asset_groups: assetGroups.length,
        catch_all_asset_groups: assetGroups.filter(g => g.is_single_catch_all).length,
        metrics_available: !metricsError,
        totals: shapeAgg(rollup),
        asset_groups: assetGroups,
    };
    if (metricsError) {
        out.metrics_note = `Listing group metrics unavailable in Google Ads API ${GOOGLE_API_VERSION} for this account — returning structure only. Reason: ${metricsError}`;
        delete out.totals;
    }
    if (!assetGroups.length) {
        out.note = "No Performance Max listing groups found. The account may not run PMax, or its asset groups have no product feed attached (listing groups only exist on retail asset groups).";
    }
    return out;
}

// ── PMax asset groups ─────────────────────────────────────────────────────────
async function fetchPmaxAssetGroups(token, customerId, mccId, dateClause) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT campaign.name, asset_group.name, asset_group.status,
               asset_group.primary_status,
               metrics.cost_micros, metrics.impressions, metrics.clicks,
               metrics.conversions, metrics.conversions_value
        FROM asset_group
        WHERE segments.date ${dateClause}
        ORDER BY metrics.cost_micros DESC`);
    return rows.map(r => {
        const spend   = parseInt(r.metrics?.costMicros || 0) / 1_000_000;
        const convs   = parseFloat(r.metrics?.conversions || 0);
        const convVal = parseFloat(r.metrics?.conversionsValue || 0);
        return {
            campaign:       r.campaign.name,
            asset_group:    r.assetGroup.name,
            status:         r.assetGroup.status,
            primary_status: r.assetGroup.primaryStatus || null,
            spend:          Math.round(spend * 100) / 100,
            impressions:    parseInt(r.metrics?.impressions || 0),
            clicks:         parseInt(r.metrics?.clicks || 0),
            conversions:    convs,
            conv_value:     Math.round(convVal * 100) / 100,
            cpa:            convs > 0 ? "$" + (Math.round((spend / convs) * 100) / 100) : null,
            roas:           spend > 0 && convVal > 0 ? Math.round((convVal / spend) * 100) / 100 : null,
        };
    });
}

// asset_group_asset has no performance_label field — Google removed aggregate
// asset performance labels for asset groups, and in v24 performance_label only
// survives on ad_group_ad_asset_view (Search/Display RSAs), which PMax asset
// groups do not report into. Verified against the v24 resource definitions.
//
// What the API does still expose per linked asset is its *serving* health:
// primary_status (+ reasons) and the policy approval status. That covers the
// question this flag was really for — which assets are held back — so we
// return those instead of a label that no longer exists.
async function fetchPmaxAssetPerformance(token, customerId, mccId, limit = 500) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT campaign.name, asset_group.name,
               asset_group_asset.field_type, asset_group_asset.status,
               asset_group_asset.primary_status,
               asset_group_asset.primary_status_reasons,
               asset_group_asset.policy_summary.approval_status,
               asset.type, asset.text_asset.text, asset.name
        FROM asset_group_asset
        WHERE asset_group_asset.status = 'ENABLED'
          AND campaign.status = 'ENABLED'
        LIMIT ${limit}`);
    return rows.map(r => ({
        campaign:        r.campaign.name,
        asset_group:     r.assetGroup.name,
        field_type:      r.assetGroupAsset.fieldType,
        primary_status:  r.assetGroupAsset.primaryStatus || null,
        status_reasons:  r.assetGroupAsset.primaryStatusReasons || [],
        approval_status: r.assetGroupAsset.policySummary?.approvalStatus || null,
        asset:           r.asset?.textAsset?.text || r.asset?.name || r.asset?.type || null,
    }));
}

// ── Performance breakdowns (geo / device / hour / day_of_week / date) ────────
const BREAKDOWN_SEGMENTS = {
    device:      "segments.device",
    hour:        "segments.hour",
    day_of_week: "segments.day_of_week",
    date:        "segments.date",
};

async function fetchPerformanceBreakdown(token, customerId, mccId, segment, dateClause, campaignSearch) {
    const isGeo    = segment === "geo" || segment === "geo_city";
    const segField = segment === "geo"      ? "segments.geo_target_state"
                   : segment === "geo_city" ? "segments.geo_target_city"
                   : BREAKDOWN_SEGMENTS[segment];
    // LOCATION_OF_PRESENCE = where the user physically was; mixing in
    // AREA_OF_INTEREST rows would double-count spend.
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT ${segField}, campaign.name,
               metrics.cost_micros, metrics.impressions, metrics.clicks,
               metrics.conversions, metrics.conversions_value
        FROM ${isGeo ? "geographic_view" : "campaign"}
        WHERE segments.date ${dateClause}
          AND metrics.impressions > 0
          ${isGeo ? "AND geographic_view.location_type = 'LOCATION_OF_PRESENCE'" : ""}`);

    const byKey = {};
    for (const r of rows) {
        if (campaignSearch && !r.campaign.name.toLowerCase().includes(campaignSearch.toLowerCase())) continue;
        let key;
        if (isGeo)                          key = r.segments?.geoTargetState || r.segments?.geoTargetCity || "unknown";
        else if (segment === "device")      key = r.segments?.device;
        else if (segment === "hour")        key = String(r.segments?.hour);
        else if (segment === "day_of_week") key = r.segments?.dayOfWeek;
        else                                key = r.segments?.date;
        if (!byKey[key]) byKey[key] = { spend: 0, impressions: 0, clicks: 0, conversions: 0, conv_value: 0 };
        const b = byKey[key];
        b.spend       += parseInt(r.metrics?.costMicros || 0) / 1_000_000;
        b.impressions += parseInt(r.metrics?.impressions || 0);
        b.clicks      += parseInt(r.metrics?.clicks || 0);
        b.conversions += parseFloat(r.metrics?.conversions || 0);
        b.conv_value  += parseFloat(r.metrics?.conversionsValue || 0);
    }

    // Resolve geoTargetConstants/NNN resource names to readable state names
    const names = {};
    if (isGeo) {
        const ids = Object.keys(byKey).filter(k => k.startsWith("geoTargetConstants/"));
        if (ids.length) {
            try {
                const geoRows = await googleSearch(token, customerId, mccId, `
                    SELECT geo_target_constant.resource_name, geo_target_constant.name
                    FROM geo_target_constant
                    WHERE geo_target_constant.resource_name IN (${ids.map(i => `'${i}'`).join(", ")})`);
                for (const g of geoRows) names[g.geoTargetConstant.resourceName] = g.geoTargetConstant.name;
            } catch (_) { /* fall back to raw resource names */ }
        }
    }

    const out = Object.entries(byKey).map(([key, b]) => ({
        [segment]:   isGeo ? (names[key] || key) : key,
        spend:       Math.round(b.spend * 100) / 100,
        impressions: b.impressions,
        clicks:      b.clicks,
        ctr:         b.impressions > 0 ? (b.clicks / b.impressions * 100).toFixed(2) + "%" : "0%",
        avg_cpc:     b.clicks > 0 ? "$" + (b.spend / b.clicks).toFixed(2) : null,
        conversions: Math.round(b.conversions * 10) / 10,
        conv_value:  Math.round(b.conv_value * 100) / 100,
        cpa:         b.conversions > 0 ? "$" + (Math.round((b.spend / b.conversions) * 100) / 100) : null,
    }));

    // Sensible ordering: hours/dates/weekdays in natural order, otherwise by spend
    if (segment === "hour")             out.sort((a, b) => parseInt(a.hour) - parseInt(b.hour));
    else if (segment === "date")        out.sort((a, b) => a.date.localeCompare(b.date));
    else if (segment === "day_of_week") {
        const order = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
        out.sort((a, b) => order.indexOf(a.day_of_week) - order.indexOf(b.day_of_week));
    }
    else out.sort((a, b) => b.spend - a.spend);
    return out;
}

// ── Ad-group negatives + shared negative keyword lists ───────────────────────
async function mutateAdGroupNegatives(token, customerId, mccId, adGroupResourceName, keywords, matchType) {
    return googleMutateOps(token, customerId, mccId, keywords.map(kw => ({
        adGroupCriterionOperation: {
            create: {
                adGroup:  adGroupResourceName,
                negative: true,
                keyword:  { text: kw.replace(/^["']|["']$/g, ""), matchType },
            },
        },
    })));
}

async function listSharedNegativeLists(token, customerId, mccId) {
    const [sets, links] = await Promise.all([
        googleSearch(token, customerId, mccId, `
            SELECT shared_set.resource_name, shared_set.id, shared_set.name,
                   shared_set.member_count, shared_set.status
            FROM shared_set
            WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status != 'REMOVED'`),
        googleSearch(token, customerId, mccId, `
            SELECT campaign.name, campaign_shared_set.shared_set
            FROM campaign_shared_set
            WHERE campaign_shared_set.status != 'REMOVED'`).catch(() => []),
    ]);
    const attached = {};
    for (const l of links) {
        const key = l.campaignSharedSet.sharedSet;
        (attached[key] = attached[key] || []).push(l.campaign.name);
    }
    return sets.map(r => ({
        resource_name:      r.sharedSet.resourceName,
        id:                 r.sharedSet.id,
        name:               r.sharedSet.name,
        keyword_count:      parseInt(r.sharedSet.memberCount || 0),
        status:             r.sharedSet.status,
        attached_campaigns: attached[r.sharedSet.resourceName] || [],
    }));
}

async function viewSharedNegativeList(token, customerId, mccId, sharedSetResource) {
    const rows = await googleSearch(token, customerId, mccId, `
        SELECT shared_criterion.keyword.text, shared_criterion.keyword.match_type
        FROM shared_criterion
        WHERE shared_criterion.shared_set = '${sharedSetResource}'
          AND shared_criterion.type = 'KEYWORD'`);
    return rows.map(r => ({ text: r.sharedCriterion.keyword.text, match_type: r.sharedCriterion.keyword.matchType }));
}

// ── MCP Server ────────────────────────────────────────────────────────────────
// makeServer() builds a fresh Server instance with both handlers registered.
// stdio mode and SSE mode share one module-level instance; the stateless
// Streamable HTTP transport (see main()) gets a fresh instance per request.
function makeServer() {
    const srv = new Server(
        { name: "kaycomm-pacing", version: "2.0.0" },
        { capabilities: { tools: {} } }
    );

    srv.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "get_google_pacing",
            description: "Pull Google Ads MTD spend and pacing for all client accounts, including Boulevard Carroll NC/non-NC breakdown. " +
                "Each account includes a daily_budget block comparing current enabled daily budgets to the per-day spend needed to land on budget, with a RAISE/LOWER/ON_TRACK recommendation.",
            inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
            name: "get_meta_pacing",
            description: "Pull Meta Ads MTD spend and pacing for all client accounts. " +
                "Each account includes a daily_budget block comparing current active daily budgets (CBO + ABO) to the per-day spend needed to land on budget, with a RAISE/LOWER/ON_TRACK recommendation.",
            inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
            name: "get_full_pacing",
            description: "Pull Google Ads AND Meta (and StackAdapt and LinkedIn) MTD spend and pacing for all accounts in one report. " +
                "Google and Meta rows include a daily_budget block: current daily budgets vs needed per day, with a RAISE/LOWER/ON_TRACK recommendation.",
            inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
            name: "get_account_detail",
            description: "Get MTD spend detail across Google, Meta, StackAdapt, and LinkedIn for a specific client by name.",
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
            description: "Analyze Google Ads search term performance for an account — wasted spend, converting terms, campaign breakdown. Use to find negative keyword opportunities. " +
                "Set summary_only=true (or a low limit) to keep the response small when you just need wasted/converting terms.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    date_range: {
                        type: "string",
                        description: "THIS_MONTH (default), LAST_7_DAYS, LAST_30_DAYS, LAST_90_DAYS, LAST_MONTH, YEAR_TO_DATE, or CUSTOM (requires start_date + end_date)",
                        enum: ["THIS_MONTH", "LAST_7_DAYS", "LAST_30_DAYS", "LAST_90_DAYS", "LAST_MONTH", "YEAR_TO_DATE", "CUSTOM"],
                    },
                    start_date:   { type: "string", description: "Start date YYYY-MM-DD (only with CUSTOM)" },
                    end_date:     { type: "string", description: "End date YYYY-MM-DD (only with CUSTOM)" },
                    limit:        { type: "number", description: "Max terms in all_terms, by spend (default: 100)" },
                    summary_only: { type: "boolean", description: "Omit all_terms entirely — return only wasted, converting, and campaign totals (default: false)" },
                },
                required: ["account_name"],
            },
        },
        {
            name: "get_pmax_search_terms",
            description: "Pull Performance Max search terms via campaign_search_term_view, plus DSA/catch-all terms running alongside PMax. PMax section shows queries triggering PMax campaigns with impressions, clicks, spend, conversions. DSA section shows dynamic and branded catch-all queries. Useful for understanding PMax query coverage and finding keyword migration opportunities. Term lists are capped by top_n and sorted by spend; totals and wasted-spend rollups always cover every term.",
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
                    top_n:      { type: "integer", description: "Max terms per list (top/wasted/converting), sorted by spend descending (default 50, max 500). Totals always cover every term." },
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
            description: "Pull full campaign-level performance metrics — spend, clicks, impressions, CTR, CPC, conversions, CPA, ROAS — for Google Ads, Meta, and/or StackAdapt accounts. Supports YTD and custom date ranges.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    platform: {
                        type: "string",
                        description: "google (default), meta, stackadapt, or both (both = google + meta + stackadapt where tracked)",
                        enum: ["google", "meta", "stackadapt", "both"],
                    },
                    date_range: {
                        type: "string",
                        description: "THIS_MONTH (default), LAST_7_DAYS, LAST_30_DAYS, LAST_90_DAYS, LAST_MONTH, YEAR_TO_DATE, or CUSTOM (requires start_date + end_date)",
                        enum: ["THIS_MONTH", "LAST_7_DAYS", "LAST_30_DAYS", "LAST_90_DAYS", "LAST_MONTH", "YEAR_TO_DATE", "CUSTOM"],
                    },
                    start_date: { type: "string", description: "Start date YYYY-MM-DD (only with CUSTOM)" },
                    end_date:   { type: "string", description: "End date YYYY-MM-DD (only with CUSTOM)" },
                    segment_by: {
                        type: "string",
                        description: "Optional segmentation. 'conversion_action' breaks out conversions and conv_value by individual conversion action per campaign (Google only).",
                        enum: ["conversion_action"],
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
            description: "View and manage Meta Ads campaigns, ad sets, and ads — list, pause, resume, archive, update budgets, or duplicate. " +
                "Dry run by default. Set confirm=true to apply changes. " +
                "Actions: list_campaigns, list_adsets, list_ads, get_creative_details, pause, resume, archive, set_daily_budget, duplicate.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Meta account name (partial match ok)" },
                    action: {
                        type: "string",
                        description: "list_campaigns | list_adsets | list_ads | get_creative_details | pause | resume | archive | set_daily_budget | duplicate",
                        enum: ["list_campaigns", "list_adsets", "list_ads", "get_creative_details", "pause", "resume", "archive", "set_daily_budget", "duplicate"],
                    },
                    target: { type: "string", description: "Campaign, ad set, or ad name to target (partial match ok). Required for pause/resume/archive/set_daily_budget/duplicate." },
                    level: {
                        type: "string",
                        description: "Whether target is a campaign, adset, or ad (default: campaign for duplicate, adset for others)",
                        enum: ["campaign", "adset", "ad"],
                    },
                    new_name: { type: "string", description: "Name for the duplicated campaign or ad set. Optional for duplicate — defaults to 'Copy of [original name]'." },
                    status:   { type: "string", enum: ["PAUSED", "ACTIVE", "INHERITED_FROM_SOURCE"], description: "Status for the duplicate (default: PAUSED)." },
                    start_time:      { type: "string", description: "duplicate (campaign level) only: ISO 8601 start time for the copy (e.g. '2026-09-01T00:00:00-0600'). Omit to inherit from source." },
                    stop_time:       { type: "string", description: "duplicate (campaign level) only: ISO 8601 end time for the copy. Omit to inherit from source." },
                    daily_budget:    { type: "number", description: "duplicate (campaign level) only: daily budget in dollars for the copy. Omit to inherit from source." },
                    lifetime_budget: { type: "number", description: "duplicate (campaign level) only: lifetime budget in dollars for the copy. Omit to inherit from source." },
                    budget: { type: "number", description: "New daily budget in dollars. Required for set_daily_budget." },
                    creative_ids: { type: "array", items: { type: "string" }, description: "Array of creative IDs to fetch details for. Required for get_creative_details." },
                    confirm: { type: "boolean", description: "Set true to apply changes. Omit for dry-run preview." },
                },
                required: ["account_name", "action"],
            },
        },
        {
            name: "list_campaigns",
            description: "List all campaigns and their status, daily budget, and month-to-date spend for a client. Works on Google and/or Meta. Use before pause/enable/update_budget to find exact campaign names. Google spend (mtd_spend_incl_today) runs the 1st through today and includes today's partial day — get_full_pacing stops at yesterday, so the two will not match. Use get_full_pacing for pacing decisions.",
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
                    geo_target:      { type: "string", description: "Optional geo target for local/regional data. Pass a US city+state (e.g. 'Mesa, AZ') or a raw resource name (e.g. 'geoTargetConstants/1014044'). Omit for national-level data." },
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
                    geo_target:    { type: "string", description: "Optional geo target for local/regional data. Pass a US city+state (e.g. 'Mesa, AZ') or a raw resource name (e.g. 'geoTargetConstants/1014044'). Omit for national-level data." },
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
            name: "pause_ad_group",
            description: "Pause a Google Ads ad group. Dry run by default — set confirm=true to apply. Ad group names can repeat across campaigns, so pass campaign_name to disambiguate. Use list_ad_groups first to confirm the exact name.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:  { type: "string", description: "Client name (partial match ok)" },
                    ad_group_name: { type: "string", description: "Ad group name (partial match ok)" },
                    campaign_name: { type: "string", description: "Campaign to scope the match to (partial match ok). Recommended when ad group names repeat across campaigns." },
                    confirm:       { type: "boolean", description: "Set true to actually pause. Omit for dry run." },
                },
                required: ["account_name", "ad_group_name"],
            },
        },
        {
            name: "enable_ad_group",
            description: "Re-enable a paused Google Ads ad group. Dry run by default — set confirm=true to apply.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:  { type: "string", description: "Client name (partial match ok)" },
                    ad_group_name: { type: "string", description: "Ad group name (partial match ok)" },
                    campaign_name: { type: "string", description: "Campaign to scope the match to (partial match ok)." },
                    confirm:       { type: "boolean", description: "Set true to actually enable. Omit for dry run." },
                },
                required: ["account_name", "ad_group_name"],
            },
        },
        {
            name: "pause_keyword",
            description: "Pause a Google Ads keyword. Dry run by default — set confirm=true to apply. Matches on keyword text (exact text preferred, substring fallback); the same text often exists in multiple ad groups or match types, so pass campaign_name / ad_group_name / match_type to narrow, or all_matches=true to pause every match at once.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:  { type: "string", description: "Client name (partial match ok)" },
                    keyword_text:  { type: "string", description: "Keyword text to pause (e.g. 'childhood speech')" },
                    campaign_name: { type: "string", description: "Campaign to scope the match to (partial match ok)" },
                    ad_group_name: { type: "string", description: "Ad group to scope the match to (partial match ok)" },
                    match_type:    { type: "string", enum: ["EXACT", "PHRASE", "BROAD"], description: "Only match this match type" },
                    all_matches:   { type: "boolean", description: "Set true to pause every matching keyword when more than one matches (e.g. same text across match types)" },
                    confirm:       { type: "boolean", description: "Set true to actually pause. Omit for dry run." },
                },
                required: ["account_name", "keyword_text"],
            },
        },
        {
            name: "enable_keyword",
            description: "Re-enable a paused Google Ads keyword. Dry run by default — set confirm=true to apply. Same matching rules as pause_keyword.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:  { type: "string", description: "Client name (partial match ok)" },
                    keyword_text:  { type: "string", description: "Keyword text to enable" },
                    campaign_name: { type: "string", description: "Campaign to scope the match to (partial match ok)" },
                    ad_group_name: { type: "string", description: "Ad group to scope the match to (partial match ok)" },
                    match_type:    { type: "string", enum: ["EXACT", "PHRASE", "BROAD"], description: "Only match this match type" },
                    all_matches:   { type: "boolean", description: "Set true to enable every matching keyword when more than one matches" },
                    confirm:       { type: "boolean", description: "Set true to actually enable. Omit for dry run." },
                },
                required: ["account_name", "keyword_text"],
            },
        },
        {
            name: "find_keywords",
            description: "Search the full keyword inventory for a Google Ads account — including keywords in paused/removed campaigns and keywords that never served. Unlike get_keyword_performance (which only returns keywords with metrics), this queries ad_group_criterion directly and returns every keyword that exists or existed.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:    { type: "string", description: "Client name (partial match ok)" },
                    keyword_text:    { type: "string", description: "Substring to search for (case insensitive). Omit to return all keywords." },
                    campaign_name:   { type: "string", description: "Filter to campaigns matching this substring (partial match ok)" },
                    ad_group_name:   { type: "string", description: "Filter to ad groups matching this substring (partial match ok)" },
                    include_removed: { type: "boolean", description: "Include removed keywords, ad groups, and campaigns (default true)" },
                    match_type:      { type: "string", enum: ["EXACT", "PHRASE", "BROAD"], description: "Only return this match type" },
                    status:          { type: "string", enum: ["ENABLED", "PAUSED", "REMOVED"], description: "Only return keywords with this criterion status" },
                },
                required: ["account_name"],
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
            name: "get_call_tracking",
            description: "Diagnose call tracking setup for a Google Ads account — checks whether call assets are attached to campaigns (campaign-level and account-level), " +
                "lists all call-related conversion actions (AD_CALL, WEBSITE_CALL) with minimum call duration and 30d/7d volume, " +
                "flags duplicates (multiple primary actions of the same type), and identifies campaigns with no call asset coverage. " +
                "Use when call conversions are zero or suspiciously low.",
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
            description: "Scan all accounts for spend anomalies — yesterday's spend vs trailing 7-day average (spikes ≥ +75%, drops ≤ -60%) on Google, Meta, and StackAdapt, plus enabled Google campaigns that served zero impressions yesterday.",
            inputSchema: {
                type: "object",
                properties: {
                    platform: { type: "string", enum: ["google", "meta", "stackadapt", "both"], description: "Platform to scan (default: both)" },
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
            description: "List, add, update, or remove tracked client accounts (Google Ads, Meta, StackAdapt, LinkedIn) without code changes. " +
                "Also manages per-account health-check thresholds via the health field (run_health_check monitors every account by default; set health=false to exclude one). " +
                "Writes to accounts.json. Dry run by default — set confirm=true to save. " +
                "After saving, commit accounts.json to git so Railway picks up the change.",
            inputSchema: {
                type: "object",
                properties: {
                    action:   { type: "string", enum: ["list", "add", "update", "remove"], description: "What to do (default: list)" },
                    platform: { type: "string", enum: ["google", "meta", "stackadapt", "linkedin"], description: "Which platform the account belongs to. Required for add/update/remove." },
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
                    health: {
                        description: "Health-check threshold overrides for run_health_check, e.g. {cpa_target: 75, conversion_dry_spell_hours: 48, impression_share_floor: 50, frequency_cap: 3.0, pacing_tolerance_pct: 10}. " +
                            "Pass false to exclude the account from health checks entirely. Omit to monitor with health_defaults.",
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
            description: "Pull daily and lifetime budgets for all campaigns across all tracked Google Ads and Meta accounts. Shows which campaigns use daily vs lifetime budgets and current amounts. Google spend (mtd_spend_incl_today) runs the 1st through today and includes today's partial day, unlike get_full_pacing, which stops at yesterday.",
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
            description: "Change the bidding strategy on a Google Ads campaign. Supports MANUAL_CPC, ENHANCED_CPC, MAXIMIZE_CLICKS, MAXIMIZE_CONVERSIONS, MAXIMIZE_CONVERSION_VALUE, TARGET_CPA, TARGET_ROAS. Dry run by default — set confirm=true to apply.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:     { type: "string", description: "Client name (partial match ok)" },
                    campaign_name:    { type: "string", description: "Campaign name (partial match ok)" },
                    strategy:         { type: "string", enum: ["MANUAL_CPC","ENHANCED_CPC","MAXIMIZE_CLICKS","MAXIMIZE_CONVERSIONS","MAXIMIZE_CONVERSION_VALUE","TARGET_CPA","TARGET_ROAS"], description: "Bidding strategy to apply" },
                    target_cpa:       { type: "number", description: "Target CPA in dollars — required for TARGET_CPA, optional for MAXIMIZE_CONVERSIONS (sets a tCPA target without changing strategy type)" },
                    target_roas:      { type: "number", description: "Target ROAS as a multiplier — required for TARGET_ROAS, optional for MAXIMIZE_CONVERSION_VALUE (adds a tROAS target without switching strategy)" },
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
                    bidding_strategy:  { type: "string", enum: ["MANUAL_CPC","MAXIMIZE_CLICKS","MAXIMIZE_CONVERSIONS"], description: "Bidding strategy (default: MANUAL_CPC). For TARGET_CPA/TARGET_ROAS, create with MAXIMIZE_CONVERSIONS then switch via set_bidding_strategy." },
                    geo_targets: {
                        type: "array",
                        description: "Geo target location IDs (required). Common: 2840=US, 2826=UK, 2124=Canada, 2036=Australia. Use keyword_research or Google's geo target docs for other IDs.",
                        items: { type: "integer" },
                    },
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
                required: ["account_name", "campaign_name", "daily_budget", "ad_groups", "geo_targets"],
            },
        },
        {
            name: "list_account_assets",
            description: "List creative assets (images, text, YouTube videos) already uploaded to a Google Ads account. " +
                "Use to find existing asset resource names for create_pmax_campaign. " +
                "Filter by type: IMAGE, TEXT, YOUTUBE_VIDEO.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    asset_types: {
                        type: "array",
                        description: "Filter to specific types (default: all). Options: IMAGE, TEXT, YOUTUBE_VIDEO.",
                        items: { type: "string", enum: ["IMAGE", "TEXT", "YOUTUBE_VIDEO"] },
                    },
                },
                required: ["account_name"],
            },
        },
        {
            name: "create_pmax_campaign",
            description: "Create a Performance Max campaign with asset group, text assets, and links to existing image/video assets. " +
                "Campaign is created in PAUSED status for review. " +
                "Use list_account_assets to find existing image/logo resource names first. " +
                "Dry run by default — set confirm=true to build it. " +
                "Minimum: 3 headlines (30 char), 1 long headline (90 char), 2 descriptions (90 char), " +
                "1 marketing image (landscape 1.91:1), 1 square marketing image, " +
                "1 business name asset, 1 logo asset.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:      { type: "string", description: "Client name (partial match ok)" },
                    campaign_name:     { type: "string", description: "Name for the new campaign" },
                    daily_budget:      { type: "number", description: "Daily budget in dollars" },
                    bidding_strategy:  { type: "string", enum: ["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"], description: "Bidding strategy (default: MAXIMIZE_CONVERSIONS)" },
                    final_url:         { type: "string", description: "Final URL / landing page for the asset group" },
                    geo_targets: {
                        type: "array",
                        description: "Geo target location IDs (required). Common: 2840=US, 2826=UK, 2124=Canada.",
                        items: { type: "integer" },
                    },
                    business_name_asset: { type: "string", description: "Resource name of an existing text asset to use as business name (from list_account_assets)" },
                    logo_asset:          { type: "string", description: "Resource name of an existing image asset to use as campaign logo (from list_account_assets)" },
                    asset_group_name:    { type: "string", description: "Name for the asset group (defaults to campaign name)" },
                    headlines: {
                        type: "array",
                        description: "3–15 headlines, each up to 30 characters",
                        items: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
                    },
                    long_headlines: {
                        type: "array",
                        description: "1–5 long headlines, each up to 90 characters",
                        items: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
                    },
                    descriptions: {
                        type: "array",
                        description: "2–5 descriptions, each up to 90 characters",
                        items: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
                    },
                    marketing_images: {
                        type: "array",
                        description: "Resource names of existing landscape (1.91:1) image assets",
                        items: { type: "string" },
                    },
                    square_marketing_images: {
                        type: "array",
                        description: "Resource names of existing square (1:1) image assets",
                        items: { type: "string" },
                    },
                    logo_assets: {
                        type: "array",
                        description: "Additional logo asset resource names to link to the asset group (optional)",
                        items: { type: "string" },
                    },
                    youtube_videos: {
                        type: "array",
                        description: "Resource names of existing YouTube video assets (optional)",
                        items: { type: "string" },
                    },
                    confirm: { type: "boolean", description: "Set true to actually create. Omit for dry run." },
                },
                required: ["account_name", "campaign_name", "daily_budget", "final_url", "geo_targets",
                           "business_name_asset", "logo_asset", "headlines", "long_headlines", "descriptions",
                           "marketing_images", "square_marketing_images"],
            },
        },
        {
            name: "create_video_campaign",
            description: "Create a YouTube / Video campaign with skippable in-stream ads. " +
                "Campaign is created in PAUSED status for review. " +
                "Use list_account_assets with asset_types=['YOUTUBE_VIDEO'] to find existing video assets first. " +
                "Dry run by default — set confirm=true to build it.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:     { type: "string", description: "Client name (partial match ok)" },
                    campaign_name:    { type: "string", description: "Name for the new campaign" },
                    daily_budget:     { type: "number", description: "Daily budget in dollars" },
                    bidding_strategy: { type: "string", enum: ["TARGET_CPV", "MAXIMIZE_CONVERSIONS", "TARGET_CPM"], description: "Bidding strategy (default: TARGET_CPV). Use TARGET_CPV for views, MAXIMIZE_CONVERSIONS for action-oriented, TARGET_CPM for reach." },
                    final_url:        { type: "string", description: "Landing page URL for the video ads" },
                    geo_targets: {
                        type: "array",
                        description: "Geo target location IDs (required). Common: 2840=US, 2826=UK, 2124=Canada.",
                        items: { type: "integer" },
                    },
                    ad_groups: {
                        type: "array",
                        description: "Ad groups to create, each with a YouTube video ad",
                        items: {
                            type: "object",
                            properties: {
                                name:            { type: "string", description: "Ad group name" },
                                youtube_video:   { type: "string", description: "Single YouTube video URL, video ID, or asset resource name (use youtube_videos for multiple)" },
                                youtube_videos:  {
                                    type: "array",
                                    description: "Multiple videos — one ad per entry. Each entry is a string (URL/ID) or object {url, final_url, ad_name} for per-ad landing pages.",
                                    items: {
                                        oneOf: [
                                            { type: "string" },
                                            { type: "object", properties: {
                                                url:       { type: "string", description: "YouTube video URL, ID, or asset resource name" },
                                                final_url: { type: "string", description: "Landing page for this specific ad (overrides campaign final_url)" },
                                                ad_name:   { type: "string", description: "Name for this ad" },
                                            }, required: ["url"] },
                                        ],
                                    },
                                },
                                headline:        { type: "string", description: "CTA headline shown with the ad (max 15 chars, defaults to campaign name)" },
                                call_to_action:  { type: "string", description: "CTA button text, e.g. 'Learn More', 'Shop Now', 'Sign Up' (max 10 chars, default: 'Learn More')" },
                                ad_name:         { type: "string", description: "Name for the ad (defaults to '<ad group name> - Video Ad')" },
                            },
                            required: ["name", "youtube_video"],
                        },
                    },
                    confirm: { type: "boolean", description: "Set true to actually create. Omit for dry run." },
                },
                required: ["account_name", "campaign_name", "daily_budget", "final_url", "geo_targets", "ad_groups"],
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
                    account_name:     { type: "string", description: "Client name (partial match ok)" },
                    campaign_name:    { type: "string", description: "Campaign name (partial match ok)" },
                    ad_group_name:    { type: "string", description: "Ad group name (exact match preferred, falls back to substring). Omit to search entire campaign." },
                    ad_resource_name: { type: "string", description: "Ad resource name (e.g. customers/123/ads/456). If provided, bypasses name matching entirely." },
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
            name: "update_ad_url",
            description: "View or update the Final URL on responsive search ads in a Google Ads campaign. " +
                "Omit final_url to preview current URLs. Provide a new URL to update. " +
                "Dry run by default — set confirm=true to apply.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:     { type: "string", description: "Client name (partial match ok)" },
                    campaign_name:    { type: "string", description: "Campaign name (partial match ok)" },
                    ad_group_name:    { type: "string", description: "Ad group name (exact match preferred, falls back to substring). Omit to search entire campaign." },
                    ad_resource_name: { type: "string", description: "Ad resource name (e.g. customers/123/ads/456). If provided, bypasses name matching entirely." },
                    final_url:        { type: "string", description: "New Final URL to set on the ad(s)" },
                    confirm:       { type: "boolean", description: "Set true to apply. Omit for dry run / preview." },
                },
                required: ["account_name", "campaign_name"],
            },
        },
        {
            name: "update_geo_targeting",
            description: "View or update the geo (location) targeting on a Google Ads campaign. " +
                "Omit add/remove to preview current targets. " +
                "Pass add and/or remove arrays to change targeting. " +
                "Accepts geo target constant IDs (e.g. 2840 for US) or location names (e.g. 'Mesa, AZ'). " +
                "Dry run by default — set confirm=true to apply.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:  { type: "string", description: "Client name (partial match ok)" },
                    campaign_name: { type: "string", description: "Campaign name (partial match ok)" },
                    add: {
                        type: "array",
                        items: { type: "string" },
                        description: "Geo targets to add — IDs (e.g. '2840') or names (e.g. 'Mesa, AZ', 'Arizona')",
                    },
                    remove: {
                        type: "array",
                        items: { type: "string" },
                        description: "Geo targets to remove — IDs (e.g. '2840'), names, or criterion resource names from the current list",
                    },
                    confirm: { type: "boolean", description: "Set true to apply. Omit for dry run / preview." },
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
            description: "Add negative keywords to a Google Ads campaign (default) or a specific ad group (level=ad_group). " +
                "For negatives shared across campaigns, use manage_negative_lists instead. " +
                "By default runs as a DRY RUN (preview only). Set confirm=true to actually write to the account. " +
                "If campaign_name is omitted, returns a list of available campaigns to choose from.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    campaign_name: { type: "string", description: "Campaign name (partial match ok). Omit to list campaigns." },
                    level: { type: "string", enum: ["campaign", "ad_group"], description: "Where to add the negatives (default: campaign)" },
                    ad_group_name: { type: "string", description: "Ad group name (partial match ok). Required when level=ad_group." },
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
            description: "Duplicate a Meta campaign (copies campaign, ad sets, and ads individually to avoid Meta's 3-object limit). " +
                "Designed for monthly campaign cloning — e.g. copying NSW's campaign at the start of each month. " +
                "Dry run by default — set confirm=true to apply.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:     { type: "string", description: "Meta account name (partial match ok)" },
                    source_campaign:  { type: "string", description: "Name of the campaign to duplicate (partial match ok)" },
                    new_name:         { type: "string", description: "Exact name for the new campaign. Defaults to 'Copy of [original name]'." },
                    status:           { type: "string", enum: ["PAUSED", "ACTIVE", "INHERITED_FROM_SOURCE"], description: "Status for the copy (default: PAUSED)" },
                    start_time:       { type: "string", description: "ISO 8601 start time for the new campaign (e.g. '2026-09-01T00:00:00-0600'). Omit to inherit from source." },
                    stop_time:        { type: "string", description: "ISO 8601 end time for the new campaign. Omit to inherit from source." },
                    daily_budget:     { type: "number", description: "Daily budget in dollars for the new campaign. Omit to inherit from source." },
                    lifetime_budget:  { type: "number", description: "Lifetime budget in dollars for the new campaign. Omit to inherit from source." },
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
            name: "get_archived_changes",
            description: "Search the archived change event log (Postgres). Unlike get_change_history (live API, max 30 days), this reads from the persisted archive with no time limit. " +
                "Use for investigating what changed months ago — removed keywords, old budget changes, campaign deletions. " +
                "Requires DATABASE_URL to be configured.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:  { type: "string", description: "Client name (partial match ok)" },
                    days:          { type: "number", description: "How far back to look (default: 90, no upper cap)" },
                    resource_type: { type: "string", description: "Filter to a resource type (e.g. AD_GROUP_CRITERION, CAMPAIGN, AD_GROUP, CAMPAIGN_BUDGET)" },
                    search:        { type: "string", description: "Substring match against change_resource_name and changed_fields (case insensitive)" },
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
            name: "get_pmax_asset_groups",
            description: "Performance Max asset group report — spend, clicks, conversions, CPA, ROAS per asset group, plus status/primary_status to spot limited or disapproved groups. " +
                "Set include_assets=true to also pull asset-level performance labels (BEST/GOOD/LOW/LEARNING) for enabled assets. " +
                "Use with get_pmax_search_terms for a full picture of what PMax is doing.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    date_range: {
                        type: "string",
                        description: "THIS_MONTH (default), LAST_7_DAYS, LAST_30_DAYS, LAST_90_DAYS, LAST_MONTH, YEAR_TO_DATE, or CUSTOM (requires start_date + end_date)",
                        enum: ["THIS_MONTH", "LAST_7_DAYS", "LAST_30_DAYS", "LAST_90_DAYS", "LAST_MONTH", "YEAR_TO_DATE", "CUSTOM"],
                    },
                    start_date:     { type: "string", description: "Start date YYYY-MM-DD (only with CUSTOM)" },
                    end_date:       { type: "string", description: "End date YYYY-MM-DD (only with CUSTOM)" },
                    include_assets: { type: "boolean", description: "Also return per-asset serving status (primary_status, policy approval) for enabled assets. Performance labels (BEST/GOOD/LOW) are no longer available from the API for PMax asset groups." },
                    top_n:          { type: "integer", description: "Max asset groups to return, sorted by spend descending (default 50, max 500)" },
                },
                required: ["account_name"],
            },
        },
        {
            name: "get_shopping_performance",
            description: "Product-level performance for Shopping and Performance Max retail campaigns, from shopping_performance_view. " +
                "Group by item_id, title, product_type, brand, or custom_label_0-4 to find which products or merchandising buckets carry the spend and the return. " +
                "Returns spend, impressions, clicks, CTR, avg CPC, conversions, conversion value, CPA and ROAS per row, plus account-level totals and a reconciliation block against campaign spend. " +
                "Use this instead of get_campaign_performance when diagnosing an ecommerce account at the product level.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    date_range: {
                        type: "string",
                        description: "LAST_30_DAYS (default), THIS_MONTH, LAST_7_DAYS, LAST_90_DAYS, LAST_MONTH, YEAR_TO_DATE, or CUSTOM (requires start_date + end_date)",
                        enum: ["THIS_MONTH", "LAST_7_DAYS", "LAST_30_DAYS", "LAST_90_DAYS", "LAST_MONTH", "YEAR_TO_DATE", "CUSTOM"],
                    },
                    start_date: { type: "string", description: "Start date YYYY-MM-DD (only with CUSTOM)" },
                    end_date:   { type: "string", description: "End date YYYY-MM-DD (only with CUSTOM)" },
                    group_by: {
                        type: "string",
                        description: "Product dimension to group on: item_id (default), title, product_type (level 1), brand, or custom_label_0-4. Custom labels come from the Merchant Center feed.",
                        enum: ["item_id", "title", "product_type", "brand", "custom_label_0", "custom_label_1", "custom_label_2", "custom_label_3", "custom_label_4"],
                    },
                    top_n: { type: "integer", description: "Max rows to return, sorted by spend descending (default 50, max 500). Totals always cover every row." },
                },
                required: ["account_name"],
            },
        },
        {
            name: "get_pmax_listing_groups",
            description: "Performance Max listing group (product partition) tree per asset group, with metrics where available. " +
                "Shows how product inventory is partitioned inside PMax — by item ID, brand, product type, condition, channel, or custom label — and flags asset groups that are a single undifferentiated catch-all node. " +
                "Use when a retail PMax campaign needs diagnosing and you want to know whether inventory is actually segmented or all lumped together.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    date_range: {
                        type: "string",
                        description: "LAST_30_DAYS (default), THIS_MONTH, LAST_7_DAYS, LAST_90_DAYS, LAST_MONTH, YEAR_TO_DATE, or CUSTOM (requires start_date + end_date)",
                        enum: ["THIS_MONTH", "LAST_7_DAYS", "LAST_30_DAYS", "LAST_90_DAYS", "LAST_MONTH", "YEAR_TO_DATE", "CUSTOM"],
                    },
                    start_date: { type: "string", description: "Start date YYYY-MM-DD (only with CUSTOM)" },
                    end_date:   { type: "string", description: "End date YYYY-MM-DD (only with CUSTOM)" },
                    top_n: { type: "integer", description: "Max listing group nodes to return per asset group, sorted by spend descending (default 50, max 500)" },
                },
                required: ["account_name"],
            },
        },
        {
            name: "get_performance_breakdown",
            description: "Break down Google Ads performance by geo (state), device, hour of day, day of week, or date. " +
                "Returns spend, clicks, impressions, CTR, CPC, conversions, CPA per segment. " +
                "Use for questions like 'where are the leads coming from', 'which device converts best', or 'what hours should we dayparts'.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    segment: {
                        type: "string",
                        description: "geo (state-level) | geo_city (city-level) | device | hour | day_of_week | date. Geo segments use the user's physical location; note PMax campaigns don't report geo data.",
                        enum: ["geo", "geo_city", "device", "hour", "day_of_week", "date"],
                    },
                    date_range: {
                        type: "string",
                        description: "THIS_MONTH (default), LAST_7_DAYS, LAST_30_DAYS, LAST_90_DAYS, LAST_MONTH, YEAR_TO_DATE, or CUSTOM (requires start_date + end_date)",
                        enum: ["THIS_MONTH", "LAST_7_DAYS", "LAST_30_DAYS", "LAST_90_DAYS", "LAST_MONTH", "YEAR_TO_DATE", "CUSTOM"],
                    },
                    start_date:    { type: "string", description: "Start date YYYY-MM-DD (only with CUSTOM)" },
                    end_date:      { type: "string", description: "End date YYYY-MM-DD (only with CUSTOM)" },
                    campaign_name: { type: "string", description: "Filter to campaigns whose name contains this (optional)" },
                },
                required: ["account_name", "segment"],
            },
        },
        {
            name: "manage_negative_lists",
            description: "Manage shared negative keyword lists in a Google Ads account. " +
                "Actions: list (all lists + attached campaigns), view (keywords in a list), create (new empty list), " +
                "add_keywords (add negatives to a list), attach (link a list to campaigns). " +
                "Write actions are dry run by default — set confirm=true to apply.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    action:       { type: "string", enum: ["list", "view", "create", "add_keywords", "attach"], description: "What to do (default: list)" },
                    list_name:    { type: "string", description: "Shared list name (partial match ok for view/add_keywords/attach; exact name for create)" },
                    keywords:     { type: "array", items: { type: "string" }, description: "Keywords to add (for add_keywords)" },
                    match_type:   { type: "string", enum: ["EXACT", "PHRASE", "BROAD"], description: "Match type for added keywords (default: PHRASE)" },
                    campaign_names: { type: "array", items: { type: "string" }, description: "Campaign names to attach the list to (partial match ok, for attach)" },
                    confirm:      { type: "boolean", description: "Set true to apply create/add_keywords/attach. Omit for dry run." },
                },
                required: ["account_name"],
            },
        },
        {
            name: "get_write_log",
            description: "Read the audit log of confirmed changes made through this MCP (budget updates, pauses, keyword adds, etc.) across all platforms. " +
                "Every tool call with confirm=true is recorded. Filter by account, tool, or lookback window.",
            inputSchema: {
                type: "object",
                properties: {
                    days:         { type: "number", description: "Lookback window in days (default: 30)" },
                    account_name: { type: "string", description: "Filter to changes for one client (partial match ok)" },
                    tool:         { type: "string", description: "Filter to one tool name (e.g. update_budget)" },
                    limit:        { type: "number", description: "Max entries to return (default: 50, newest first)" },
                },
                required: [],
            },
        },
        {
            name: "run_health_check",
            description: "Run automated health checks across all tracked accounts. Returns findings sorted by severity. " +
                "Daily checks run by default (pacing drift, conversion dry spell, CPA/ROAS breach, spend anomalies, zero-impression campaigns, budget exhaustion). " +
                "Pass weekly=true for impression share decay, CTR degradation, Meta frequency creep, and Quality Score watch. " +
                "Pass structural=true for dormant campaigns, ad disapprovals, and negative keyword conflicts. " +
                "Thresholds come from each account's health block in accounts.json (edit via manage_accounts), merged over health_defaults; accounts with health=false are skipped.",
            inputSchema: {
                type: "object",
                properties: {
                    weekly:    { type: "boolean", description: "Include weekly checks (IS decay, CTR degradation, Meta frequency, QS watch). Default false." },
                    structural:{ type: "boolean", description: "Include structural checks (dormant campaigns, ad disapprovals, negative keyword conflicts). Default false." },
                    account:   { type: "string", description: "Run checks for a single account only (partial name match). Default: all accounts." },
                    platform:  { type: "string", enum: ["google", "meta", "both"], description: "Platform to check. Default: both." },
                },
                required: [],
            },
        },
        {
            name: "list_meta_media",
            description: "List images and videos uploaded to a Meta ad account's Media Library. " +
                "Use to find image hashes or video IDs needed for create_meta_campaign.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Meta account name (partial match ok)" },
                    media_type:   { type: "string", enum: ["image", "video", "both"], description: "Filter by media type (default: both)" },
                    name_filter:  { type: "string", description: "Filter by filename (partial match, optional)" },
                },
                required: ["account_name"],
            },
        },
        {
            name: "upload_meta_media",
            description: "Upload images or videos to a Meta ad account's Media Library. " +
                "Returns image hashes or video IDs for use in create_meta_campaign. " +
                "Supports local file paths, public URLs, and base64 data (for drag-and-drop into chat). " +
                "Dry run by default — set confirm=true to upload.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Client name (partial match ok)" },
                    files: {
                        type: "array",
                        description: "Files to upload. Provide source (path/URL) OR base64_data (for images dragged into chat).",
                        items: {
                            type: "object",
                            properties: {
                                source:      { type: "string", description: "Local file path or public URL. Images: jpg/jpeg/png/gif/bmp/tiff. Videos: mp4/mov/avi/wmv/flv/mkv/webm." },
                                base64_data: { type: "string", description: "Base64-encoded file content. Use when a file is dragged into chat — Claude encodes it and passes it here. Must also provide name with extension." },
                                name:        { type: "string", description: "Display name in Media Library (with extension). Required when using base64_data, optional for source." },
                            },
                        },
                    },
                    confirm: { type: "boolean", description: "Set true to upload. Omit for dry run (validates files and formats)." },
                },
                required: ["account_name", "files"],
            },
        },
        {
            name: "search_meta_interests",
            description: "Search Meta's interest targeting options by keyword. Returns IDs needed for targeting specs in create_meta_campaign.",
            inputSchema: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Interest keyword to search (e.g. 'interior design', 'real estate')" },
                },
                required: ["query"],
            },
        },
        {
            name: "list_meta_audiences",
            description: "List custom audiences in a Meta ad account. Use to find audience IDs for retargeting or exclusions in create_meta_campaign.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Meta account name (partial match ok)" },
                },
                required: ["account_name"],
            },
        },
        {
            name: "create_meta_campaign",
            description: "Create a new Meta Ads campaign with ad sets and ads in one step. " +
                "All objects are created PAUSED for review. Dry run by default — set confirm=true to build. " +
                "Use list_meta_media to find image hashes / video IDs, search_meta_interests for targeting IDs, " +
                "and list_meta_audiences for retargeting / exclusion audience IDs.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:  { type: "string", description: "Client name (partial match ok)" },
                    campaign_name: { type: "string", description: "Name for the new campaign" },
                    objective: {
                        type: "string",
                        enum: ["OUTCOME_TRAFFIC", "OUTCOME_LEADS", "OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT", "OUTCOME_SALES"],
                        description: "Campaign objective. Most common: OUTCOME_TRAFFIC for link clicks, OUTCOME_LEADS for lead gen.",
                    },
                    daily_budget: { type: "number", description: "Campaign daily budget in dollars (when using CBO). Converted to cents for the API." },
                    lifetime_budget: { type: "number", description: "Campaign lifetime budget in dollars (alternative to daily_budget for CBO). Requires end_time on ad sets." },
                    campaign_bid_strategy: {
                        type: "string",
                        enum: ["LOWEST_COST_WITHOUT_CAP", "COST_CAP", "LOWEST_COST_WITH_BID_CAP", "LOWEST_COST_WITH_MIN_ROAS"],
                        description: "Campaign-level bid strategy for CBO. Default: LOWEST_COST_WITHOUT_CAP. COST_CAP/BID_CAP require bid_amount on ad sets.",
                    },
                    special_ad_categories: { type: "array", items: { type: "string", enum: ["EMPLOYMENT", "HOUSING", "CREDIT", "ISSUES_ELECTIONS_POLITICS"] }, description: "Special ad categories (e.g. ['EMPLOYMENT']). Restricts targeting options per Meta policy." },
                    cbo: { type: "boolean", description: "Campaign Budget Optimization (default: true). When true, budget is at campaign level. When false, set budgets per ad set." },
                    ad_sets: {
                        type: "array",
                        description: "Ad sets to create inside the campaign",
                        items: {
                            type: "object",
                            properties: {
                                name:         { type: "string", description: "Ad set name" },
                                daily_budget: { type: "number", description: "Ad set daily budget in dollars (only when CBO is off)" },
                                optimization_goal: {
                                    type: "string",
                                    enum: ["LINK_CLICKS", "LANDING_PAGE_VIEWS", "IMPRESSIONS", "REACH", "LEAD_GENERATION", "OFFSITE_CONVERSIONS"],
                                    description: "Optimization goal (default: LINK_CLICKS)",
                                },
                                billing_event: {
                                    type: "string",
                                    enum: ["IMPRESSIONS", "LINK_CLICKS"],
                                    description: "Billing event (default: IMPRESSIONS)",
                                },
                                bid_strategy: {
                                    type: "string",
                                    enum: ["LOWEST_COST_WITHOUT_CAP", "COST_CAP", "BID_CAP", "LOWEST_COST_WITH_MIN_ROAS"],
                                    description: "Bid strategy for this ad set (default: inherited from campaign). COST_CAP requires bid_amount as cost target. BID_CAP requires bid_amount as max bid. LOWEST_COST_WITH_MIN_ROAS requires roas_control.",
                                },
                                bid_amount: { type: "number", description: "Bid/cost cap in dollars (for COST_CAP or BID_CAP strategies). Converted to cents for the API." },
                                roas_control: { type: "number", description: "Minimum ROAS target (for LOWEST_COST_WITH_MIN_ROAS). E.g. 2.0 means $2 revenue per $1 spent." },
                                daily_min_spend_target: { type: "number", description: "CBO only: minimum daily spend target for this ad set (dollars)" },
                                daily_spend_cap: { type: "number", description: "CBO only: maximum daily spend cap for this ad set (dollars)" },
                                is_dynamic_creative: { type: "boolean", description: "Enable Dynamic Creative — Meta auto-combines creative assets. When true, provide multiple images/videos/texts in the ad's asset_feed_spec." },
                                targeting: {
                                    type: "object",
                                    description: "Simplified targeting spec. Fields: geo (string like 'Denver, CO'), geo_radius (miles, default 25), " +
                                        "countries (array of country codes like ['US'] for broad reach), " +
                                        "age_min, age_max, interests (array of names), behaviors (array of names), " +
                                        "custom_audiences (array of IDs), excluded_audiences (array of IDs), " +
                                        "placements ('advantage_plus' or 'manual' — default: advantage_plus). " +
                                        "For manual placements, also provide publisher_platforms, facebook_positions, instagram_positions arrays.",
                                    properties: {
                                        geo:          { type: "string", description: "Location name to target (e.g. 'Denver, CO', 'Miami, FL')" },
                                        geo_radius:   { type: "number", description: "Radius in miles around geo location (default: 25)" },
                                        countries:    { type: "array", items: { type: "string" }, description: "Country codes for country-level targeting (e.g. ['US', 'CA', 'GB']). Use instead of geo for broad reach." },
                                        geo_raw:      { description: "Raw geo_locations spec — pass an object like {regions: [{key: '3852'}]} or {countries: ['US']}. Set directly as targeting.geo_locations." },
                                        age_min:      { type: "number", description: "Minimum age (default: 18)" },
                                        age_max:      { type: "number", description: "Maximum age (default: 65)" },
                                        interests:    { type: "array", items: { type: "string" }, description: "Interest names — resolved to IDs via search" },
                                        behaviors:    { type: "array", items: { type: "string" }, description: "Behavior names — resolved to IDs via search" },
                                        custom_audiences:  { type: "array", items: { type: "string" }, description: "Custom audience IDs for targeting" },
                                        excluded_audiences:{ type: "array", items: { type: "string" }, description: "Custom audience IDs to exclude" },
                                        placements:        { type: "string", enum: ["advantage_plus", "manual"], description: "Placement strategy (default: advantage_plus)" },
                                        publisher_platforms:  { type: "array", items: { type: "string" }, description: "For manual placements: ['facebook', 'instagram']" },
                                        facebook_positions:  { type: "array", items: { type: "string" }, description: "For manual placements: ['feed', 'story', 'reels', etc.]" },
                                        instagram_positions: { type: "array", items: { type: "string" }, description: "For manual placements: ['stream', 'story', 'reels', 'explore']" },
                                    },
                                },
                                promoted_object: { type: "object", description: "Required for OFFSITE_CONVERSIONS. Example: {pixel_id: '123', custom_event_type: 'Lead'}" },
                                start_time: { type: "string", description: "ISO 8601 start time (optional)" },
                                end_time:   { type: "string", description: "ISO 8601 end time (optional)" },
                                ads: {
                                    type: "array",
                                    description: "Ads to create inside this ad set",
                                    items: {
                                        type: "object",
                                        properties: {
                                            name:         { type: "string", description: "Ad name" },
                                            primary_text: { type: "string", description: "Main ad body text" },
                                            headline:     { type: "string", description: "Headline shown below creative" },
                                            description:  { type: "string", description: "Short description / link description" },
                                            cta: {
                                                type: "string",
                                                enum: ["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "APPLY_NOW", "BUY_TICKETS", "BOOK_NOW", "CONTACT_US", "GET_OFFER", "NO_BUTTON"],
                                                description: "Call-to-action button (default: LEARN_MORE)",
                                            },
                                            url:        { type: "string", description: "Destination URL" },
                                            image_hash: { type: "string", description: "Image hash from Media Library (use list_meta_media to find). For video ads, used as the thumbnail — if omitted, the video's auto-generated thumbnail is fetched." },
                                            video_id:   { type: "string", description: "Video ID from Media Library (use list_meta_media to find)" },
                                            object_story_id: { type: "string", description: "Existing Page post ID (PAGE_ID_POST_ID) to promote as an ad. When set, primary_text/headline/url are not needed." },
                                            creative_id: { type: "string", description: "Existing creative ID to reuse. When set, no new creative is created — the ad references this creative directly." },
                                        },
                                        required: ["name"],
                                    },
                                },
                            },
                            required: ["name"],
                        },
                    },
                    confirm: { type: "boolean", description: "Set true to create. Omit for dry-run preview." },
                },
                required: ["account_name", "campaign_name", "objective", "ad_sets"],
            },
        },
        {
            name: "preview_meta_ad",
            description: "Generate a preview of a Meta ad by ad ID, creative ID, or creative spec. Returns an iframe HTML preview valid for 24 hours.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Meta account name (partial match ok)" },
                    ad_id:        { type: "string", description: "Existing ad ID to preview" },
                    creative_id:  { type: "string", description: "Existing creative ID to preview" },
                    ad_format: {
                        type: "string",
                        enum: ["DESKTOP_FEED_STANDARD", "MOBILE_FEED_STANDARD", "RIGHT_COLUMN_STANDARD", "INSTAGRAM_STANDARD", "INSTAGRAM_STORY", "FACEBOOK_STORY_MOBILE", "FACEBOOK_REELS_MOBILE"],
                        description: "Ad format / placement to preview (default: DESKTOP_FEED_STANDARD)",
                    },
                },
                required: ["account_name"],
            },
        },
        {
            name: "subscribe_meta_webhooks",
            description: "Subscribe the Meta app to ad_account webhook fields (effective_status, subscriptions, creative_fatigue, ad_recommendations, in_process_ad_objects, with_issues_ad_objects). " +
                "Requires META_APP_ID and META_APP_SECRET env vars. This is a one-time setup call that registers the callback URL and fields with Meta.",
            inputSchema: {
                type: "object",
                properties: {
                    callback_url:  { type: "string", description: "HTTPS callback URL to receive webhook POSTs" },
                    verify_token:  { type: "string", description: "A secret string your endpoint checks against hub.verify_token during verification" },
                    fields:        {
                        type: "array",
                        items: { type: "string", enum: ["effective_status", "subscriptions", "creative_fatigue", "ad_recommendations", "in_process_ad_objects", "with_issues_ad_objects"] },
                        description: "Webhook fields to subscribe to. Defaults to all six if omitted.",
                    },
                    confirm: { type: "boolean", description: "Set true to apply. Omit for dry-run preview." },
                },
                required: ["callback_url", "verify_token"],
            },
        },
        {
            name: "connect_meta_webhooks",
            description: "Connect a Meta ad account to receive webhook events from the subscribed app. " +
                "Run subscribe_meta_webhooks first to register fields, then this tool for each account.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Meta account name (partial match ok)" },
                    confirm: { type: "boolean", description: "Set true to connect. Omit for dry-run preview." },
                },
                required: ["account_name"],
            },
        },
        {
            name: "list_meta_subscriptions",
            description: "List event subscriptions on a Meta ad account (the per-account subscriptions endpoint for granular alerts like spend thresholds, new objects, metric milestones).",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Meta account name (partial match ok)" },
                },
                required: ["account_name"],
            },
        },
        {
            name: "create_meta_subscription",
            description: "Create a subscription on a Meta ad account to receive granular webhook alerts. " +
                "Event types: OBJECT_CREATED (new campaign/adset/ad), OBJECT_UPDATED (metadata field changed), " +
                "INSIGHTS_UPDATED (metric crosses a threshold), INSIGHTS_MILESTONE_REACHED (metric hits a milestone). " +
                "Amounts (budgets, spend, bids) are in cents.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Meta account name (partial match ok)" },
                    event_type: {
                        type: "string",
                        enum: ["OBJECT_CREATED", "OBJECT_UPDATED", "INSIGHTS_UPDATED", "INSIGHTS_MILESTONE_REACHED"],
                        description: "What the subscription listens for",
                    },
                    filters: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                field:    { type: "string", description: "Condition field (e.g. entity_type, objective)" },
                                value:    { type: "string", description: "Value to compare against" },
                                operator: { type: "string", description: "Comparison operator (EQUAL, GREATER_THAN, LESS_THAN, IN_RANGE, NOT_IN_RANGE, IN, NOT_IN, CONTAIN, NOT_CONTAIN, ANY, ALL, NONE)" },
                            },
                            required: ["field", "value", "operator"],
                        },
                        description: "Filter conditions (up to 20). Use entity_type to scope to CAMPAIGN, ADSET, or AD.",
                    },
                    field:    { type: "string", description: "Metric or attribute to watch (required for OBJECT_UPDATED, INSIGHTS_UPDATED, INSIGHTS_MILESTONE_REACHED). E.g. spent, cpc, daily_budget, name." },
                    value:    { type: "string", description: "Threshold value (required for INSIGHTS_UPDATED and INSIGHTS_MILESTONE_REACHED). Amounts in cents." },
                    operator: { type: "string", description: "Comparison operator for the field/value (required for INSIGHTS_UPDATED and INSIGHTS_MILESTONE_REACHED). E.g. GREATER_THAN, LESS_THAN, EQUAL, IN_RANGE, NOT_IN_RANGE." },
                    confirm:  { type: "boolean", description: "Set true to create. Omit for dry-run preview." },
                },
                required: ["account_name", "event_type", "filters"],
            },
        },
        {
            name: "update_meta_subscription",
            description: "Enable or disable a Meta ad account subscription without deleting it.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:    { type: "string", description: "Meta account name (partial match ok)" },
                    subscription_id: { type: "string", description: "Subscription ID to update" },
                    status:          { type: "string", enum: ["ENABLED", "DISABLED"], description: "New status" },
                    confirm:         { type: "boolean", description: "Set true to apply. Omit for dry-run preview." },
                },
                required: ["account_name", "subscription_id", "status"],
            },
        },
        {
            name: "delete_meta_subscription",
            description: "Delete a Meta ad account subscription permanently.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name:    { type: "string", description: "Meta account name (partial match ok)" },
                    subscription_id: { type: "string", description: "Subscription ID to delete" },
                    confirm:         { type: "boolean", description: "Set true to delete. Omit for dry-run preview." },
                },
                required: ["account_name", "subscription_id"],
            },
        },
        {
            name: "create_meta_audience",
            description: "Create a Meta custom audience (customer file) or lookalike audience. " +
                "For custom audiences, creates an empty audience ready for user uploads via manage_meta_audience_users. " +
                "For lookalike audiences, creates from a seed custom audience, campaign conversions, or page fans. " +
                "Dry run by default — set confirm=true to create.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Meta account name (partial match ok)" },
                    type: { type: "string", enum: ["custom", "lookalike"], description: "Audience type to create" },
                    name: { type: "string", description: "Audience name" },
                    description: { type: "string", description: "Audience description (custom only)" },
                    customer_file_source: {
                        type: "string",
                        enum: ["USER_PROVIDED_ONLY", "PARTNER_PROVIDED_ONLY", "BOTH_USER_AND_PARTNER_PROVIDED"],
                        description: "Source of customer data (custom only, default: USER_PROVIDED_ONLY)",
                    },
                    seed_audience_id: { type: "string", description: "Lookalike: seed custom audience ID (min 100 members)" },
                    country: { type: "string", description: "Lookalike: country code for the lookalike (e.g. 'US')" },
                    countries: { type: "array", items: { type: "string" }, description: "Lookalike: multiple country codes for multi-country lookalike" },
                    ratio: { type: "number", description: "Lookalike: audience size ratio 0.01-0.20 (e.g. 0.01 = top 1%, 0.05 = top 5%)" },
                    starting_ratio: { type: "number", description: "Lookalike: starting ratio for banded lookalike (must be < ratio)" },
                    lookalike_type: { type: "string", enum: ["similarity", "reach"], description: "Lookalike: 'similarity' (top 1%) or 'reach' (top 5%). Alternative to ratio." },
                    page_id: { type: "string", description: "Lookalike from page fans: Facebook page ID" },
                    campaign_id: { type: "string", description: "Lookalike from campaign conversions: campaign ID" },
                    confirm: { type: "boolean", description: "Set true to create. Omit for dry-run preview." },
                },
                required: ["account_name", "type", "name"],
            },
        },
        {
            name: "manage_meta_audience_users",
            description: "Add, remove, or replace users in a Meta custom audience. " +
                "Accepts hashed (SHA256) or unhashed email/phone data — unhashed data is hashed client-side before upload. " +
                "For replace: atomically swaps all users (no learning phase reset). " +
                "Dry run by default — set confirm=true to apply.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Meta account name (partial match ok)" },
                    audience_id: { type: "string", description: "Custom audience ID to modify" },
                    action: { type: "string", enum: ["add", "remove", "replace"], description: "Action to perform" },
                    schema: {
                        type: "array",
                        items: { type: "string", enum: ["EMAIL", "PHONE", "FN", "LN", "GEN", "DOBY", "DOBM", "DOBD", "ST", "CT", "ZIP", "COUNTRY", "MADID", "EXTERN_ID"] },
                        description: "Data schema — column types in order. E.g. ['EMAIL'] or ['EMAIL', 'PHONE', 'FN', 'LN']",
                    },
                    data: {
                        type: "array",
                        description: "Array of user records. Each record is an array matching the schema order. E.g. [['user@example.com'], ['other@example.com']]",
                        items: { type: "array", items: { type: "string" } },
                    },
                    confirm: { type: "boolean", description: "Set true to apply. Omit for dry-run preview." },
                },
                required: ["account_name", "audience_id", "action", "schema", "data"],
            },
        },
        {
            name: "get_meta_reach_estimate",
            description: "Estimate the potential reach for a Meta targeting spec. " +
                "Returns estimated audience size for given targeting parameters. " +
                "Use to validate targeting before creating campaigns.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Meta account name (partial match ok)" },
                    countries: { type: "array", items: { type: "string" }, description: "Country codes (e.g. ['US', 'CA'])" },
                    age_min: { type: "number", description: "Minimum age (default: 18)" },
                    age_max: { type: "number", description: "Maximum age (default: 65)" },
                    genders: { type: "array", items: { type: "number" }, description: "1=male, 2=female. Omit for all." },
                    interests: { type: "array", items: { type: "string" }, description: "Interest names (resolved to IDs)" },
                    behaviors: { type: "array", items: { type: "string" }, description: "Behavior names (resolved to IDs)" },
                    custom_audiences: { type: "array", items: { type: "string" }, description: "Custom audience IDs" },
                    excluded_audiences: { type: "array", items: { type: "string" }, description: "Excluded audience IDs" },
                    publisher_platforms: { type: "array", items: { type: "string" }, description: "e.g. ['facebook', 'instagram']" },
                    optimize_for: { type: "string", description: "Optimization goal (e.g. 'IMPRESSIONS', 'LINK_CLICKS')" },
                },
                required: ["account_name", "countries"],
            },
        },
        {
            name: "manage_meta_ad_rules",
            description: "Create, list, read, update, delete, preview, or execute automated ad rules on a Meta account. " +
                "Rules can automatically pause/unpause ads, change budgets/bids, send notifications, or rotate creatives " +
                "based on performance metrics or metadata changes. " +
                "Dry run by default for create/update/delete/execute — set confirm=true to apply.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Meta account name (partial match ok)" },
                    action: {
                        type: "string",
                        enum: ["list", "read", "create", "update", "delete", "preview", "execute", "history"],
                        description: "Action to perform (default: list)",
                    },
                    rule_id: { type: "string", description: "Rule ID — required for read/update/delete/preview/execute/history" },
                    name: { type: "string", description: "Rule name (for create/update)" },
                    evaluation_spec: {
                        type: "object",
                        description: "Evaluation spec — defines what triggers the rule. Must include evaluation_type ('SCHEDULE' or 'TRIGGER'), " +
                            "filters array, and optionally trigger object. See Meta ad rules docs for filter fields and operators.",
                    },
                    execution_spec: {
                        type: "object",
                        description: "Execution spec — defines what action to take. Must include execution_type " +
                            "('NOTIFICATION', 'PAUSE', 'UNPAUSE', 'CHANGE_BUDGET', 'CHANGE_BID', 'ROTATE', 'REBALANCE_BUDGET'). " +
                            "Optionally includes execution_options array for user_ids, change_spec, etc.",
                    },
                    schedule_spec: {
                        type: "object",
                        description: "Schedule spec for scheduled rules. Type: 'DAILY', 'HOURLY', 'SEMI_HOURLY', or 'CUSTOM'. " +
                            "CUSTOM requires schedule array with start_minute, end_minute, days.",
                    },
                    status: { type: "string", enum: ["ENABLED", "DISABLED"], description: "Rule status (for create/update)" },
                    confirm: { type: "boolean", description: "Set true to apply. Omit for dry-run preview." },
                },
                required: ["account_name", "action"],
            },
        },
        {
            name: "get_meta_ad_issues",
            description: "Find Meta ads with delivery issues — disapproved, in review, or with policy violations. " +
                "Checks effective_status and ad_review_feedback for all ads in the account.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Meta account name (partial match ok). Omit to check all Meta accounts." },
                },
                required: [],
            },
        },
        {
            name: "get_meta_insights",
            description: "Get Meta Ads performance broken down by segment — age, gender, country, region, placement, device, platform, or date. " +
                "Returns spend, impressions, clicks, CTR, CPC, and conversions per segment. " +
                "Similar to get_performance_breakdown but for Meta accounts.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Meta account name (partial match ok)" },
                    breakdown: {
                        type: "string",
                        enum: ["age", "gender", "country", "region", "publisher_platform", "platform_position", "device_platform", "impression_device"],
                        description: "Dimension to break down by",
                    },
                    date_preset: {
                        type: "string",
                        enum: ["today", "yesterday", "this_month", "last_month", "last_7d", "last_14d", "last_30d", "last_90d"],
                        description: "Date range preset (default: last_30d)",
                    },
                    start_date: { type: "string", description: "Start date YYYY-MM-DD (use instead of date_preset for custom range)" },
                    end_date: { type: "string", description: "End date YYYY-MM-DD (use with start_date)" },
                    campaign_name: { type: "string", description: "Filter to campaigns matching this name (optional)" },
                    level: {
                        type: "string",
                        enum: ["account", "campaign", "adset", "ad"],
                        description: "Reporting level (default: account)",
                    },
                },
                required: ["account_name", "breakdown"],
            },
        },
        {
            name: "get_meta_ad_performance",
            description: "Get ad-level performance metrics from Meta (Facebook/Instagram) — spend, clicks, CTR, CPC, CPM, reach, " +
                "link clicks, landing page views, purchases, post engagement, CPA, and ROAS for each ad. " +
                "Use to see which individual ads/creatives are performing well or poorly within an account.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Meta account name (partial match ok)" },
                    campaign_name: { type: "string", description: "Filter to ads within campaigns matching this substring (optional)" },
                    date_range: {
                        type: "string",
                        enum: ["THIS_MONTH", "LAST_7_DAYS", "LAST_30_DAYS", "LAST_MONTH", "CUSTOM"],
                        description: "Date range preset (default: LAST_30_DAYS). Use CUSTOM with start_date/end_date.",
                    },
                    start_date: { type: "string", description: "Start date YYYY-MM-DD — required with date_range=CUSTOM" },
                    end_date: { type: "string", description: "End date YYYY-MM-DD — required with date_range=CUSTOM" },
                    sort_by: {
                        type: "string",
                        enum: ["spend", "ctr", "cpc", "purchases", "cpa"],
                        description: "Field to sort the ads array by, descending (default: spend)",
                    },
                    min_spend: { type: "number", description: "Only return ads with spend >= this value (default: 0, include all)" },
                },
                required: ["account_name"],
            },
        },
        {
            name: "update_meta_object",
            description: "Update properties on a Meta campaign, ad set, or ad — name, bid strategy, schedule, targeting, status, and more. " +
                "Supports any writable field on campaigns (name, status, daily_budget, lifetime_budget, bid_strategy, spend_cap), " +
                "ad sets (name, status, daily_budget, lifetime_budget, bid_amount, bid_strategy, targeting, start_time, end_time, optimization_goal, billing_event, pacing_type), " +
                "and ads (name, status, creative). Dry run by default — set confirm=true to apply.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Meta account name (partial match ok)" },
                    object_id: { type: "string", description: "The campaign, ad set, or ad ID to update" },
                    level: { type: "string", enum: ["campaign", "adset", "ad"], description: "Object type being updated" },
                    updates: {
                        type: "object",
                        description: "Fields to update. Examples: {name: 'New Name'}, {daily_budget: 50} (dollars, converted to cents), " +
                            "{bid_strategy: 'COST_CAP', bid_amount: 10}, {status: 'ACTIVE'}, {end_time: '2024-12-31T23:59:59-0500'}. " +
                            "Budget values are in dollars and automatically converted to cents.",
                    },
                    confirm: { type: "boolean", description: "Set true to apply. Omit for dry-run preview." },
                    budget_confirmed: { type: "boolean", description: "Required when updating any budget field alongside confirm=true. Double-confirmation to prevent accidental budget changes." },
                },
                required: ["account_name", "object_id", "level", "updates"],
            },
        },
        {
            name: "manage_meta_leads",
            description: "List lead forms on a Facebook Page, or retrieve leads from a lead form. " +
                "Use to check lead gen form setup or download lead data.",
            inputSchema: {
                type: "object",
                properties: {
                    account_name: { type: "string", description: "Meta account name (partial match ok) — used to find the page_id" },
                    action: { type: "string", enum: ["list_forms", "get_leads"], description: "Action to perform" },
                    form_id: { type: "string", description: "Lead form ID — required for get_leads" },
                    limit: { type: "number", description: "Max leads to return (default: 100)" },
                },
                required: ["account_name", "action"],
            },
        },
    ],
    }));

    srv.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const result = await handleToolCall(name, args || {});
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    });

    return srv;
}

const server = makeServer();

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
        const [googleRows, metaRows, stackadaptRows, linkedinRows] = await Promise.all([
            error ? [{ error: `Auth failed: ${error}` }] : buildGoogleRows(token, pace_dom, dim, today, month_start, yesterday),
            buildMetaRows(pace_dom, dim, today, month_start, yesterday),
            Object.keys(STACKADAPT_ADVERTISERS).length ? buildStackAdaptRows(pace_dom, dim, today, month_start, yesterday) : null,
            Object.keys(LINKEDIN_ACCOUNTS).length ? buildLinkedInRows(pace_dom, dim, today, month_start, yesterday) : null,
        ]);
        result = { date: today, spend_through: yesterday, day: dom, days_in_month: dim, google: googleRows, meta: metaRows };
        if (stackadaptRows) result.stackadapt = stackadaptRows;
        if (linkedinRows) result.linkedin = linkedinRows;

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
        for (const [cid, info] of Object.entries(GOOGLE_ACCOUNTS)) {
            if (info.name.toLowerCase().includes(search)) {
                const { token } = await getGoogleAccessToken(cid);
                if (!token) { results.push({ platform: "Google", account: info.name, error: "Auth failed" }); continue; }
                const { budget } = getEffectiveBudget(info, today);
                const { spend, error } = await fetchGoogleMTD(token, cid, info.mcc, month_start, yesterday);
                if (error) results.push({ platform: "Google", account: info.name, error });
                else results.push({ platform: "Google", account: info.name,
                    mtd_spend: Math.round(spend * 100) / 100, budget,
                    ...getPacingLabel(spend, budget, pace_dom, dim) });
            }
        }

        // StackAdapt
        for (const [advId, info] of Object.entries(STACKADAPT_ADVERTISERS)) {
            if (!info.name.toLowerCase().includes(search)) continue;
            const { budget } = getEffectiveBudget(info, today);
            try {
                if (info.flight_start && info.flight_end) {
                    const until = yesterday < info.flight_end ? yesterday : info.flight_end;
                    const { spend } = emptyWindow(info.flight_start, until) ? { spend: 0 }
                        : await fetchStackAdaptSpend(advId, info.flight_start, until);
                    results.push({ platform: "StackAdapt", account: info.name,
                        flight_spend: Math.round(spend * 100) / 100,
                        ...getFlightPacing(spend, budget, info.flight_start, info.flight_end, yesterday) });
                } else {
                    const { spend } = emptyWindow(month_start, yesterday) ? { spend: 0 }
                        : await fetchStackAdaptSpend(advId, month_start, yesterday);
                    results.push({ platform: "StackAdapt", account: info.name,
                        mtd_spend: Math.round(spend * 100) / 100, budget,
                        ...getPacingLabel(spend, budget, pace_dom, dim) });
                }
            } catch (e) { results.push({ platform: "StackAdapt", account: info.name, error: e.message }); }
        }

        // LinkedIn
        for (const [acctId, info] of Object.entries(LINKEDIN_ACCOUNTS)) {
            if (!info.name.toLowerCase().includes(search)) continue;
            const { budget } = getEffectiveBudget(info, today);
            try {
                if (info.flight_start && info.flight_end) {
                    const until = yesterday < info.flight_end ? yesterday : info.flight_end;
                    const { spend } = emptyWindow(info.flight_start, until) ? { spend: 0 }
                        : await fetchLinkedInMTD(acctId, info.flight_start, until);
                    results.push({ platform: "LinkedIn", account: info.name,
                        flight_spend: Math.round(spend * 100) / 100,
                        ...getFlightPacing(spend, budget, info.flight_start, info.flight_end, yesterday) });
                } else {
                    const { spend } = emptyWindow(month_start, yesterday) ? { spend: 0 }
                        : await fetchLinkedInMTD(acctId, month_start, yesterday);
                    results.push({ platform: "LinkedIn", account: info.name,
                        mtd_spend: Math.round(spend * 100) / 100, budget,
                        ...getPacingLabel(spend, budget, pace_dom, dim) });
                }
            } catch (e) { results.push({ platform: "LinkedIn", account: info.name, error: e.message }); }
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
            const { token, error } = await getGoogleAccessToken(cid);
            if (error) { result = { error: `Auth failed: ${error}` }; }
            else {
                try {
                    const st = await fetchSearchTerms(token, cid, info.mcc, dateRange, startDate, endDate);
                    if (args.summary_only) {
                        delete st.all_terms;
                        st.note = "summary_only — all_terms omitted; total_terms reflects the full count.";
                    } else {
                        const limit = args.limit || 100;
                        if (st.all_terms.length > limit) {
                            st.all_terms = st.all_terms.slice(0, limit);
                            st.note = `all_terms truncated to top ${limit} by spend (of ${st.total_terms}); pass a higher limit for more.`;
                        }
                    }
                    result = { account: info.name, date_range: dateRange, ...st };
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
            const { token, error } = await getGoogleAccessToken(cid);
            if (error) { result = { error: `Auth failed: ${error}` }; }
            else {
                try {
                    const topN = clampTopN(args.top_n, 50);
                    result = { account: info.name, date_range: dateRange, top_n: topN, ...(await fetchPmaxSearchTermInsights(token, cid, info.mcc, dateRange, startDate, endDate, topN)) };
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
                const { token, error: authErr } = await getGoogleAccessToken(cid);
                if (authErr) { result.google_error = authErr; }
                else {
                    try {
                        result.google = {
                            account: info.name,
                            // Stated explicitly: this window runs through today, while
                            // get_full_pacing stops at yesterday. Without the label the two
                            // reports silently disagree on the same account.
                            spend_through: getDateInfo().today,
                            spend_note: "mtd_spend_incl_today covers the 1st through today, including today's partial spend. get_full_pacing stops at yesterday, so its figures will be lower.",
                            campaigns: await listGoogleCampaignsFull(token, cid, info.mcc),
                        };
                    }
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
        const geoInput = args.geo_target   || null;

        if (!seeds.length && !url) {
            result = { error: "Provide at least one seed_keyword or a url." };
        } else {
            const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) { result = { error: `No Google account matching '${args.account_name}'` }; }
            else {
                const [cid, info] = match;
                const { token, error: authErr } = await getGoogleAccessToken(cid);
                if (authErr) { result = { error: `Auth: ${authErr}` }; }
                else {
                    try {
                        let geoConstant = null;
                        let geoScope = "national";
                        if (geoInput) {
                            geoConstant = await resolveGeoTarget(token, info.mcc, geoInput);
                            geoScope = geoInput.startsWith("geoTargetConstants/") ? geoConstant : geoInput;
                        }

                        let ideas = await callKeywordPlannerIdeas(token, cid, info.mcc, seeds, url, geoConstant);

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
                            geo_scope: geoScope,
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
        const geoInput  = args.geo_target || null;

        if (!keywords.length) { result = { error: "Provide at least one keyword." }; }
        else {
            const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) { result = { error: `No Google account matching '${args.account_name}'` }; }
            else {
                const [cid, info] = match;
                const { token, error: authErr } = await getGoogleAccessToken(cid);
                if (authErr) { result = { error: `Auth: ${authErr}` }; }
                else {
                    try {
                        let geoConstant = null;
                        let geoScope = "national";
                        if (geoInput) {
                            geoConstant = await resolveGeoTarget(token, info.mcc, geoInput);
                            geoScope = geoInput.startsWith("geoTargetConstants/") ? geoConstant : geoInput;
                        }

                        const metrics = await fetchKeywordHistoricalMetrics(token, cid, info.mcc, keywords, showTrend, geoConstant);
                        metrics.sort((a, b) => b.avg_monthly_searches - a.avg_monthly_searches);
                        result = { account: info.name, geo_scope: geoScope, keyword_count: metrics.length, keywords: metrics };
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
                const { token, error: authErr } = await getGoogleAccessToken(cid);
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
                const { token, error: authErr } = await getGoogleAccessToken(cid);
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

    } else if (name === "pause_ad_group" || name === "enable_ad_group") {
        const search     = (args.account_name || "").toLowerCase();
        const agSearch   = (args.ad_group_name || "").toLowerCase();
        const campSearch = args.campaign_name ? args.campaign_name.toLowerCase() : null;
        const confirm    = !!args.confirm;
        const newStatus  = name === "pause_ad_group" ? "PAUSED" : "ENABLED";

        const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) { result = { error: `No Google account matching '${args.account_name}'` }; }
        else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken(cid);
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    const adGroups = await listAdGroupsFull(token, cid, info.mcc, campSearch);
                    const matches = adGroups.filter(ag => ag.name.toLowerCase().includes(agSearch));
                    if (matches.length === 0) {
                        result = {
                            error: `No ad group matching '${args.ad_group_name}'` + (campSearch ? ` in campaigns matching '${args.campaign_name}'` : ""),
                            available: adGroups.map(ag => ({ name: ag.name, campaign: ag.campaign })),
                        };
                    } else if (matches.length > 1) {
                        result = {
                            error: `${matches.length} ad groups match '${args.ad_group_name}' — use a more specific ad_group_name or add campaign_name to disambiguate.`,
                            matches: matches.map(ag => ({ name: ag.name, campaign: ag.campaign, status: ag.status })),
                        };
                    } else {
                        const ag = matches[0];
                        if (!confirm) {
                            result = { dry_run: true, message: `DRY RUN — set confirm=true to apply`, account: info.name, campaign: ag.campaign, ad_group: ag.name, current_status: ag.status, new_status: newStatus };
                        } else {
                            await updateGoogleAdGroupStatus(token, cid, info.mcc, ag.ad_group_resource, newStatus);
                            result = { success: true, account: info.name, campaign: ag.campaign, ad_group: ag.name, status: newStatus };
                        }
                    }
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "pause_keyword" || name === "enable_keyword") {
        const search     = (args.account_name || "").toLowerCase();
        const kwSearch   = (args.keyword_text || "").toLowerCase().trim();
        const campSearch = args.campaign_name ? args.campaign_name.toLowerCase() : null;
        const agSearch   = args.ad_group_name ? args.ad_group_name.toLowerCase() : null;
        const matchType  = args.match_type ? args.match_type.toUpperCase() : null;
        const allMatches = !!args.all_matches;
        const confirm    = !!args.confirm;
        const newStatus  = name === "pause_keyword" ? "PAUSED" : "ENABLED";

        const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!kwSearch) { result = { error: "keyword_text is required." }; }
        else if (!match) { result = { error: `No Google account matching '${args.account_name}'` }; }
        else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken(cid);
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    const keywords = await listKeywordCriteria(token, cid, info.mcc, campSearch, agSearch);
                    let matches = keywords.filter(k => k.keyword.toLowerCase().includes(kwSearch));
                    const exact = matches.filter(k => k.keyword.toLowerCase() === kwSearch);
                    if (exact.length > 0) matches = exact;
                    if (matchType) matches = matches.filter(k => k.match_type === matchType);
                    // No point pausing already-paused keywords (or enabling enabled ones)
                    const actionable = matches.filter(k => k.status !== newStatus);

                    if (matches.length === 0) {
                        result = {
                            error: `No keyword matching '${args.keyword_text}'` +
                                   (campSearch ? ` in campaigns matching '${args.campaign_name}'` : "") +
                                   (agSearch ? ` in ad groups matching '${args.ad_group_name}'` : "") +
                                   (matchType ? ` with match type ${matchType}` : ""),
                        };
                    } else if (actionable.length === 0) {
                        result = { message: `All ${matches.length} matching keyword(s) are already ${newStatus}.`, matches };
                    } else if (actionable.length > 1 && !allMatches) {
                        result = {
                            error: `${actionable.length} keywords match '${args.keyword_text}' — narrow with campaign_name / ad_group_name / match_type, or set all_matches=true to ${name === "pause_keyword" ? "pause" : "enable"} all of them.`,
                            matches: actionable,
                        };
                    } else if (!confirm) {
                        result = { dry_run: true, message: `DRY RUN — set confirm=true to apply`, account: info.name, new_status: newStatus, keywords: actionable };
                    } else {
                        await updateGoogleKeywordStatus(token, cid, info.mcc, actionable.map(k => k.resource_name), newStatus);
                        result = { success: true, account: info.name, status: newStatus, keywords: actionable.map(({ resource_name, ...k }) => ({ ...k, status: newStatus })) };
                    }
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "find_keywords") {
        const search         = (args.account_name || "").toLowerCase();
        const kwSearch       = args.keyword_text ? args.keyword_text.toLowerCase().trim() : null;
        const campSearch     = args.campaign_name ? args.campaign_name.toLowerCase() : null;
        const agSearch       = args.ad_group_name ? args.ad_group_name.toLowerCase() : null;
        const includeRemoved = args.include_removed !== false;
        const matchType      = args.match_type ? args.match_type.toUpperCase() : null;
        const statusFilter   = args.status ? args.status.toUpperCase() : null;

        const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) { result = { error: `No Google account matching '${args.account_name}'` }; }
        else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken(cid);
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    let keywords = await findKeywordInventory(token, cid, info.mcc);
                    if (!includeRemoved) {
                        keywords = keywords.filter(k =>
                            k.status !== "REMOVED" &&
                            k.ad_group_status !== "REMOVED" &&
                            k.campaign_status !== "REMOVED"
                        );
                    }
                    if (kwSearch)     keywords = keywords.filter(k => k.keyword.toLowerCase().includes(kwSearch));
                    if (campSearch)   keywords = keywords.filter(k => k.campaign.toLowerCase().includes(campSearch));
                    if (agSearch)     keywords = keywords.filter(k => k.ad_group.toLowerCase().includes(agSearch));
                    if (matchType)    keywords = keywords.filter(k => k.match_type === matchType);
                    if (statusFilter) keywords = keywords.filter(k => k.status === statusFilter);

                    result = {
                        account: info.name,
                        query:   args.keyword_text || "(all keywords)",
                        total:   keywords.length,
                        note:    keywords.length === 0
                            ? "Account fully scanned — no keywords match the given criteria. This is a definitive empty result, not a data gap."
                            : undefined,
                        keywords,
                    };
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "update_budget") {
        const search     = (args.account_name || "").toLowerCase();
        const campSearch = (args.campaign_name || "").toLowerCase();
        const platform   = args.platform || "google";
        const daily      = args.daily_budget;
        const confirm    = !!args.confirm;

        const dailyBudgetErrors = daily ? validateBudgets({ daily_budget: daily }) : null;
        if (!daily || daily <= 0) {
            result = { error: "daily_budget must be a positive number." };
        } else if (dailyBudgetErrors) {
            result = { error: dailyBudgetErrors.join(" | ") };
        } else if (platform === "google") {
            const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) { result = { error: `No Google account matching '${args.account_name}'` }; }
            else {
                const [cid, info] = match;
                const { token, error: authErr } = await getGoogleAccessToken(cid);
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
                const { token, error: authErr } = await getGoogleAccessToken(cid);
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
        const segmentBy = args.segment_by || null;
        const metaPresetMap = {
            THIS_MONTH: "this_month", LAST_MONTH: "last_month",
            LAST_7_DAYS: "last_7d", LAST_14_DAYS: "last_14d",
            LAST_30_DAYS: "last_30d", LAST_90_DAYS: "last_90d",
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
                const { token, error: authErr } = await getGoogleAccessToken(cid);
                if (authErr) { result.google_error = `Auth: ${authErr}`; }
                else {
                    try {
                        result.google = { account: info.name, campaigns: await fetchGoogleCampaignPerf(token, cid, info.mcc, dateRange, startDate, endDate, segmentBy) };
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

        if (platform === "stackadapt" || platform === "both") {
            const match = Object.entries(STACKADAPT_ADVERTISERS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) {
                if (platform === "stackadapt") result.stackadapt_error = `No StackAdapt advertiser matching '${args.account_name}'`;
            } else {
                const [advId, info] = match;
                try {
                    const { from, to } = rangeToDates(dateRange, startDate, endDate);
                    result.stackadapt = { account: info.name, campaigns: await fetchStackAdaptCampaignPerf(advId, from, to) };
                } catch (e) { result.stackadapt_error = e.message; }
            }
        }

    } else if (name === "get_recommendations") {
        const search = (args.account_name || "").toLowerCase();
        const match  = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account found matching '${args.account_name}'` };
        } else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken(cid);
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
            const { token, error: authErr } = await getGoogleAccessToken(cid);
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
                    const { token, error: authErr } = await getGoogleAccessToken(cid);
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
                    const { token, error: authErr } = await getGoogleAccessToken(cid);
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

                } else if (action === "list_ads") {
                    const target = args.target || null;
                    const filterLevel = args.level || null;
                    let ads;
                    if (!target) {
                        ads = await getMetaAds(accountId, null);
                    } else {
                        const targetLower = target.toLowerCase();
                        // If target looks like a numeric ID, fetch ads under it directly
                        if (/^\d+$/.test(target)) {
                            // Try as ad set ID first, then campaign ID
                            try {
                                const adsetAds = await metaGetAll(`${target}/ads`, {
                                    fields: "id,name,status,effective_status,creative{id,name,thumbnail_url,object_story_id},adset{id,name}",
                                    limit: 200,
                                });
                                ads = adsetAds.map(a => ({
                                    id: a.id, name: a.name, status: a.status, effective_status: a.effective_status,
                                    adset: a.adset?.name || null, creative_id: a.creative?.id || null,
                                    creative_name: a.creative?.name || null, object_story_id: a.creative?.object_story_id || null, level: "ad",
                                }));
                            } catch (_) {
                                ads = await getMetaAds(accountId, null);
                                ads = ads.filter(a => a.id === target);
                            }
                        } else if (filterLevel === "adset") {
                            // Match ad set name, then get ads under matching ad sets
                            const adsets = await getMetaAdsets(accountId);
                            const matching = adsets.filter(s => s.name.toLowerCase().includes(targetLower));
                            ads = [];
                            for (const s of matching) {
                                const adsetAds = await metaGetAll(`${s.id}/ads`, {
                                    fields: "id,name,status,effective_status,creative{id,name,thumbnail_url,object_story_id},adset{id,name}",
                                    limit: 200,
                                });
                                ads.push(...adsetAds.map(a => ({
                                    id: a.id, name: a.name, status: a.status, effective_status: a.effective_status,
                                    adset: a.adset?.name || null, creative_id: a.creative?.id || null,
                                    creative_name: a.creative?.name || null, object_story_id: a.creative?.object_story_id || null, level: "ad",
                                })));
                            }
                        } else {
                            // Default: try campaign name filter (via Graph API filtering), which works well
                            ads = await getMetaAds(accountId, target);
                            // If no results, try matching as ad set name
                            if (ads.length === 0) {
                                const adsets = await getMetaAdsets(accountId);
                                const matching = adsets.filter(s => s.name.toLowerCase().includes(targetLower));
                                for (const s of matching) {
                                    const adsetAds = await metaGetAll(`${s.id}/ads`, {
                                        fields: "id,name,status,effective_status,creative{id,name,thumbnail_url,object_story_id},adset{id,name}",
                                        limit: 200,
                                    });
                                    ads.push(...adsetAds.map(a => ({
                                        id: a.id, name: a.name, status: a.status, effective_status: a.effective_status,
                                        adset: a.adset?.name || null, creative_id: a.creative?.id || null,
                                        creative_name: a.creative?.name || null, level: "ad",
                                    })));
                                }
                            }
                        }
                    }
                    result = { account: acctInfo.name, filter: target, ads };

                } else if (action === "get_creative_details") {
                    if (!args.creative_ids || !Array.isArray(args.creative_ids) || args.creative_ids.length === 0) {
                        result = { error: "creative_ids (array of creative ID strings) is required" };
                    } else {
                        const details = await getMetaCreativeDetails(args.creative_ids);
                        result = { account: acctInfo.name, creatives: details };
                    }

                } else if (action === "duplicate") {
                    const dupLevel  = args.level || "campaign";
                    const dupStatus = (args.status || "PAUSED").toUpperCase();
                    if (!args.target) {
                        result = { error: "'target' is required for duplicate. Run list_campaigns or list_adsets first to find the name." };
                    } else if (dupLevel === "campaign") {
                        // Use the same recursive shallow-copy as duplicate_meta_campaign
                        const targetSearch = args.target.toLowerCase();
                        const all = await getMetaCampaigns(accountId);
                        const item = all.find(i => i.name.toLowerCase().includes(targetSearch));
                        if (!item) {
                            result = { error: `No campaign matching '${args.target}'`, available: all.map(i => i.name) };
                        } else {
                            const copyName = args.new_name || `Copy of ${item.name}`;
                            const tree = await metaReadCampaignTree(item.id);
                            const totalAds = tree.adsets.reduce((sum, s) => sum + (s.ads?.length || 0), 0);
                            if (!confirm) {
                                result = {
                                    dry_run: true,
                                    message: "DRY RUN — set confirm=true to duplicate",
                                    account:      acctInfo.name,
                                    source:       { id: item.id, name: item.name, level: dupLevel },
                                    new_name:     copyName,
                                    new_status:   dupStatus,
                                    overrides: {
                                        start_time:      args.start_time || "(inherit from source)",
                                        stop_time:       args.stop_time || "(inherit from source)",
                                        daily_budget:    args.daily_budget != null ? `$${args.daily_budget}` : "(inherit from source)",
                                        lifetime_budget: args.lifetime_budget != null ? `$${args.lifetime_budget}` : "(inherit from source)",
                                    },
                                    objects_to_copy: { campaigns: 1, ad_sets: tree.adsets.length, ads: totalAds },
                                    ad_sets: tree.adsets.map(s => ({ name: s.name, ads: (s.ads || []).map(a => a.name) })),
                                };
                            } else {
                                const res = await metaDuplicateCampaign(item.id, copyName, dupStatus, {
                                    start_time:      args.start_time,
                                    stop_time:       args.stop_time,
                                    daily_budget:    args.daily_budget,
                                    lifetime_budget: args.lifetime_budget,
                                });
                                const hasFailures = res.failures.length > 0;
                                result = {
                                    success:        !hasFailures,
                                    partial:        hasFailures,
                                    account:        acctInfo.name,
                                    source:         { id: item.id, name: item.name },
                                    new_campaign_id: res.new_campaign_id,
                                    new_name:       copyName,
                                    new_status:     dupStatus,
                                    id_map:         res.id_map,
                                    copied:         { ad_sets: res.id_map.adsets.length, ads: res.id_map.ads.length },
                                };
                                if (hasFailures) {
                                    result.failures = res.failures;
                                    result.warning = `${res.failures.length} object(s) failed to copy. The new campaign exists but is incomplete.`;
                                }
                            }
                        }
                    } else {
                        // Ad set level duplicate — single shallow copy is fine
                        const targetSearch = args.target.toLowerCase();
                        const all = await getMetaAdsets(accountId);
                        const item = all.find(i => i.name.toLowerCase().includes(targetSearch));
                        if (!item) {
                            result = { error: `No adset matching '${args.target}'`, available: all.map(i => i.name) };
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
                                };
                            } else {
                                const newId = await metaCopyOne(item.id, dupStatus, {});
                                await metaPost(newId, { name: copyName });
                                result = {
                                    success:    true,
                                    account:    acctInfo.name,
                                    source:     { id: item.id, name: item.name },
                                    new_id:     newId,
                                    new_name:   copyName,
                                    new_status: dupStatus,
                                };
                            }
                        }
                    }

                } else {
                    // pause / resume / archive / set_daily_budget — need a target
                    if (!args.target) {
                        result = { error: `'target' is required for action '${action}'. Run list_campaigns, list_adsets, or list_ads first to find the name.` };
                    } else {
                        const targetSearch = args.target.toLowerCase();
                        let items;

                        if (level === "campaign") {
                            const all = await getMetaCampaigns(accountId);
                            items = all.filter(c => c.name.toLowerCase().includes(targetSearch));
                        } else if (level === "ad") {
                            const all = await getMetaAds(accountId);
                            items = all.filter(a => a.name.toLowerCase().includes(targetSearch));
                        } else {
                            const all = await getMetaAdsets(accountId);
                            items = all.filter(s => s.name.toLowerCase().includes(targetSearch));
                        }

                        if (items.length === 0) {
                            const all = level === "campaign" ? await getMetaCampaigns(accountId) : level === "ad" ? await getMetaAds(accountId) : await getMetaAdsets(accountId);
                            result = { error: `No ${level} found matching '${args.target}'`, available: all.map(i => i.name) };
                        } else {
                            // Build preview
                            const changes = items.map(item => {
                                if (action === "pause")   return { id: item.id, name: item.name, level, change: "status → PAUSED",   current_status: item.status };
                                if (action === "resume")  return { id: item.id, name: item.name, level, change: "status → ACTIVE",   current_status: item.status };
                                if (action === "archive") return { id: item.id, name: item.name, level, change: "status → ARCHIVED", current_status: item.status };
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
                                    if (action === "pause")   body = { status: "PAUSED" };
                                    if (action === "resume")  body = { status: "ACTIVE" };
                                    if (action === "archive") body = { status: "ARCHIVED" };
                                    if (action === "set_daily_budget") {
                                        if (!args.budget) throw new Error("budget is required for set_daily_budget");
                                        const bdgErr = validateBudgets({ daily_budget: args.budget });
                                        if (bdgErr) throw new Error(bdgErr.join(" | "));
                                        body = { daily_budget: Math.round(args.budget * 100) };
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
            const { token, error: authErr } = await getGoogleAccessToken(cid);
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
                            const level    = args.level || "campaign";

                            // level=ad_group targets one ad group inside the campaign
                            let adGroup = null;
                            if (level === "ad_group") {
                                const agSearch = (args.ad_group_name || "").toLowerCase();
                                if (!agSearch) throw new Error("ad_group_name is required when level=ad_group.");
                                const adGroups = await listAdGroupsFull(token, cid, info.mcc, campMatch.name);
                                adGroup = adGroups.find(g => g.name.toLowerCase().includes(agSearch));
                                if (!adGroup) {
                                    result = { error: `No ad group matching '${args.ad_group_name}' in ${campMatch.name}`, available: adGroups.map(g => g.name) };
                                }
                            }

                            if (result) {
                                // ad group lookup already failed above
                            } else if (!confirm) {
                                // Dry run
                                result = {
                                    dry_run: true,
                                    message: "DRY RUN — no changes made. Set confirm=true to apply.",
                                    account: info.name,
                                    campaign: campMatch.name,
                                    ...(adGroup ? { ad_group: adGroup.name } : {}),
                                    level,
                                    match_type: matchType,
                                    keywords_to_add: cleanKws,
                                    count: cleanKws.length,
                                };
                            } else {
                                // Live write
                                const responses = adGroup
                                    ? await mutateAdGroupNegatives(token, cid, info.mcc, adGroup.ad_group_resource, cleanKws, matchType)
                                    : await mutateNegativeKeywords(token, cid, info.mcc, campMatch.resourceName, cleanKws, matchType);
                                result = {
                                    success: true,
                                    account: info.name,
                                    campaign: campMatch.name,
                                    ...(adGroup ? { ad_group: adGroup.name } : {}),
                                    level,
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
        const targets = Object.entries(GOOGLE_ACCOUNTS)
            .filter(([, i]) => !search || i.name.toLowerCase().includes(search));
        if (!targets.length) { result = { error: `No Google account matching '${args.account_name}'` }; }
        else {
            const accounts = [];
            for (const [cid, info] of targets) {
                try {
                    const { token, error: authErr } = await getGoogleAccessToken(cid);
                    if (authErr) { accounts.push({ account: info.name, error: `Auth: ${authErr}` }); continue; }
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

    } else if (name === "get_ad_disapprovals") {
        const search = (args.account_name || "").toLowerCase();
        const targets = Object.entries(GOOGLE_ACCOUNTS)
            .filter(([, i]) => !search || i.name.toLowerCase().includes(search));
        if (!targets.length) { result = { error: `No Google account matching '${args.account_name}'` }; }
        else {
            const accounts = [];
            let totalIssues = 0;
            for (const [cid, info] of targets) {
                try {
                    const { token, error: authErr } = await getGoogleAccessToken(cid);
                    if (authErr) { accounts.push({ account: info.name, error: `Auth: ${authErr}` }); continue; }
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

    } else if (name === "get_call_tracking") {
        const search = (args.account_name || "").toLowerCase();
        const targets = Object.entries(GOOGLE_ACCOUNTS)
            .filter(([, i]) => !search || i.name.toLowerCase().includes(search));
        if (!targets.length) { result = { error: `No Google account matching '${args.account_name}'` }; }
        else {
            const accounts = [];
            for (const [cid, info] of targets) {
                try {
                    const { token, error: authErr } = await getGoogleAccessToken(cid);
                    if (authErr) { accounts.push({ account: info.name, error: `Auth: ${authErr}` }); continue; }
                    const diag = await fetchCallTrackingDiagnostics(token, cid, info.mcc);
                    accounts.push({ account: info.name, ...diag });
                } catch (e) { accounts.push({ account: info.name, error: e.message }); }
            }
            result = { checked: accounts.length, accounts };
        }

    } else if (name === "check_anomalies") {
        const platform = args.platform || "both";
        const start8   = daysAgo(8, yesterday);
        const flags    = [];
        const errors   = [];

        if (platform === "google" || platform === "both") {
            const firstCid = Object.keys(GOOGLE_ACCOUNTS)[0];
            const { token, error: authErr } = await getGoogleAccessToken(firstCid);
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

        if (platform === "stackadapt" || platform === "both") {
            for (const [advId, info] of Object.entries(STACKADAPT_ADVERTISERS)) {
                if (info.flight_end && info.flight_end < yesterday) continue; // flight over — spend stopping is expected
                try {
                    const byDate  = await fetchStackAdaptDailySpend(advId, start8, yesterday);
                    const anomaly = detectSpendAnomaly(byDate, yesterday);
                    if (anomaly) flags.push({ platform: "StackAdapt", account: info.name, ...anomaly });
                } catch (e) { errors.push(`${info.name} (StackAdapt): ${e.message}`); }
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
        const [firstCid, firstInfo] = Object.entries(GOOGLE_ACCOUNTS)[0];
        const { token, error: gErr } = await getGoogleAccessToken(firstCid);
        if (gErr) {
            checks.google = { status: "❌ FAILING", error: gErr };
        } else {
            try {
                const [cid, info] = [firstCid, firstInfo];
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
                if (isFinite(soonest) && soonest <= 14) expiry.warning = `⚠️ Meta token expires in ${soonest} days — run \`node refresh-meta-token.js\` in ~/kaycomm-mcp to renew it, then update Railway.`;
            } catch (_) { /* debug_token can fail on some token types; identity check already passed */ }
            checks.meta = { status: "✅ OK", authenticated_as: me.name, ...(expiry ? { expiry } : {}) };
        } catch (e) {
            checks.meta = { status: "❌ FAILING", error: e.message };
        }

        // StackAdapt: cheap authenticated GraphQL round-trip
        if (STACKADAPT_API_KEY) {
            try {
                await stackAdaptGQL("{ __typename }");
                checks.stackadapt = { status: "✅ OK", note: "API key accepted." };
            } catch (e) {
                checks.stackadapt = { status: "❌ FAILING", error: e.message };
            }
        } else {
            checks.stackadapt = { status: "⚠️ NOT CONFIGURED", note: "STACKADAPT_API_KEY env var not set." };
        }

        // LinkedIn: test a lightweight API call
        if (LINKEDIN_ACCESS_TOKEN) {
            try {
                await liGet(`/adAccounts/${Object.keys(LINKEDIN_ACCOUNTS)[0] || "0"}?fields=id`);
                checks.linkedin = { status: "✅ OK", note: "Token accepted." };
            } catch (e) {
                checks.linkedin = { status: "❌ FAILING", error: e.message };
            }
        } else {
            checks.linkedin = { status: "⚠️ NOT CONFIGURED", note: "LINKEDIN_ACCESS_TOKEN env var not set." };
        }

        checks.accounts_tracked = {
            google: Object.keys(GOOGLE_ACCOUNTS).length,
            meta: Object.keys(META_ACCOUNTS).length,
            stackadapt: Object.keys(STACKADAPT_ADVERTISERS).length,
            linkedin: Object.keys(LINKEDIN_ACCOUNTS).length,
        };

        // Pinned API version age — providers sunset old versions on a clock,
        // and today that only surfaces as a surprise 4xx. Warn ahead of time.
        checks.api_versions = {};
        for (const [platform, info] of Object.entries(API_VERSION_INFO)) {
            const ageMonths = (Date.now() - new Date(info.released).getTime()) / (1000 * 60 * 60 * 24 * 30.44);
            const entry = { version: info.version, released: info.released, age_months: Math.round(ageMonths * 10) / 10 };
            if (ageMonths >= info.warnAfterMonths) {
                const label = platform === "google" ? "Google Ads" : "Meta";
                entry.warning = `⚠️ pinned ${label} API ${info.version} is ${Math.round(ageMonths)} months old — check deprecation schedule and bump ${platform === "google" ? "GOOGLE_API_VERSION" : "META_API_VERSION"}`;
            }
            checks.api_versions[platform] = entry;
        }

        result = checks;

    } else if (name === "manage_accounts") {
        const action   = args.action || "list";
        const platform = args.platform;
        const confirm  = !!args.confirm;
        const stores   = { google: GOOGLE_ACCOUNTS, meta: META_ACCOUNTS, stackadapt: STACKADAPT_ADVERTISERS, linkedin: LINKEDIN_ACCOUNTS };

        if (action === "list") {
            result = {
                accounts_file: ACCOUNTS_FILE,
                google:     Object.entries(GOOGLE_ACCOUNTS).map(([id, a]) => ({ id, ...a })),
                meta:       Object.entries(META_ACCOUNTS).map(([id, a]) => ({ id, ...a })),
                stackadapt: Object.entries(STACKADAPT_ADVERTISERS).map(([id, a]) => ({ id, ...a })),
                linkedin:   Object.entries(LINKEDIN_ACCOUNTS).map(([id, a]) => ({ id, ...a })),
            };
        } else if (!platform || !stores[platform]) {
            result = { error: "platform (google | meta | stackadapt | linkedin) is required for add/update/remove." };
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
                    for (const f of ["ga4", "nc_budget", "flight_start", "flight_end", "budget_schedule", "health", "page_id"]) {
                        if (args[f] != null) entry[f] = args[f];
                    }
                    if (!confirm) {
                        result = { dry_run: true, message: "DRY RUN — set confirm=true to save", platform, id, entry };
                    } else {
                        store[id] = entry;
                        saveAccounts();
                        result = { success: true, platform, id, entry, note: "Saved to accounts.json. Commit + push to git so Railway picks it up." };
                        if (process.env.PORT) result.ephemeral_warning = "⚠️ This server runs on Railway with an ephemeral filesystem — this change will be LOST on the next deploy. Make account changes from the Mac (local server) and commit accounts.json to git.";
                    }
                }
            } else if (action === "update") {
                if (!store[id]) {
                    result = { error: `${id} not found in ${platform} accounts.`, available: Object.entries(store).map(([k, a]) => `${k} (${a.name})`) };
                } else {
                    const changes = {};
                    for (const f of ["name", "budget", "mcc", "ga4", "nc_budget", "flight_start", "flight_end", "budget_schedule", "health", "page_id"]) {
                        if (args[f] != null) changes[f] = args[f];
                    }
                    if (!Object.keys(changes).length) {
                        result = { error: "No fields to update. Provide name, budget, mcc, ga4, nc_budget, flight_start, flight_end, budget_schedule, health, or page_id." };
                    } else if (!confirm) {
                        result = { dry_run: true, message: "DRY RUN — set confirm=true to save", platform, id, current: store[id], changes };
                    } else {
                        Object.assign(store[id], changes);
                        saveAccounts();
                        result = { success: true, platform, id, account: store[id], note: "Saved to accounts.json. Commit + push to git so Railway picks it up." };
                        if (process.env.PORT) result.ephemeral_warning = "⚠️ This server runs on Railway with an ephemeral filesystem — this change will be LOST on the next deploy. Make account changes from the Mac (local server) and commit accounts.json to git.";
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
                    if (process.env.PORT) result.ephemeral_warning = "⚠️ This server runs on Railway with an ephemeral filesystem — this change will be LOST on the next deploy. Make account changes from the Mac (local server) and commit accounts.json to git.";
                }
            }
        }

    } else if (name === "sync_accounts") {
        const platform           = args.platform || "both";
        const excludeBizIds      = args.exclude_business_ids || [];
        const checkSpend         = args.check_spend !== false; // default true
        result = {};

        if (platform === "google" || platform === "both") {
            const { token, error: authErr } = await getGoogleAccessToken(cid);
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
                const { token, error: authErr } = await getGoogleAccessToken(cid);
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
                const { token, error: authErr } = await getGoogleAccessToken(cid);
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
            const { token, error: authErr } = await getGoogleAccessToken(cid);
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
                                spend_through: getDateInfo().today,
                                campaigns: filtered.map(c => ({
                                    name:         c.name,
                                    status:       c.status,
                                    type:         c.type,
                                    daily_budget: c.daily_budget || null,
                                    mtd_spend_incl_today: c.mtd_spend_incl_today,
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
            const { token, error: authErr } = await getGoogleAccessToken(cid);
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

        if (!args.campaign_name || !args.daily_budget || !args.ad_groups?.length || !args.geo_targets?.length) {
            result = { error: "campaign_name, daily_budget, at least one ad_group, and at least one geo_target are required." };
        } else {
            const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) {
                result = { error: `No Google account matching '${args.account_name}'` };
            } else {
                const [cid, info] = match;
                const { token, error: authErr } = await getGoogleAccessToken(cid);
                if (authErr) { result = { error: `Auth: ${authErr}` }; }
                else {
                    const config = {
                        campaign_name:    args.campaign_name,
                        daily_budget:     args.daily_budget,
                        campaign_type:    args.campaign_type || "SEARCH",
                        bidding_strategy: args.bidding_strategy || "MANUAL_CPC",
                        geo_targets:      args.geo_targets,
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
                                language:         "English",
                                geo_targets:      config.geo_targets.map(id => `geoTargetConstants/${id}`),
                                geo_targeting:    "PRESENCE (people in your targeted locations)",
                                search_partners:  "OFF",
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

    } else if (name === "list_account_assets") {
        const search = (args.account_name || "").toLowerCase();
        const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account matching '${args.account_name}'` };
        } else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken(cid);
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    const assets = await listAccountAssets(token, cid, info.mcc, args.asset_types || null);
                    result = { account: info.name, total: assets.length, assets };
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "create_pmax_campaign") {
        const search  = (args.account_name || "").toLowerCase();
        const confirm = !!args.confirm;

        // Validate minimums
        const hCount  = args.headlines?.length || 0;
        const lhCount = args.long_headlines?.length || 0;
        const dCount  = args.descriptions?.length || 0;
        const miCount = args.marketing_images?.length || 0;
        const siCount = args.square_marketing_images?.length || 0;

        if (hCount < 3)  { result = { error: `Need at least 3 headlines (got ${hCount}). Max 30 chars each.` }; }
        else if (lhCount < 1) { result = { error: `Need at least 1 long headline (got ${lhCount}). Max 90 chars each.` }; }
        else if (dCount < 2)  { result = { error: `Need at least 2 descriptions (got ${dCount}). Max 90 chars each.` }; }
        else if (miCount < 1) { result = { error: `Need at least 1 marketing image — landscape 1.91:1 (got ${miCount}). Use list_account_assets to find existing images.` }; }
        else if (siCount < 1) { result = { error: `Need at least 1 square marketing image — 1:1 (got ${siCount}). Use list_account_assets to find existing images.` }; }
        else if (!args.business_name_asset) { result = { error: "business_name_asset (resource name of text asset) is required." }; }
        else if (!args.logo_asset) { result = { error: "logo_asset (resource name of image asset) is required." }; }
        else if (!args.final_url) { result = { error: "final_url is required." }; }
        else if (!args.geo_targets?.length) { result = { error: "At least one geo_target is required." }; }
        else {
            const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) {
                result = { error: `No Google account matching '${args.account_name}'` };
            } else {
                const [cid, info] = match;
                const { token, error: authErr } = await getGoogleAccessToken(cid);
                if (authErr) { result = { error: `Auth: ${authErr}` }; }
                else {
                    const config = {
                        campaign_name:          args.campaign_name,
                        daily_budget:           args.daily_budget,
                        bidding_strategy:       args.bidding_strategy || "MAXIMIZE_CONVERSIONS",
                        final_url:              args.final_url,
                        geo_targets:            args.geo_targets,
                        business_name_asset:    args.business_name_asset,
                        logo_asset:             args.logo_asset,
                        asset_group_name:       args.asset_group_name || args.campaign_name,
                        headlines:              args.headlines,
                        long_headlines:         args.long_headlines,
                        descriptions:           args.descriptions,
                        marketing_images:       args.marketing_images,
                        square_marketing_images: args.square_marketing_images,
                        logo_assets:            args.logo_assets || [],
                        youtube_videos:         args.youtube_videos || [],
                    };

                    if (!confirm) {
                        result = {
                            dry_run: true,
                            message: "DRY RUN — set confirm=true to create. Campaign will start PAUSED.",
                            account: info.name,
                            planned_campaign: {
                                name:             config.campaign_name,
                                type:             "PERFORMANCE_MAX",
                                daily_budget:     "$" + config.daily_budget.toFixed(2),
                                bidding_strategy: config.bidding_strategy,
                                final_url:        config.final_url,
                                language:         "English",
                                geo_targets:      config.geo_targets.map(id => `geoTargetConstants/${id}`),
                                status:           "PAUSED (default for new campaigns)",
                                business_name:    config.business_name_asset,
                                logo:             config.logo_asset,
                                asset_group:      config.asset_group_name,
                                headlines:        config.headlines.map(h => h.text),
                                long_headlines:   config.long_headlines.map(h => h.text),
                                descriptions:     config.descriptions.map(d => d.text),
                                marketing_images: config.marketing_images.length,
                                square_images:    config.square_marketing_images.length,
                                youtube_videos:   config.youtube_videos.length,
                            },
                        };
                    } else {
                        try {
                            const res = await createPmaxCampaignFull(token, cid, info.mcc, config);
                            result = {
                                success: true,
                                account:              info.name,
                                campaign_name:        config.campaign_name,
                                campaign_resource:    res.campaign_resource,
                                budget_resource:      res.budget_resource,
                                asset_group_resource: res.asset_group_resource,
                                total_ops:            res.total_ops,
                                status:               "PAUSED — review in Google Ads before enabling",
                            };
                        } catch (e) { result = { error: e.message }; }
                    }
                }
            }
        }

    } else if (name === "create_video_campaign") {
        const search  = (args.account_name || "").toLowerCase();
        const confirm = !!args.confirm;

        if (!args.campaign_name || !args.daily_budget || !args.final_url || !args.ad_groups?.length || !args.geo_targets?.length) {
            result = { error: "campaign_name, daily_budget, final_url, at least one ad_group, and at least one geo_target are required." };
        } else {
            const missingVideo = args.ad_groups.find(ag => !ag.youtube_video && !ag.youtube_videos?.length);
            if (missingVideo) {
                result = { error: `Ad group '${missingVideo.name || "(unnamed)"}' is missing youtube_video or youtube_videos. Provide YouTube URLs, video IDs, or asset resource names.` };
            } else {
                const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
                if (!match) {
                    result = { error: `No Google account matching '${args.account_name}'` };
                } else {
                    const [cid, info] = match;
                    const { token, error: authErr } = await getGoogleAccessToken(cid);
                    if (authErr) { result = { error: `Auth: ${authErr}` }; }
                    else {
                        const config = {
                            campaign_name:    args.campaign_name,
                            daily_budget:     args.daily_budget,
                            bidding_strategy: args.bidding_strategy || "MANUAL_CPV",
                            final_url:        args.final_url,
                            geo_targets:      args.geo_targets,
                            ad_groups:        args.ad_groups,
                        };

                        if (!confirm) {
                            result = {
                                dry_run: true,
                                message: "DRY RUN — set confirm=true to create. Campaign will start PAUSED.",
                                account: info.name,
                                planned_campaign: {
                                    name:             config.campaign_name,
                                    type:             "VIDEO (YouTube)",
                                    ad_format:        "Skippable in-stream",
                                    daily_budget:     "$" + config.daily_budget.toFixed(2),
                                    bidding_strategy: config.bidding_strategy,
                                    final_url:        config.final_url,
                                    language:         "English",
                                    geo_targets:      config.geo_targets.map(id => `geoTargetConstants/${id}`),
                                    status:           "PAUSED (default for new campaigns)",
                                    ad_groups:        config.ad_groups.map(ag => ({
                                        name:           ag.name,
                                        videos:         ag.youtube_videos || (ag.youtube_video ? [ag.youtube_video] : []),
                                        ads_per_group:  (ag.youtube_videos || (ag.youtube_video ? [ag.youtube_video] : [])).length,
                                        headline:       ag.headline || config.campaign_name,
                                        call_to_action: ag.call_to_action || "Learn More",
                                    })),
                                },
                            };
                        } else {
                            try {
                                const res = await createVideoCampaignFull(token, cid, info.mcc, config);
                                result = {
                                    success: true,
                                    account:           info.name,
                                    campaign_name:     config.campaign_name,
                                    campaign_resource: res.campaign_resource,
                                    budget_resource:   res.budget_resource,
                                    ad_groups:         res.ad_groups,
                                    ads:               res.ads,
                                    total_ops:         res.total_ops,
                                    status:            "PAUSED — review in Google Ads before enabling",
                                };
                            } catch (e) { result = { error: e.message }; }
                        }
                    }
                }
            }
        }

    } else if (name === "update_ad_copy") {
        const search     = (args.account_name || "").toLowerCase();
        const campSearch = (args.campaign_name || "").toLowerCase();
        const agSearch   = args.ad_group_name ? args.ad_group_name.toLowerCase() : null;
        const adResName  = args.ad_resource_name || null;
        const confirm    = !!args.confirm;
        const headlines  = args.headlines  || null;
        const descs      = args.descriptions || null;

        const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account matching '${args.account_name}'` };
        } else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken(cid);
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    const ads = await getAdGroupAds(token, cid, info.mcc, campSearch, agSearch, adResName);
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

    } else if (name === "update_ad_url") {
        const search     = (args.account_name || "").toLowerCase();
        const campSearch = (args.campaign_name || "").toLowerCase();
        const agSearch   = args.ad_group_name ? args.ad_group_name.toLowerCase() : null;
        const adResName  = args.ad_resource_name || null;
        const confirm    = !!args.confirm;
        const newUrl     = args.final_url || null;

        const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account matching '${args.account_name}'` };
        } else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken(cid);
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    const ads = await getAdGroupAds(token, cid, info.mcc, campSearch, agSearch, adResName);
                    if (!ads.length) {
                        result = { error: `No responsive search ads found for campaign '${args.campaign_name}'${agSearch ? ` / ad group '${args.ad_group_name}'` : ""}` };
                    } else if (!newUrl) {
                        result = {
                            account: info.name,
                            message: "Current ad URLs — provide final_url to update",
                            ads: ads.map(a => ({ resource_name: a.resource_name, campaign: a.campaign, ad_group: a.ad_group, final_urls: a.final_urls })),
                        };
                    } else if (!confirm) {
                        result = {
                            dry_run: true,
                            message: "DRY RUN — set confirm=true to apply",
                            account: info.name,
                            ads_to_update: ads.map(a => ({
                                resource_name: a.resource_name,
                                campaign:      a.campaign,
                                ad_group:      a.ad_group,
                                current_urls:  a.final_urls,
                                new_url:       newUrl,
                            })),
                        };
                    } else {
                        let updated = 0;
                        for (const ad of ads) {
                            await updateAdFinalUrl(token, cid, info.mcc, ad.resource_name, newUrl);
                            updated++;
                        }
                        result = {
                            success: true,
                            account:      info.name,
                            ads_updated:  updated,
                            new_url:      newUrl,
                        };
                    }
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "update_geo_targeting") {
        const search     = (args.account_name || "").toLowerCase();
        const campSearch = (args.campaign_name || "").toLowerCase();
        const toAdd      = args.add || [];
        const toRemove   = args.remove || [];
        const confirm    = !!args.confirm;

        const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account matching '${args.account_name}'` };
        } else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken(cid);
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    const campaigns = await listGoogleCampaignsFull(token, cid, info.mcc);
                    const camp = campaigns.find(c => c.name.toLowerCase().includes(campSearch));
                    if (!camp) {
                        result = { error: `No campaign matching '${args.campaign_name}'`, available: campaigns.map(c => c.name) };
                    } else {
                        const current = await getCampaignGeoTargets(token, cid, info.mcc, camp.resource_name);

                        if (!toAdd.length && !toRemove.length) {
                            result = {
                                account: info.name,
                                campaign: camp.name,
                                message: "Current geo targets — pass add/remove arrays to change",
                                geo_targets: current.map(g => ({
                                    criterion: g.criterion_resource_name,
                                    geo_constant: g.geo_target_constant,
                                    name: g.canonical_name || g.name,
                                    type: g.target_type,
                                })),
                            };
                        } else {
                            const ops = [];

                            // Resolve removals — match by criterion resource name, geo constant, ID, or name
                            const removeMatched = [];
                            for (const r of toRemove) {
                                const rLower = r.toLowerCase();
                                const found = current.find(g =>
                                    g.criterion_resource_name === r ||
                                    g.geo_target_constant === r ||
                                    g.geo_target_constant === `geoTargetConstants/${r}` ||
                                    (g.name && g.name.toLowerCase() === rLower) ||
                                    (g.canonical_name && g.canonical_name.toLowerCase().includes(rLower))
                                );
                                if (found) {
                                    removeMatched.push(found);
                                    ops.push({
                                        campaignCriterionOperation: {
                                            remove: found.criterion_resource_name,
                                        },
                                    });
                                } else {
                                    throw new Error(`Cannot find current geo target matching '${r}'. Current targets: ${current.map(g => g.canonical_name || g.name || g.geo_target_constant).join(", ")}`);
                                }
                            }

                            // Resolve additions — resolve to geo constant and look up name
                            const addResolved = [];
                            for (const a of toAdd) {
                                const isId = /^\d+$/.test(a);
                                let geoConstant;
                                if (isId) {
                                    geoConstant = `geoTargetConstants/${a}`;
                                } else if (a.startsWith("geoTargetConstants/")) {
                                    geoConstant = a;
                                } else {
                                    geoConstant = await resolveGeoTarget(token, info.mcc, a);
                                }
                                addResolved.push({ geo_constant: geoConstant, input: a });
                                ops.push({
                                    campaignCriterionOperation: {
                                        create: {
                                            campaign: camp.resource_name,
                                            location: { geoTargetConstant: geoConstant },
                                        },
                                    },
                                });
                            }

                            // Resolve human names for additions
                            const addGeoIds = addResolved.map(a => a.geo_constant);
                            let addNameMap = {};
                            if (addGeoIds.length) {
                                try {
                                    const nameRows = await googleSearch(token, cid, info.mcc, `
                                        SELECT geo_target_constant.resource_name,
                                               geo_target_constant.canonical_name
                                        FROM geo_target_constant
                                        WHERE geo_target_constant.resource_name IN (${addGeoIds.map(id => `'${id}'`).join(", ")})`);
                                    for (const r of nameRows) {
                                        addNameMap[r.geoTargetConstant.resourceName] = r.geoTargetConstant.canonicalName;
                                    }
                                } catch (_) { /* name lookup is best-effort */ }
                            }
                            const addDisplay = addResolved.map(a => ({
                                geo_constant: a.geo_constant,
                                name: addNameMap[a.geo_constant] || a.input,
                            }));

                            if (!confirm) {
                                result = {
                                    dry_run: true,
                                    message: "DRY RUN — set confirm=true to apply",
                                    account: info.name,
                                    campaign: camp.name,
                                    current_targets: current.map(g => g.canonical_name || g.name || g.geo_target_constant),
                                    removing: removeMatched.map(g => g.canonical_name || g.name || g.geo_target_constant),
                                    adding: addDisplay,
                                    operations: ops.length,
                                };
                            } else {
                                await googleMutateOps(token, cid, info.mcc, ops);
                                const updated = await getCampaignGeoTargets(token, cid, info.mcc, camp.resource_name);
                                result = {
                                    success: true,
                                    account: info.name,
                                    campaign: camp.name,
                                    removed: removeMatched.length,
                                    added: addDisplay.length,
                                    new_geo_targets: updated.map(g => ({
                                        geo_constant: g.geo_target_constant,
                                        name: g.canonical_name || g.name,
                                        type: g.target_type,
                                    })),
                                };
                            }
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
                const { token, error: authErr } = await getGoogleAccessToken(cid);
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
                    const tree = await metaReadCampaignTree(camp.id);
                    const totalAds = tree.adsets.reduce((sum, s) => sum + (s.ads?.length || 0), 0);

                    if (!confirm) {
                        result = {
                            dry_run:    true,
                            message:    "DRY RUN — set confirm=true to create the copy",
                            account:    acctInfo.name,
                            source:     { id: camp.id, name: camp.name, status: camp.status },
                            new_name:   copyName,
                            new_status: dupStatus,
                            overrides:  {
                                start_time:      args.start_time || "(inherit from source)",
                                stop_time:       args.stop_time || "(inherit from source)",
                                daily_budget:    args.daily_budget != null ? `$${args.daily_budget}` : "(inherit from source)",
                                lifetime_budget: args.lifetime_budget != null ? `$${args.lifetime_budget}` : "(inherit from source)",
                            },
                            objects_to_copy: {
                                campaigns: 1,
                                ad_sets:   tree.adsets.length,
                                ads:       totalAds,
                                total_api_calls: 1 + tree.adsets.length + totalAds,
                            },
                            ad_sets: tree.adsets.map(s => ({
                                name: s.name,
                                ads:  (s.ads || []).map(a => a.name),
                            })),
                        };
                    } else {
                        const res = await metaDuplicateCampaign(camp.id, copyName, dupStatus, {
                            start_time:      args.start_time,
                            stop_time:       args.stop_time,
                            daily_budget:    args.daily_budget,
                            lifetime_budget: args.lifetime_budget,
                        });
                        const hasFailures = res.failures.length > 0;
                        result = {
                            success:        !hasFailures,
                            partial:        hasFailures,
                            account:        acctInfo.name,
                            source:         { id: camp.id, name: camp.name },
                            new_campaign_id: res.new_campaign_id,
                            new_name:       copyName,
                            new_status:     dupStatus,
                            id_map:         res.id_map,
                            copied:         {
                                ad_sets: res.id_map.adsets.length,
                                ads:     res.id_map.ads.length,
                            },
                        };
                        if (hasFailures) {
                            result.failures = res.failures;
                            result.warning = `${res.failures.length} object(s) failed to copy. The new campaign exists but is incomplete — review failures and finish manually.`;
                        }
                    }
                }
            } catch (e) {
                result = { error: e.message };
            }
        }

    } else if (name === "list_meta_media") {
        const search    = (args.account_name || "").toLowerCase();
        const mediaType = args.media_type || "both";
        const nameFilter = (args.name_filter || "").toLowerCase();

        const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!acctMatch) {
            result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
        } else {
            const [accountId, acctInfo] = acctMatch;
            try {
                const out = { account: acctInfo.name };
                if (mediaType === "image" || mediaType === "both") {
                    const images = await metaGetAll(`${accountId}/adimages`, {
                        fields: "hash,name,url,width,height,created_time",
                    });
                    out.images = nameFilter
                        ? images.filter(i => (i.name || "").toLowerCase().includes(nameFilter))
                        : images;
                }
                if (mediaType === "video" || mediaType === "both") {
                    const videos = await metaGetAll(`${accountId}/advideos`, {
                        fields: "id,title,length,picture,created_time",
                    });
                    out.videos = nameFilter
                        ? videos.filter(v => (v.title || "").toLowerCase().includes(nameFilter))
                        : videos;
                }
                result = out;
            } catch (e) {
                result = { error: e.message };
            }
        }

    } else if (name === "upload_meta_media") {
        const search  = (args.account_name || "").toLowerCase();
        const confirm = !!args.confirm;
        const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "bmp", "tiff"]);
        const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "wmv", "flv", "mkv", "webm"]);

        if (!args.files?.length) {
            result = { error: "files array is required and must contain at least one item." };
        } else {
            const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
            if (!acctMatch) {
                result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
            } else {
                const [accountId, acctInfo] = acctMatch;
                try {
                    const fileMeta = [];
                    const errors = [];
                    for (const f of args.files) {
                        const isBase64 = !!f.base64_data;
                        const isUrl = !isBase64 && f.source && (f.source.startsWith("http://") || f.source.startsWith("https://"));
                        const isLocal = !isBase64 && !isUrl;

                        if (isBase64 && !f.name) {
                            errors.push({ source: "(base64)", error: "name with file extension is required when using base64_data" });
                            continue;
                        }
                        if (!isBase64 && !f.source) {
                            errors.push({ source: "(missing)", error: "Either source or base64_data is required" });
                            continue;
                        }

                        const nameSource = isBase64 ? f.name : f.source;
                        const ext = path.extname(nameSource).replace(".", "").toLowerCase();
                        const displayName = f.name || path.basename(f.source);
                        const mediaType = IMAGE_EXTS.has(ext) ? "image" : VIDEO_EXTS.has(ext) ? "video" : null;

                        if (!mediaType) {
                            errors.push({ source: nameSource, error: `Unsupported format '.${ext}'. Images: ${[...IMAGE_EXTS].join(", ")}. Videos: ${[...VIDEO_EXTS].join(", ")}.` });
                            continue;
                        }

                        let size = null;
                        if (isBase64) {
                            size = Math.round(f.base64_data.length * 3 / 4);
                        } else if (isLocal) {
                            const resolved = path.isAbsolute(f.source) ? f.source : path.resolve(f.source);
                            if (!fs.existsSync(resolved)) {
                                errors.push({ source: f.source, error: "File not found" });
                                continue;
                            }
                            const stat = fs.statSync(resolved);
                            size = stat.size;
                        }

                        fileMeta.push({
                            source: f.source || "(base64)",
                            name: displayName,
                            type: mediaType,
                            isUrl,
                            isBase64,
                            base64_data: isBase64 ? f.base64_data : null,
                            size,
                            sizeLabel: size ? (size > 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${(size / 1024).toFixed(0)} KB`) : "(URL)",
                        });
                    }

                    if (errors.length && fileMeta.length === 0) {
                        result = { error: "All files failed validation", details: errors };
                    } else if (!confirm) {
                        result = {
                            dry_run: true,
                            account: acctInfo.name,
                            files: fileMeta.map(f => ({ name: f.name, source: f.source, type: f.type, size: f.sizeLabel, status: "ready" })),
                            message: `${fileMeta.length} file(s) ready to upload. Set confirm=true to proceed.`,
                        };
                        if (errors.length) result.errors = errors;
                    } else {
                        const uploaded = [];
                        const failed = [];

                        // Helper: get a Buffer from base64, local path, or null (for URL uploads)
                        function getFileBuffer(f) {
                            if (f.isBase64) return Buffer.from(f.base64_data, "base64");
                            if (!f.isUrl) {
                                const resolved = path.isAbsolute(f.source) ? f.source : path.resolve(f.source);
                                return fs.readFileSync(resolved);
                            }
                            return null;
                        }

                        for (const f of fileMeta) {
                            try {
                                if (f.type === "image") {
                                    if (f.isUrl) {
                                        const res = await metaPost(`${accountId}/adimages`, { url: f.source });
                                        const imgData = res.images ? Object.values(res.images)[0] : res;
                                        uploaded.push({ name: f.name, type: "image", image_hash: imgData.hash, status: "ready" });
                                    } else {
                                        const fileBuffer = getFileBuffer(f);
                                        const blob = new Blob([fileBuffer]);
                                        const formData = new FormData();
                                        formData.append("access_token", META_ACCESS_TOKEN);
                                        formData.append("filename", blob, f.name);
                                        const resp = await fetchFn(
                                            `https://graph.facebook.com/${META_API_VERSION}/${accountId}/adimages`,
                                            { method: "POST", body: formData }
                                        );
                                        const data = await resp.json();
                                        if (data.error) throw new Error(data.error.message);
                                        const imgData = data.images ? Object.values(data.images)[0] : data;
                                        uploaded.push({ name: f.name, type: "image", image_hash: imgData.hash, status: "ready" });
                                    }
                                } else {
                                    let videoId;
                                    if (f.isUrl) {
                                        const res = await metaPost(`${accountId}/advideos`, { file_url: f.source, title: f.name });
                                        videoId = res.id;
                                    } else {
                                        const fileBuffer = getFileBuffer(f);
                                        const blob = new Blob([fileBuffer]);
                                        const formData = new FormData();
                                        formData.append("access_token", META_ACCESS_TOKEN);
                                        formData.append("title", f.name);
                                        formData.append("source", blob, f.name);
                                        const resp = await fetchFn(
                                            `https://graph.facebook.com/${META_API_VERSION}/${accountId}/advideos`,
                                            { method: "POST", body: formData }
                                        );
                                        const data = await resp.json();
                                        if (data.error) throw new Error(data.error.message);
                                        videoId = data.id;
                                    }
                                    // Poll for video processing status
                                    let videoStatus = "processing";
                                    const deadline = Date.now() + 120000;
                                    while (videoStatus === "processing" && Date.now() < deadline) {
                                        await new Promise(r => setTimeout(r, 3000));
                                        const statusRes = await metaGet(videoId, { fields: "status" });
                                        videoStatus = statusRes.status?.video_status || "processing";
                                    }
                                    uploaded.push({
                                        name: f.name, type: "video", video_id: videoId, status: videoStatus,
                                        ...(videoStatus === "processing" ? { note: "Still processing — will be available shortly in Ads Manager." } : {}),
                                        ...(videoStatus === "error" ? { note: "Processing failed. Check Ads Manager or retry." } : {}),
                                    });
                                }
                            } catch (e) {
                                failed.push({ name: f.name, source: f.source, error: e.message });
                            }
                        }

                        result = {
                            success: failed.length === 0,
                            account: acctInfo.name,
                            uploaded,
                            summary: `${uploaded.length} file(s) uploaded. Use image_hash / video_id values in create_meta_campaign.`,
                        };
                        if (failed.length) result.failed = failed;
                        if (errors.length) result.validation_errors = errors;
                    }
                } catch (e) {
                    result = { error: e.message };
                }
            }
        }

    } else if (name === "search_meta_interests") {
        if (!args.query) {
            result = { error: "query is required" };
        } else {
            try {
                result = { interests: await metaSearchInterests(args.query) };
            } catch (e) {
                result = { error: e.message };
            }
        }

    } else if (name === "list_meta_audiences") {
        const search = (args.account_name || "").toLowerCase();
        const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!acctMatch) {
            result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
        } else {
            const [accountId, acctInfo] = acctMatch;
            try {
                const audiences = await metaGetAll(`${accountId}/customaudiences`, {
                    fields: "id,name,subtype,description",
                });
                result = {
                    account: acctInfo.name,
                    audiences: audiences.map(a => ({
                        id: a.id, name: a.name,
                        subtype: a.subtype,
                        description: a.description,
                    })),
                };
            } catch (e) {
                result = { error: e.message };
            }
        }

    } else if (name === "create_meta_campaign") {
        const search  = (args.account_name || "").toLowerCase();
        const confirm = !!args.confirm;
        const cbo     = args.cbo !== false;

        if (!args.campaign_name || !args.objective || (!args.daily_budget && !args.lifetime_budget) || !args.ad_sets?.length) {
            result = { error: "campaign_name, objective, daily_budget or lifetime_budget, and at least one ad_set are required." };
        } else if (args.daily_budget < 1) {
            result = { error: "daily_budget must be at least $1.00 (Meta minimum)." };
        } else {
            const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
            if (!acctMatch) {
                result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
            } else {
                const [accountId, acctInfo] = acctMatch;
                const pageId = acctInfo.page_id;
                const allAdsUseCreativeId = (args.ad_sets || []).every(s => (s.ads || []).every(a => a.creative_id));
                if (!pageId && !allAdsUseCreativeId) {
                    result = { error: `No page_id configured for '${acctInfo.name}'. Add page_id to this account's entry in accounts.json.` };
                } else {
                    try {
                        if (!confirm) {
                            // Dry run — resolve targeting and build preview
                            const adSetPreviews = [];
                            const allWarnings = [];
                            for (const adSetDef of args.ad_sets) {
                                const { spec: targetingSpec, warnings } = await buildMetaTargetingSpec(adSetDef.targeting || {});
                                allWarnings.push(...warnings);

                                const targetingSummary = [];
                                if (targetingSpec.geo_locations?.countries?.length) {
                                    targetingSummary.push(`countries: ${targetingSpec.geo_locations.countries.join(", ")}`);
                                } else if (targetingSpec.geo_locations?.cities?.length) {
                                    const c = targetingSpec.geo_locations.cities[0];
                                    targetingSummary.push(`${adSetDef.targeting?.geo || `city key ${c.key}`} +${c.radius}mi`);
                                }
                                if (targetingSpec.age_min || targetingSpec.age_max) {
                                    targetingSummary.push(`ages ${targetingSpec.age_min || 18}-${targetingSpec.age_max || 65}`);
                                }
                                if (targetingSpec.flexible_spec?.[0]?.interests?.length) {
                                    targetingSummary.push(`interests: ${targetingSpec.flexible_spec[0].interests.map(i => i.name).join(", ")}`);
                                }
                                if (targetingSpec.flexible_spec?.[0]?.behaviors?.length) {
                                    targetingSummary.push(`behaviors: ${targetingSpec.flexible_spec[0].behaviors.map(b => b.name).join(", ")}`);
                                }
                                if (targetingSpec.custom_audiences?.length) {
                                    targetingSummary.push(`audiences: ${targetingSpec.custom_audiences.length} included`);
                                }
                                if (targetingSpec.exclusions?.custom_audiences?.length) {
                                    targetingSummary.push(`exclusions: ${targetingSpec.exclusions.custom_audiences.length} excluded`);
                                }
                                const placementNote = (!adSetDef.targeting?.placements || adSetDef.targeting?.placements === "advantage_plus")
                                    ? "Advantage+ (auto)" : "Manual";
                                targetingSummary.push(`placements: ${placementNote}`);

                                adSetPreviews.push({
                                    name: adSetDef.name,
                                    optimization_goal: adSetDef.optimization_goal || "LINK_CLICKS",
                                    daily_budget: !cbo && adSetDef.daily_budget ? `$${adSetDef.daily_budget.toFixed(2)}` : "(CBO)",
                                    bid_strategy: adSetDef.bid_strategy || "(campaign default)",
                                    bid_amount: adSetDef.bid_amount ? `$${adSetDef.bid_amount.toFixed(2)}` : null,
                                    roas_control: adSetDef.roas_control || null,
                                    targeting_summary: targetingSummary.join(". ") + ".",
                                    start_time: adSetDef.start_time || null,
                                    end_time: adSetDef.end_time || null,
                                    ads: (adSetDef.ads || []).map(ad => ({
                                        name: ad.name,
                                        headline: ad.headline,
                                        cta: ad.cta || "LEARN_MORE",
                                        creative_type: ad.video_id ? "video" : "image",
                                        image_hash: ad.image_hash || null,
                                        video_id: ad.video_id || null,
                                    })),
                                });
                            }

                            result = {
                                dry_run: true,
                                message: "DRY RUN. Set confirm=true to create. All objects will be PAUSED.",
                                account: acctInfo.name,
                                page_id: pageId,
                                planned: {
                                    campaign: {
                                        name: args.campaign_name,
                                        objective: args.objective,
                                        daily_budget: `$${args.daily_budget.toFixed(2)}`,
                                        cbo,
                                    },
                                    ad_sets: adSetPreviews,
                                },
                            };
                            if (allWarnings.length) result.warnings = allWarnings;
                        } else {
                            // Confirmed — create everything
                            const config = {
                                campaign_name: args.campaign_name,
                                objective: args.objective,
                                daily_budget: args.daily_budget,
                                lifetime_budget: args.lifetime_budget,
                                campaign_bid_strategy: args.campaign_bid_strategy,
                                cbo,
                                ad_sets: args.ad_sets,
                            };
                            const res = await createMetaCampaignFull(accountId, pageId, config, acctInfo.instagram_account_id);
                            const totalAds = res.ad_sets.reduce((s, as) => s + as.ads.length, 0);
                            result = {
                                success: true,
                                account: acctInfo.name,
                                campaign_id: res.campaign.id,
                                campaign_name: res.campaign.name,
                                ad_sets_created: res.ad_sets.length,
                                ads_created: totalAds,
                                status: "All objects PAUSED. Review in Ads Manager before enabling.",
                                details: res.ad_sets,
                            };
                        }
                    } catch (e) {
                        result = { error: e.message };
                    }
                }
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
            const { token, error: authErr } = await getGoogleAccessToken(cid);
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

    } else if (name === "get_archived_changes") {
        if (!process.env.DATABASE_URL) {
            result = { error: "DATABASE_URL not configured — the change event archive requires Postgres." };
        } else {
            const search       = (args.account_name || "").toLowerCase();
            const days         = args.days || 90;
            const resourceType = args.resource_type || null;
            const searchText   = args.search ? args.search.toLowerCase() : null;

            const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
            if (!match) {
                result = { error: `No Google account matching '${args.account_name}'` };
            } else {
                const [cid, info] = match;
                try {
                    const { getPool, ensureSchema } = require("./src/archive/db");
                    await ensureSchema();
                    const db = getPool();
                    const params = [cid, `${Math.floor(Math.abs(days))} days`];
                    let where = `account_id = $1 AND change_date_time >= NOW() - $2::interval`;
                    if (resourceType) {
                        params.push(resourceType);
                        where += ` AND resource_type = $${params.length}`;
                    }
                    if (searchText) {
                        params.push(`%${searchText}%`);
                        where += ` AND (LOWER(change_resource_name) LIKE $${params.length} OR LOWER(changed_fields) LIKE $${params.length})`;
                    }
                    const { rows } = await db.query(
                        `SELECT change_date_time, resource_type, change_resource_name,
                                resource_change_operation, changed_fields, user_email,
                                campaign_name, ad_group_name, old_value, new_value
                         FROM change_events
                         WHERE ${where}
                         ORDER BY change_date_time DESC
                         LIMIT 500`,
                        params
                    );
                    const summary = {};
                    for (const r of rows) {
                        const key = `${r.resource_type}:${r.resource_change_operation}`;
                        summary[key] = (summary[key] || 0) + 1;
                    }
                    result = {
                        account:       info.name,
                        source:        "archive (Postgres)",
                        days_back:     days,
                        resource_type: resourceType || "all",
                        search:        searchText || "none",
                        total_changes: rows.length,
                        summary,
                        changes: rows.map(r => ({
                            timestamp:      r.change_date_time,
                            resource_type:  r.resource_type,
                            resource_name:  r.change_resource_name,
                            operation:      r.resource_change_operation,
                            changed_fields: r.changed_fields,
                            user_email:     r.user_email,
                            campaign:       r.campaign_name,
                            ad_group:       r.ad_group_name,
                            old_value:      r.old_value,
                            new_value:      r.new_value,
                        })),
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
            const { token, error: authErr } = await getGoogleAccessToken(cid);
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
            const { token, error: authErr } = await getGoogleAccessToken(cid);
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

    } else if (name === "run_health_check") {
        const weekly = !!args.weekly;
        const structural = !!args.structural;
        const accountFilter = args.account ? args.account.toLowerCase() : null;
        const platformFilter = args.platform || "both";

        const findings = [];
        const errors = [];
        let accountsChecked = 0;

        const checksRun = ["pacing_drift", "conversion_dry_spell", "cpa_roas_breach", "spend_anomaly", "zero_impressions", "budget_exhaustion"];
        if (weekly) checksRun.push("impression_share_decay", "ctr_degradation", "meta_frequency", "quality_score");
        if (structural) checksRun.push("zero_spend_7d", "ad_disapprovals", "negative_keyword_conflicts");

        const addFinding = (severity, check, account, platform, message, data) =>
            findings.push({ severity, check, account, platform, message, data });

        // Health thresholds live in accounts.json: per-account `health` overrides
        // merged over health_defaults. Every tracked account is checked unless it
        // sets health: false — so new clients are monitored the day they're added.
        const excludedSet = new Set();
        const pickAccounts = store => Object.entries(store).filter(([, info]) => {
            if (accountFilter && !info.name.toLowerCase().includes(accountFilter)) return false;
            if (getHealthConfig(info) === null) { excludedSet.add(info.name); return false; }
            return true;
        });

        // ── Google checks ────────────────────────────────────────────────
        if (platformFilter === "google" || platformFilter === "both") {
            const { token, error: authErr } = await getGoogleAccessToken(cid);
            if (authErr) {
                errors.push(`Google auth failed: ${authErr}`);
            } else {
                for (const [cid, gAcct] of pickAccounts(GOOGLE_ACCOUNTS)) {
                    const hc = getHealthConfig(gAcct);
                    const { budget: monthlyBudget } = getEffectiveBudget(gAcct, today);
                    const isFlight = !!(gAcct.flight_start && gAcct.flight_end);
                    accountsChecked++;

                    try {
                        // Single batch query: campaign-level daily metrics for all daily checks
                        const lookback = weekly ? daysAgo(30, yesterday) : daysAgo(8, yesterday);
                        const batchRows = await googleSearch(token, cid, gAcct.mcc, `
                            SELECT segments.date, campaign.name, campaign.status, campaign.advertising_channel_type,
                                   metrics.cost_micros, metrics.impressions, metrics.clicks,
                                   metrics.conversions, metrics.conversions_value,
                                   metrics.ctr, metrics.search_impression_share,
                                   metrics.search_budget_lost_impression_share
                            FROM campaign
                            WHERE segments.date BETWEEN '${lookback}' AND '${yesterday}'
                              AND campaign.status = 'ENABLED'`);

                        // Aggregate by date for account-level metrics
                        const dailySpend = {}, dailyConversions = {}, dailyConvValue = {};
                        const dailyClicks = {}, dailyImpressions = {};
                        // Campaign-level data for yesterday
                        const campYesterday = [];
                        // Campaign-level CTR: 7d and 30d windows
                        const campCtr7d = {}, campCtr30d = {};
                        // IS tracking per date
                        const dailyIS = {};

                        for (const row of batchRows) {
                            const dt = row.segments.date;
                            const spend = parseInt(row.metrics?.costMicros || 0) / 1_000_000;
                            const imps = parseInt(row.metrics?.impressions || 0);
                            const clicks = parseInt(row.metrics?.clicks || 0);
                            const convs = parseFloat(row.metrics?.conversions || 0);
                            const convVal = parseFloat(row.metrics?.conversionsValue || 0);

                            dailySpend[dt] = (dailySpend[dt] || 0) + spend;
                            dailyConversions[dt] = (dailyConversions[dt] || 0) + convs;
                            dailyConvValue[dt] = (dailyConvValue[dt] || 0) + convVal;
                            dailyClicks[dt] = (dailyClicks[dt] || 0) + clicks;
                            dailyImpressions[dt] = (dailyImpressions[dt] || 0) + imps;

                            if (dt === yesterday) {
                                campYesterday.push({
                                    name: row.campaign.name,
                                    type: row.campaign.advertisingChannelType,
                                    spend, imps, clicks, convs, convVal,
                                    budgetLostIS: row.metrics?.searchBudgetLostImpressionShare ? parseFloat(row.metrics.searchBudgetLostImpressionShare) : null,
                                    searchIS: row.metrics?.searchImpressionShare ? parseFloat(row.metrics.searchImpressionShare) : null,
                                });
                            }

                            // IS tracking
                            if (row.metrics?.searchImpressionShare != null) {
                                if (!dailyIS[dt]) dailyIS[dt] = { totalIS: 0, count: 0 };
                                dailyIS[dt].totalIS += parseFloat(row.metrics.searchImpressionShare);
                                dailyIS[dt].count++;
                            }

                            // CTR by campaign (Search only)
                            if (row.campaign.advertisingChannelType === "SEARCH") {
                                const cName = row.campaign.name;
                                const dtObj = new Date(dt + "T00:00:00Z");
                                const ydObj = new Date(yesterday + "T00:00:00Z");
                                const diffDays = Math.round((ydObj - dtObj) / 86400000);
                                if (diffDays < 7) {
                                    if (!campCtr7d[cName]) campCtr7d[cName] = { clicks: 0, imps: 0 };
                                    campCtr7d[cName].clicks += clicks;
                                    campCtr7d[cName].imps += imps;
                                }
                                if (!campCtr30d[cName]) campCtr30d[cName] = { clicks: 0, imps: 0 };
                                campCtr30d[cName].clicks += clicks;
                                campCtr30d[cName].imps += imps;
                            }
                        }

                        // ── Check 1: Pacing drift ── (flight accounts pace in get_full_pacing, not
                        // monthly; skipped on the 1st — no complete days to project from yet)
                        if (monthlyBudget > 0 && !isFlight && pace_dom > 0) {
                            const effectiveBudget = monthlyBudget;
                            // Sum MTD spend
                            let mtdSpend = 0;
                            for (const [dt, s] of Object.entries(dailySpend)) {
                                if (dt >= month_start && dt <= yesterday) mtdSpend += s;
                            }
                            const projected = pace_dom > 0 ? Math.round((mtdSpend / pace_dom) * dim * 100) / 100 : mtdSpend;
                            const deviationPct = effectiveBudget > 0 ? Math.round(((projected - effectiveBudget) / effectiveBudget) * 100 * 10) / 10 : 0;
                            const tolerance = hc.pacing_tolerance_pct;
                            if (Math.abs(deviationPct) > tolerance) {
                                const sev = Math.abs(deviationPct) > 25 ? "critical" : "warning";
                                const dir = deviationPct > 0 ? "over" : "under";
                                addFinding(sev, "pacing_drift", gAcct.name, "google",
                                    `Projected $${projected.toLocaleString()} vs $${effectiveBudget.toLocaleString()} budget (${deviationPct > 0 ? "+" : ""}${deviationPct}%)`,
                                    { projected, budget: effectiveBudget, deviation_pct: deviationPct });
                            }
                        }

                        // ── Check 2: Conversion dry spell ──
                        if (monthlyBudget > 0 || gAcct.health?.conversion_dry_spell_hours != null) {
                            const dryThreshold = hc.conversion_dry_spell_hours;
                            // Find most recent date with conversions
                            const sortedDates = Object.keys(dailyConversions).sort().reverse();
                            let lastConvDate = null;
                            for (const dt of sortedDates) {
                                if (dailyConversions[dt] > 0) { lastConvDate = dt; break; }
                            }
                            if (lastConvDate) {
                                const hoursSince = Math.round((new Date(yesterday + "T23:59:59Z") - new Date(lastConvDate + "T23:59:59Z")) / 3600000);
                                if (hoursSince > dryThreshold) {
                                    addFinding("critical", "conversion_dry_spell", gAcct.name, "google",
                                        `No conversions in ${hoursSince} hours (threshold: ${dryThreshold}h)`,
                                        { last_conversion_date: lastConvDate, hours_since: hoursSince, threshold_hours: dryThreshold });
                                }
                            } else if (monthlyBudget > 0) {
                                addFinding("critical", "conversion_dry_spell", gAcct.name, "google",
                                    `No conversions in trailing 7+ days`,
                                    { last_conversion_date: null, threshold_hours: dryThreshold });
                            }
                        }

                        // ── Check 3: CPA/ROAS threshold breach ──
                        {
                            let spend7d = 0, convs7d = 0, convVal7d = 0;
                            for (let i = 0; i < 7; i++) {
                                const dt = daysAgo(i, yesterday);
                                spend7d += dailySpend[dt] || 0;
                                convs7d += dailyConversions[dt] || 0;
                                convVal7d += dailyConvValue[dt] || 0;
                            }
                            if (hc.cpa_target && convs7d > 0) {
                                const cpa7d = Math.round((spend7d / convs7d) * 100) / 100;
                                const tolerance = hc.cpa_tolerance_pct;
                                const breachPct = Math.round(((cpa7d - hc.cpa_target) / hc.cpa_target) * 100);
                                if (breachPct > tolerance) {
                                    addFinding("warning", "cpa_roas_breach", gAcct.name, "google",
                                        `7-day CPA $${cpa7d} exceeds target $${hc.cpa_target} (+${breachPct}%)`,
                                        { metric: "cpa", actual: cpa7d, target: hc.cpa_target, breach_pct: breachPct });
                                }
                            }
                            if (hc.roas_target && spend7d > 0) {
                                const roas7d = Math.round((convVal7d / spend7d) * 100) / 100;
                                const tolerance = hc.roas_tolerance_pct;
                                const breachPct = Math.round(((hc.roas_target - roas7d) / hc.roas_target) * 100);
                                if (breachPct > tolerance) {
                                    addFinding("warning", "cpa_roas_breach", gAcct.name, "google",
                                        `7-day ROAS ${roas7d}x below target ${hc.roas_target}x (-${breachPct}%)`,
                                        { metric: "roas", actual: roas7d, target: hc.roas_target, breach_pct: breachPct });
                                }
                            }
                        }

                        // ── Check 4: Spend spikes and drops ──
                        {
                            const anomaly = detectSpendAnomaly(dailySpend, yesterday);
                            if (anomaly) {
                                const sev = anomaly.type === "SPEND_SPIKE" && parseInt(anomaly.change) > 100 ? "critical" : "warning";
                                addFinding(sev, "spend_anomaly", gAcct.name, "google",
                                    `${anomaly.type}: yesterday $${Math.round(anomaly.yesterday * 100) / 100} vs 7d avg $${anomaly.trailing_7d_avg} (${anomaly.change})`,
                                    anomaly);
                            }
                        }

                        // ── Check 5: Zero-impression enabled campaigns ──
                        {
                            const zeroCamps = campYesterday.filter(c => c.imps === 0).map(c => c.name);
                            if (zeroCamps.length) {
                                addFinding("info", "zero_impressions", gAcct.name, "google",
                                    `${zeroCamps.length} enabled campaign(s) with 0 impressions yesterday`,
                                    { campaigns: zeroCamps });
                            }
                        }

                        // ── Check 6: Budget exhaustion ──
                        {
                            const exhausted = campYesterday.filter(c =>
                                c.budgetLostIS != null && c.budgetLostIS > (hc.budget_exhaustion_is_lost_pct || 20) / 100
                            );
                            if (exhausted.length) {
                                addFinding("warning", "budget_exhaustion", gAcct.name, "google",
                                    `${exhausted.length} campaign(s) lost >20% impression share to budget yesterday`,
                                    { campaigns: exhausted.map(c => ({ campaign: c.name, budget_lost_is: Math.round(c.budgetLostIS * 10000) / 100 + "%" })) });
                            }
                        }

                        // ── Weekly checks ──
                        if (weekly) {
                            // Check 7: Impression share decay
                            if (hc.impression_share_floor != null) {
                                const thisWeekDates = [], lastWeekDates = [];
                                for (let i = 0; i < 7; i++) thisWeekDates.push(daysAgo(i, yesterday));
                                for (let i = 7; i < 14; i++) lastWeekDates.push(daysAgo(i, yesterday));

                                const avgIS = (dates) => {
                                    let total = 0, cnt = 0;
                                    for (const dt of dates) {
                                        if (dailyIS[dt]) { total += dailyIS[dt].totalIS / dailyIS[dt].count; cnt++; }
                                    }
                                    return cnt > 0 ? Math.round((total / cnt) * 10000) / 100 : null;
                                };
                                const thisWeekIS = avgIS(thisWeekDates);
                                const lastWeekIS = avgIS(lastWeekDates);

                                if (thisWeekIS != null) {
                                    const floor = hc.impression_share_floor;
                                    if (thisWeekIS < floor) {
                                        addFinding("warning", "impression_share_decay", gAcct.name, "google",
                                            `Search IS ${thisWeekIS}% below floor of ${floor}%`,
                                            { current_is: thisWeekIS, floor, prior_week_is: lastWeekIS });
                                    } else if (lastWeekIS != null && (lastWeekIS - thisWeekIS) >= 10) {
                                        addFinding("warning", "impression_share_decay", gAcct.name, "google",
                                            `Search IS dropped ${Math.round(lastWeekIS - thisWeekIS)} points WoW (${lastWeekIS}% → ${thisWeekIS}%)`,
                                            { current_is: thisWeekIS, prior_week_is: lastWeekIS, drop: Math.round(lastWeekIS - thisWeekIS) });
                                    }
                                }
                            }

                            // Check 8: CTR degradation (Search campaigns)
                            for (const [cName, d7] of Object.entries(campCtr7d)) {
                                const d30 = campCtr30d[cName];
                                if (!d30 || d30.imps < 100 || d7.imps < 50) continue;
                                const ctr7 = d7.clicks / d7.imps;
                                const ctr30 = d30.clicks / d30.imps;
                                if (ctr30 <= 0) continue;
                                const pctChange = Math.round(((ctr7 - ctr30) / ctr30) * 100);
                                const threshold = hc.ctr_degradation_pct || -20;
                                if (pctChange < threshold) {
                                    addFinding("info", "ctr_degradation", gAcct.name, "google",
                                        `${cName}: 7d CTR ${(ctr7 * 100).toFixed(2)}% vs 30d ${(ctr30 * 100).toFixed(2)}% (${pctChange}%)`,
                                        { campaign: cName, ctr_7d: (ctr7 * 100).toFixed(2) + "%", ctr_30d: (ctr30 * 100).toFixed(2) + "%", change_pct: pctChange });
                                }
                            }

                            // Check 10: Quality Score watch
                            try {
                                const kwRows = await googleSearch(token, cid, gAcct.mcc, `
                                    SELECT campaign.name, ad_group.name,
                                           ad_group_criterion.keyword.text,
                                           ad_group_criterion.keyword.match_type,
                                           ad_group_criterion.quality_info.quality_score,
                                           ad_group_criterion.status,
                                           metrics.cost_micros
                                    FROM keyword_view
                                    WHERE segments.date BETWEEN '${daysAgo(30, yesterday)}' AND '${yesterday}'
                                      AND metrics.impressions > 0
                                      AND campaign.status = 'ENABLED'
                                      AND ad_group_criterion.status = 'ENABLED'`);
                                const qsFloor = hc.quality_score_floor || 5;
                                // Aggregate spend per keyword
                                const kwSpend = {};
                                for (const r of kwRows) {
                                    const kw = r.adGroupCriterion?.keyword?.text;
                                    const qs = r.adGroupCriterion?.qualityInfo?.qualityScore;
                                    const spend = parseInt(r.metrics?.costMicros || 0) / 1_000_000;
                                    if (!kw || qs == null) continue;
                                    if (!kwSpend[kw]) kwSpend[kw] = { qs, spend: 0, campaign: r.campaign.name, ad_group: r.adGroup.name };
                                    kwSpend[kw].spend += spend;
                                }
                                const lowQS = Object.entries(kwSpend)
                                    .filter(([, d]) => d.qs < qsFloor && d.spend >= 10)
                                    .map(([kw, d]) => ({ keyword: kw, quality_score: d.qs, spend_30d: Math.round(d.spend * 100) / 100, campaign: d.campaign }));
                                if (lowQS.length) {
                                    addFinding("info", "quality_score", gAcct.name, "google",
                                        `${lowQS.length} keyword(s) with QS < ${qsFloor} and >$10 spend in 30d`,
                                        { floor: qsFloor, keywords: lowQS.slice(0, 20) });
                                }
                            } catch (e) { errors.push(`${gAcct.name} QS check: ${e.message}`); }
                        }

                        // ── Structural checks ──
                        if (structural) {
                            // Check 11: Zero-spend enabled campaigns (7-day window)
                            {
                                const campSpend7d = {};
                                for (const row of batchRows) {
                                    const dt = row.segments.date;
                                    const dtObj = new Date(dt + "T00:00:00Z");
                                    const ydObj = new Date(yesterday + "T00:00:00Z");
                                    if (Math.round((ydObj - dtObj) / 86400000) < 7) {
                                        const cName = row.campaign.name;
                                        campSpend7d[cName] = (campSpend7d[cName] || 0) + parseInt(row.metrics?.costMicros || 0) / 1_000_000;
                                    }
                                }
                                // Also find enabled campaigns with NO rows at all in the last 7 days
                                const allEnabledCamps = new Set();
                                for (const row of batchRows) allEnabledCamps.add(row.campaign.name);
                                const dormant = [...allEnabledCamps].filter(c => (campSpend7d[c] || 0) === 0);
                                if (dormant.length) {
                                    addFinding("info", "zero_spend_7d", gAcct.name, "google",
                                        `${dormant.length} enabled campaign(s) with $0 spend in last 7 days`,
                                        { campaigns: dormant });
                                }
                            }

                            // Check 12: Ad disapproval scan
                            try {
                                const ads = await fetchAdDisapprovals(token, cid, gAcct.mcc);
                                if (ads.length) {
                                    const disapproved = ads.filter(a => a.approval_status === "DISAPPROVED");
                                    const limited = ads.filter(a => a.approval_status !== "DISAPPROVED");
                                    if (disapproved.length) {
                                        addFinding("critical", "ad_disapprovals", gAcct.name, "google",
                                            `${disapproved.length} ad(s) DISAPPROVED`,
                                            { ads: disapproved.slice(0, 10) });
                                    }
                                    if (limited.length) {
                                        addFinding("warning", "ad_disapprovals", gAcct.name, "google",
                                            `${limited.length} ad(s) with limited serving`,
                                            { ads: limited.slice(0, 10) });
                                    }
                                }
                            } catch (e) { errors.push(`${gAcct.name} ad disapprovals: ${e.message}`); }

                            // Check 13: Negative keyword conflict detection
                            try {
                                // Pull active negative keywords (campaign-level)
                                const negRows = await googleSearch(token, cid, gAcct.mcc, `
                                    SELECT campaign.name, campaign_criterion.keyword.text,
                                           campaign_criterion.keyword.match_type, campaign_criterion.negative
                                    FROM campaign_criterion
                                    WHERE campaign.status = 'ENABLED'
                                      AND campaign_criterion.negative = TRUE
                                      AND campaign_criterion.type = 'KEYWORD'`);
                                // Pull active positive keywords
                                const posRows = await googleSearch(token, cid, gAcct.mcc, `
                                    SELECT campaign.name, ad_group_criterion.keyword.text,
                                           ad_group_criterion.keyword.match_type
                                    FROM keyword_view
                                    WHERE campaign.status = 'ENABLED'
                                      AND ad_group_criterion.status = 'ENABLED'`);

                                const conflicts = [];
                                for (const neg of negRows) {
                                    const negText = (neg.campaignCriterion?.keyword?.text || "").toLowerCase();
                                    const negMatch = neg.campaignCriterion?.keyword?.matchType;
                                    const negCamp = neg.campaign.name;
                                    if (!negText) continue;

                                    for (const pos of posRows) {
                                        if (pos.campaign.name !== negCamp) continue;
                                        const posText = (pos.adGroupCriterion?.keyword?.text || "").toLowerCase();
                                        if (!posText) continue;

                                        let blocked = false;
                                        if (negMatch === "EXACT" && posText === negText) blocked = true;
                                        else if ((negMatch === "PHRASE" || negMatch === "BROAD") && posText.includes(negText)) blocked = true;

                                        if (blocked) {
                                            conflicts.push({
                                                campaign: negCamp,
                                                negative_keyword: negText,
                                                negative_match: negMatch,
                                                blocked_positive: posText,
                                            });
                                        }
                                    }
                                }
                                if (conflicts.length) {
                                    addFinding("critical", "negative_keyword_conflicts", gAcct.name, "google",
                                        `${conflicts.length} negative keyword(s) blocking positive keywords`,
                                        { conflicts: conflicts.slice(0, 20) });
                                }
                            } catch (e) { errors.push(`${gAcct.name} neg keyword check: ${e.message}`); }
                        }

                    } catch (e) {
                        errors.push(`${gAcct.name} (Google): ${e.message}`);
                    }
                }
            }
        }

        // ── Meta checks ──────────────────────────────────────────────────
        if (platformFilter === "meta" || platformFilter === "both") {
            for (const [metaId, mAcct] of pickAccounts(META_ACCOUNTS)) {
                const hc = getHealthConfig(mAcct);
                const { budget: metaBudget } = getEffectiveBudget(mAcct, today);
                const isFlight = !!(mAcct.flight_start && mAcct.flight_end);
                accountsChecked++;

                try {
                    // Pacing drift (Meta) — flight accounts pace in get_full_pacing, not
                    // monthly; skipped on the 1st — no complete days to project from yet
                    if (metaBudget > 0 && !isFlight && pace_dom > 0) {
                        const { spend, error: spendErr } = await fetchMetaMTD(metaId, month_start, yesterday);
                        if (!spendErr && spend != null) {
                            const budget = metaBudget;
                            const projected = pace_dom > 0 ? Math.round((spend / pace_dom) * dim * 100) / 100 : spend;
                            const deviationPct = Math.round(((projected - budget) / budget) * 100 * 10) / 10;
                            const tolerance = hc.pacing_tolerance_pct;
                            if (Math.abs(deviationPct) > tolerance) {
                                const sev = Math.abs(deviationPct) > 25 ? "critical" : "warning";
                                addFinding(sev, "pacing_drift", mAcct.name, "meta",
                                    `Projected $${projected.toLocaleString()} vs $${budget.toLocaleString()} budget (${deviationPct > 0 ? "+" : ""}${deviationPct}%)`,
                                    { projected, budget, deviation_pct: deviationPct });
                            }
                        }
                    }

                    // Spend anomaly (Meta)
                    const start8 = daysAgo(8, yesterday);
                    const metaDaily = await fetchMetaDailySpend(metaId, start8, yesterday);
                    const metaAnomaly = detectSpendAnomaly(metaDaily, yesterday);
                    if (metaAnomaly) {
                        const sev = metaAnomaly.type === "SPEND_SPIKE" && parseInt(metaAnomaly.change) > 100 ? "critical" : "warning";
                        addFinding(sev, "spend_anomaly", mAcct.name, "meta",
                            `${metaAnomaly.type}: yesterday $${Math.round(metaAnomaly.yesterday * 100) / 100} vs 7d avg $${metaAnomaly.trailing_7d_avg} (${metaAnomaly.change})`,
                            metaAnomaly);
                    }

                    // Weekly: Meta frequency creep (Check 9)
                    if (weekly && hc.frequency_cap) {
                        try {
                            const params = new URLSearchParams({
                                access_token: META_ACCESS_TOKEN,
                                fields: "campaign_name,frequency",
                                time_range: JSON.stringify({ since: daysAgo(7, yesterday), until: yesterday }),
                                level: "campaign",
                                limit: 100,
                            });
                            const resp = await fetchFn(`https://graph.facebook.com/${META_API_VERSION}/${metaId}/insights?${params}`);
                            const data = await resp.json();
                            if (!data.error && data.data) {
                                const highFreq = data.data
                                    .filter(r => parseFloat(r.frequency || 0) > hc.frequency_cap)
                                    .map(r => ({ campaign: r.campaign_name, frequency: parseFloat(r.frequency).toFixed(2) }));
                                if (highFreq.length) {
                                    addFinding("warning", "meta_frequency", mAcct.name, "meta",
                                        `${highFreq.length} campaign(s) above frequency cap of ${hc.frequency_cap}`,
                                        { cap: hc.frequency_cap, campaigns: highFreq });
                                }
                            }
                        } catch (e) { errors.push(`${mAcct.name} Meta frequency: ${e.message}`); }
                    }
                } catch (e) {
                    errors.push(`${mAcct.name} (Meta): ${e.message}`);
                }
            }
        }

        // Sort findings by severity
        const sevOrder = { critical: 0, warning: 1, info: 2 };
        findings.sort((a, b) => (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3));

        const summary = { critical: 0, warning: 0, info: 0, ok: 0 };
        for (const f of findings) summary[f.severity] = (summary[f.severity] || 0) + 1;
        // ok = accounts checked * checks run minus findings
        summary.ok = Math.max(0, accountsChecked * checksRun.length - findings.length);

        result = {
            run_at: new Date().toISOString(),
            mode: structural ? "structural" : weekly ? "weekly" : "daily",
            checks_run: checksRun,
            summary,
            findings,
            accounts_checked: accountsChecked,
            accounts_excluded: [...excludedSet],
            ...(errors.length ? { errors } : {}),
        };

    } else if (name === "get_write_log") {
        result = {
            entries: readWriteLog({
                days:         args.days || 30,
                account_name: args.account_name,
                tool:         args.tool,
                limit:        args.limit || 50,
            }),
            note: "Newest first. Railway's log resets on deploy — the local Mac holds the full history.",
        };

    } else if (name === "get_pmax_asset_groups") {
        const search    = (args.account_name || "").toLowerCase();
        const dateRange = args.date_range || "THIS_MONTH";
        const topN      = clampTopN(args.top_n, 50);
        const match     = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account found matching '${args.account_name}'` };
        } else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken(cid);
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    const dateClause = resolveGaqlDateClause(dateRange, args.start_date, args.end_date);
                    const groups = await fetchPmaxAssetGroups(token, cid, info.mcc, dateClause);
                    result = {
                        account:     info.name,
                        date_range:  dateRange,
                        total:       groups.length,
                        asset_groups: groups.slice(0, topN),
                        truncated:   groups.length > topN,
                    };
                    if (!groups.length) result.note = "No PMax asset groups with data in this range — the account may not run Performance Max.";
                    if (args.include_assets && groups.length) {
                        const assets = await fetchPmaxAssetPerformance(token, cid, info.mcc);
                        const limited = assets.filter(a => a.primary_status && a.primary_status !== "ELIGIBLE");
                        result.assets = {
                            total: assets.length,
                            note: "Google removed asset-level performance labels (BEST/GOOD/LOW) for PMax asset groups; " +
                                  `they are not available in Google Ads API ${GOOGLE_API_VERSION}. ` +
                                  "Serving status is returned instead — use 'needs_attention' to find assets that are not running.",
                            needs_attention: limited,
                            all: assets.slice(0, topN),
                            truncated: assets.length > topN,
                        };
                    }
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "get_shopping_performance") {
        const search    = (args.account_name || "").toLowerCase();
        const dateRange = args.date_range || "LAST_30_DAYS";
        const groupBy   = args.group_by || "item_id";
        const topN      = clampTopN(args.top_n, 50);
        const match     = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account found matching '${args.account_name}'` };
        } else if (!SHOPPING_GROUP_DIMENSIONS[groupBy]) {
            result = { error: `Unknown group_by '${groupBy}'. Valid: ${Object.keys(SHOPPING_GROUP_DIMENSIONS).join(", ")}.` };
        } else if (dateRange === "CUSTOM" && !(args.start_date && args.end_date)) {
            result = { error: "date_range CUSTOM requires both start_date and end_date (YYYY-MM-DD)." };
        } else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken(cid);
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    const dateClause = resolveGaqlDateClause(dateRange, args.start_date, args.end_date);
                    const report = await fetchShoppingPerformance(token, cid, info.mcc, dateClause, groupBy, topN);
                    result = {
                        account:    info.name,
                        date_range: dateRange,
                        ...(args.start_date ? { start_date: args.start_date } : {}),
                        ...(args.end_date   ? { end_date:   args.end_date   } : {}),
                        group_by:   groupBy,
                        top_n:      topN,
                        ...report,
                    };

                    // Reconcile against campaign-level spend so the caller can see
                    // whether the product report accounts for the money.
                    try {
                        const camp  = await fetchProductServingCampaignSpend(token, cid, info.mcc, dateClause);
                        const viewSpend = report.totals.spend;
                        const diff  = Math.round((camp.spend - viewSpend) * 100) / 100;
                        result.reconciliation = {
                            product_serving_campaign_spend: Math.round(camp.spend * 100) / 100,
                            shopping_view_spend:            viewSpend,
                            difference:                     diff,
                            difference_pct: camp.spend > 0 ? ((diff / camp.spend) * 100).toFixed(1) + "%" : "0.0%",
                            campaigns: camp.campaigns,
                            note: "Compare against get_campaign_performance for the same period: 'product_serving_campaign_spend' is the sum of SHOPPING + PERFORMANCE_MAX campaigns there. " +
                                  "A positive difference is normal for PMax — asset groups without a product feed serve non-product ads that never appear in shopping_performance_view. " +
                                  "Impressions and clicks are counted differently in this view (per product shown, not per ad) and are not expected to tie out.",
                        };
                    } catch (e) {
                        result.reconciliation = { error: `Could not pull campaign spend to reconcile: ${e.message}` };
                    }

                    if (!report.rows.length) {
                        result.note = "No product rows returned. The account may have no Shopping or Performance Max retail campaigns serving in this period, or no Merchant Center feed linked.";
                    }
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "get_pmax_listing_groups") {
        const search    = (args.account_name || "").toLowerCase();
        const dateRange = args.date_range || "LAST_30_DAYS";
        const topN      = clampTopN(args.top_n, 50);
        const match     = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account found matching '${args.account_name}'` };
        } else if (dateRange === "CUSTOM" && !(args.start_date && args.end_date)) {
            result = { error: "date_range CUSTOM requires both start_date and end_date (YYYY-MM-DD)." };
        } else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken(cid);
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    const dateClause = resolveGaqlDateClause(dateRange, args.start_date, args.end_date);
                    result = {
                        account:    info.name,
                        date_range: dateRange,
                        ...(args.start_date ? { start_date: args.start_date } : {}),
                        ...(args.end_date   ? { end_date:   args.end_date   } : {}),
                        top_n:      topN,
                        ...(await fetchPmaxListingGroups(token, cid, info.mcc, dateClause, topN)),
                    };
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "get_performance_breakdown") {
        const search    = (args.account_name || "").toLowerCase();
        const segment   = args.segment;
        const dateRange = args.date_range || "THIS_MONTH";
        const match     = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account found matching '${args.account_name}'` };
        } else if (segment !== "geo" && segment !== "geo_city" && !BREAKDOWN_SEGMENTS[segment]) {
            result = { error: `Unknown segment '${segment}'. Valid: geo, geo_city, device, hour, day_of_week, date.` };
        } else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken(cid);
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    const dateClause = resolveGaqlDateClause(dateRange, args.start_date, args.end_date);
                    const rows = await fetchPerformanceBreakdown(token, cid, info.mcc, segment, dateClause, args.campaign_name);
                    result = { account: info.name, segment, date_range: dateRange, rows };
                    if (!rows.length && (segment === "geo" || segment === "geo_city")) {
                        result.note = "No geographic rows — PMax and some Display campaigns don't report into geographic_view. Try device/hour/day_of_week instead.";
                    }
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "manage_negative_lists") {
        const search  = (args.account_name || "").toLowerCase();
        const action  = args.action || "list";
        const confirm = !!args.confirm;
        const match   = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));
        if (!match) {
            result = { error: `No Google account found matching '${args.account_name}'` };
        } else {
            const [cid, info] = match;
            const { token, error: authErr } = await getGoogleAccessToken(cid);
            if (authErr) { result = { error: `Auth: ${authErr}` }; }
            else {
                try {
                    if (action === "list") {
                        const lists = await listSharedNegativeLists(token, cid, info.mcc);
                        result = { account: info.name, total: lists.length, lists };

                    } else if (action === "create") {
                        if (!args.list_name) { result = { error: "list_name is required for create." }; }
                        else if (!confirm) {
                            result = { dry_run: true, message: "DRY RUN — set confirm=true to create", account: info.name, list_name: args.list_name };
                        } else {
                            const res = await googleMutateOps(token, cid, info.mcc, [{
                                sharedSetOperation: { create: { name: args.list_name, type: "NEGATIVE_KEYWORDS" } },
                            }]);
                            result = { success: true, account: info.name, list_name: args.list_name, resource_name: res[0]?.sharedSetResult?.resourceName };
                        }

                    } else {
                        // view / add_keywords / attach need an existing list
                        const lists = await listSharedNegativeLists(token, cid, info.mcc);
                        const listSearch = (args.list_name || "").toLowerCase();
                        const list = lists.find(l => l.name.toLowerCase().includes(listSearch));
                        if (!list) {
                            result = { error: `No shared negative list matching '${args.list_name}'`, available: lists.map(l => l.name) };
                        } else if (action === "view") {
                            const keywords = await viewSharedNegativeList(token, cid, info.mcc, list.resource_name);
                            result = { account: info.name, list: list.name, attached_campaigns: list.attached_campaigns, total: keywords.length, keywords };

                        } else if (action === "add_keywords") {
                            const keywords  = args.keywords || [];
                            const matchType = (args.match_type || "PHRASE").toUpperCase();
                            if (!keywords.length) { result = { error: "keywords is required for add_keywords." }; }
                            else if (!confirm) {
                                result = { dry_run: true, message: "DRY RUN — set confirm=true to apply", account: info.name, list: list.name, match_type: matchType, keywords };
                            } else {
                                const res = await googleMutateOps(token, cid, info.mcc, keywords.map(kw => ({
                                    sharedCriterionOperation: {
                                        create: {
                                            sharedSet: list.resource_name,
                                            keyword:   { text: kw.replace(/^["']|["']$/g, ""), matchType },
                                        },
                                    },
                                })));
                                result = { success: true, account: info.name, list: list.name, keywords_added: res.length, match_type: matchType };
                            }

                        } else if (action === "attach") {
                            const wanted = (args.campaign_names || []).map(c => c.toLowerCase());
                            if (!wanted.length) { result = { error: "campaign_names is required for attach." }; }
                            else {
                                const campaigns = await listGoogleCampaignsAll(token, cid, info.mcc);
                                const targets = campaigns.filter(c => wanted.some(w => c.name.toLowerCase().includes(w)));
                                const already = new Set(list.attached_campaigns);
                                const toAttach = targets.filter(c => !already.has(c.name));
                                if (!targets.length) {
                                    result = { error: "No campaigns matched campaign_names.", available: campaigns.map(c => c.name) };
                                } else if (!confirm) {
                                    result = { dry_run: true, message: "DRY RUN — set confirm=true to apply", account: info.name, list: list.name,
                                        attaching: toAttach.map(c => c.name), already_attached: targets.filter(c => already.has(c.name)).map(c => c.name) };
                                } else if (!toAttach.length) {
                                    result = { success: true, account: info.name, list: list.name, note: "All matched campaigns were already attached." };
                                } else {
                                    const res = await googleMutateOps(token, cid, info.mcc, toAttach.map(c => ({
                                        campaignSharedSetOperation: { create: { campaign: c.resource_name, sharedSet: list.resource_name } },
                                    })));
                                    result = { success: true, account: info.name, list: list.name, campaigns_attached: res.length, campaigns: toAttach.map(c => c.name) };
                                }
                            }
                        } else {
                            result = { error: `Unknown action '${action}'. Valid: list, view, create, add_keywords, attach.` };
                        }
                    }
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "preview_meta_ad") {
        const search = (args.account_name || "").toLowerCase();
        const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!acctMatch) {
            result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
        } else {
            const [accountId] = acctMatch;
            const adFormat = args.ad_format || "DESKTOP_FEED_STANDARD";
            try {
                if (args.ad_id) {
                    const data = await metaGet(`${args.ad_id}/previews`, { ad_format: adFormat });
                    result = { ad_id: args.ad_id, ad_format: adFormat, previews: data.data || [] };
                } else if (args.creative_id) {
                    const data = await metaGet(`${metaActId(accountId)}/generatepreviews`, {
                        creative: JSON.stringify({ creative_id: args.creative_id }),
                        ad_format: adFormat,
                    });
                    result = { creative_id: args.creative_id, ad_format: adFormat, previews: data.data || [] };
                } else {
                    result = { error: "Provide ad_id or creative_id to preview." };
                }
            } catch (e) { result = { error: e.message }; }
        }

    } else if (name === "subscribe_meta_webhooks") {
        if (!META_APP_ID || !META_APP_SECRET) {
            result = { error: "META_APP_ID and META_APP_SECRET env vars are required for webhook subscriptions." };
        } else {
            const allFields = ["effective_status", "subscriptions", "creative_fatigue", "ad_recommendations", "in_process_ad_objects", "with_issues_ad_objects"];
            const fields = args.fields && args.fields.length ? args.fields : allFields;
            const confirm = !!args.confirm;
            if (!confirm) {
                result = {
                    dry_run: true,
                    message: "DRY RUN — set confirm=true to subscribe",
                    app_id: META_APP_ID,
                    callback_url: args.callback_url,
                    fields,
                    note: "This will POST to graph.facebook.com/<APP_ID>/subscriptions with object=ad_account. Meta will send a GET verification request to your callback_url.",
                };
            } else {
                try {
                    const appToken = `${META_APP_ID}|${META_APP_SECRET}`;
                    const url = `https://graph.facebook.com/${META_API_VERSION}/${META_APP_ID}/subscriptions`;
                    const resp = await fetchFn(url, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            object: "ad_account",
                            callback_url: args.callback_url,
                            fields: fields.join(","),
                            verify_token: args.verify_token,
                            access_token: appToken,
                        }),
                    });
                    const data = await resp.json();
                    if (data.error) throw new Error(data.error.message);
                    result = { success: true, app_id: META_APP_ID, fields, callback_url: args.callback_url, response: data };
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "connect_meta_webhooks") {
        const search = (args.account_name || "").toLowerCase();
        const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!acctMatch) {
            result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
        } else {
            const [accountId, info] = acctMatch;
            const confirm = !!args.confirm;
            if (!confirm) {
                result = {
                    dry_run: true,
                    message: "DRY RUN — set confirm=true to connect",
                    account: info.name,
                    account_id: accountId,
                    note: "This will POST to graph.facebook.com/act_<ID>/subscribed_apps to start delivering webhook events for this account.",
                };
            } else {
                try {
                    const data = await metaPost(`${metaActId(accountId)}/subscribed_apps`);
                    result = { success: true, account: info.name, account_id: accountId, response: data };
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "list_meta_subscriptions") {
        const search = (args.account_name || "").toLowerCase();
        const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!acctMatch) {
            result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
        } else {
            const [accountId, info] = acctMatch;
            try {
                const data = await metaGetAll(`${metaActId(accountId)}/subscriptions`);
                result = { account: info.name, subscriptions: data };
            } catch (e) { result = { error: e.message }; }
        }

    } else if (name === "create_meta_subscription") {
        const search = (args.account_name || "").toLowerCase();
        const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!acctMatch) {
            result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
        } else {
            const [accountId, info] = acctMatch;
            const confirm = !!args.confirm;
            const body = { event_type: args.event_type, filters: args.filters };
            if (args.field)    body.field    = args.field;
            if (args.value)    body.value    = args.value;
            if (args.operator) body.operator = args.operator;
            if (!confirm) {
                result = {
                    dry_run: true,
                    message: "DRY RUN — set confirm=true to create",
                    account: info.name,
                    subscription: body,
                };
            } else {
                try {
                    const data = await metaPost(`${metaActId(accountId)}/subscriptions`, body);
                    result = { success: true, account: info.name, subscription_id: data.subscription_id, subscription: body };
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "update_meta_subscription") {
        const search = (args.account_name || "").toLowerCase();
        const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!acctMatch) {
            result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
        } else {
            const [accountId, info] = acctMatch;
            const confirm = !!args.confirm;
            if (!confirm) {
                result = {
                    dry_run: true,
                    message: "DRY RUN — set confirm=true to update",
                    account: info.name,
                    subscription_id: args.subscription_id,
                    new_status: args.status,
                };
            } else {
                try {
                    const data = await metaPatch(`${metaActId(accountId)}/subscriptions/${args.subscription_id}`, { status: args.status });
                    result = { success: true, account: info.name, subscription_id: args.subscription_id, status: args.status, response: data };
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "delete_meta_subscription") {
        const search = (args.account_name || "").toLowerCase();
        const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!acctMatch) {
            result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
        } else {
            const [accountId, info] = acctMatch;
            const confirm = !!args.confirm;
            if (!confirm) {
                result = {
                    dry_run: true,
                    message: "DRY RUN — set confirm=true to delete",
                    account: info.name,
                    subscription_id: args.subscription_id,
                    warning: "This permanently deletes the subscription.",
                };
            } else {
                try {
                    const data = await metaDelete(`${metaActId(accountId)}/subscriptions/${args.subscription_id}`);
                    result = { success: true, account: info.name, subscription_id: args.subscription_id, response: data };
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "create_meta_audience") {
        const search = (args.account_name || "").toLowerCase();
        const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!acctMatch) {
            result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
        } else {
            const [accountId, info] = acctMatch;
            const confirm = !!args.confirm;
            try {
                if (args.type === "custom") {
                    const body = {
                        name: args.name,
                        subtype: "CUSTOM",
                        description: args.description || "",
                        customer_file_source: args.customer_file_source || "USER_PROVIDED_ONLY",
                    };
                    if (!confirm) {
                        result = { dry_run: true, message: "DRY RUN — set confirm=true to create", account: info.name, audience: body };
                    } else {
                        const data = await metaPost(`${metaActId(accountId)}/customaudiences`, body);
                        result = { success: true, account: info.name, audience_id: data.id, name: args.name };
                    }
                } else if (args.type === "lookalike") {
                    const lookalikeSpec = {};
                    if (args.seed_audience_id) lookalikeSpec.origin_audience_id = args.seed_audience_id;
                    if (args.campaign_id) {
                        lookalikeSpec.origin_ids = [args.campaign_id];
                        lookalikeSpec.conversion_type = "campaign_conversions";
                    }
                    if (args.page_id) {
                        lookalikeSpec.page_id = args.page_id;
                        lookalikeSpec.conversion_type = "page_like";
                    }
                    if (args.ratio) lookalikeSpec.ratio = args.ratio;
                    else if (args.lookalike_type === "similarity") lookalikeSpec.type = "similarity";
                    else if (args.lookalike_type === "reach") lookalikeSpec.type = "reach";
                    else lookalikeSpec.ratio = 0.01;
                    if (args.starting_ratio) lookalikeSpec.starting_ratio = args.starting_ratio;
                    if (args.countries?.length) {
                        lookalikeSpec.location_spec = { geo_locations: { countries: args.countries } };
                    } else {
                        lookalikeSpec.country = args.country || "US";
                    }
                    const body = {
                        name: args.name,
                        subtype: "LOOKALIKE",
                        lookalike_spec: JSON.stringify(lookalikeSpec),
                    };
                    if (args.seed_audience_id) body.origin_audience_id = args.seed_audience_id;
                    if (!confirm) {
                        result = { dry_run: true, message: "DRY RUN — set confirm=true to create", account: info.name, audience: body, lookalike_spec: lookalikeSpec };
                    } else {
                        const data = await metaPost(`${metaActId(accountId)}/customaudiences`, body);
                        result = { success: true, account: info.name, audience_id: data.id, name: args.name, note: "Lookalike audience takes 1-6 hours to populate." };
                    }
                } else {
                    result = { error: "type must be 'custom' or 'lookalike'" };
                }
            } catch (e) { result = { error: e.message }; }
        }

    } else if (name === "manage_meta_audience_users") {
        const search = (args.account_name || "").toLowerCase();
        const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!acctMatch) {
            result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
        } else {
            const [, info] = acctMatch;
            const confirm = !!args.confirm;
            const schemaFields = args.schema || [];
            const dataRows = args.data || [];
            const noHashFields = new Set(["MADID", "EXTERN_ID"]);
            const hashIfNeeded = (val, field) => {
                if (noHashFields.has(field)) return val;
                if (/^[a-f0-9]{64}$/.test(val)) return val;
                const { createHash } = require("crypto");
                const normalized = val.trim().toLowerCase();
                return createHash("sha256").update(normalized).digest("hex");
            };
            const hashedData = dataRows.map(row =>
                row.map((val, i) => hashIfNeeded(String(val), schemaFields[i]))
            );
            if (!confirm) {
                result = {
                    dry_run: true,
                    message: `DRY RUN — set confirm=true to ${args.action} ${dataRows.length} user(s)`,
                    account: info.name,
                    audience_id: args.audience_id,
                    action: args.action,
                    schema: schemaFields,
                    user_count: dataRows.length,
                    sample_hashed: hashedData.slice(0, 2),
                };
            } else {
                try {
                    const sessionId = Date.now();
                    const payload = { schema: schemaFields, data: hashedData };
                    const session = { session_id: sessionId, batch_seq: 1, last_batch_flag: true, estimated_num_total: hashedData.length };
                    const endpoint = args.action === "remove"
                        ? `${args.audience_id}/users`
                        : args.action === "replace"
                        ? `${args.audience_id}/usersreplace`
                        : `${args.audience_id}/users`;
                    const method = args.action === "remove" ? "DELETE" : "POST";
                    const body = { payload: JSON.stringify(payload), session: JSON.stringify(session) };
                    let data;
                    if (method === "DELETE") {
                        const url = `https://graph.facebook.com/${META_API_VERSION}/${endpoint}`;
                        const resp = await fetchFn(url, {
                            method: "DELETE",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ access_token: META_ACCESS_TOKEN, ...body }),
                        });
                        data = await resp.json();
                        if (data.error) throw new Error(data.error.message);
                    } else {
                        data = await metaPost(endpoint, body);
                    }
                    result = {
                        success: true, account: info.name, audience_id: args.audience_id,
                        action: args.action, num_received: data.num_received, num_invalid: data.num_invalid_entries,
                        invalid_samples: data.invalid_entry_samples,
                    };
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "get_meta_reach_estimate") {
        const search = (args.account_name || "").toLowerCase();
        const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!acctMatch) {
            result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
        } else {
            const [accountId, info] = acctMatch;
            try {
                const targetingSpec = {};
                if (args.countries?.length) targetingSpec.geo_locations = { countries: args.countries };
                if (args.age_min) targetingSpec.age_min = args.age_min;
                if (args.age_max) targetingSpec.age_max = args.age_max;
                if (args.genders?.length) targetingSpec.genders = args.genders;
                if (args.interests?.length || args.behaviors?.length) {
                    const flexSpec = {};
                    if (args.interests?.length) {
                        const resolved = [];
                        for (const name of args.interests) {
                            const results = await metaSearchInterests(name);
                            if (results.length) resolved.push({ id: results[0].id, name: results[0].name });
                        }
                        if (resolved.length) flexSpec.interests = resolved;
                    }
                    if (args.behaviors?.length) {
                        const resolved = [];
                        for (const name of args.behaviors) {
                            const results = await metaSearchInterests(name);
                            if (results.length) resolved.push({ id: results[0].id, name: results[0].name });
                        }
                        if (resolved.length) flexSpec.behaviors = resolved;
                    }
                    if (Object.keys(flexSpec).length) targetingSpec.flexible_spec = [flexSpec];
                }
                if (args.custom_audiences?.length) targetingSpec.custom_audiences = args.custom_audiences.map(id => ({ id }));
                if (args.excluded_audiences?.length) targetingSpec.excluded_custom_audiences = args.excluded_audiences.map(id => ({ id }));
                if (args.publisher_platforms?.length) targetingSpec.publisher_platforms = args.publisher_platforms;

                const params = { targeting_spec: JSON.stringify(targetingSpec) };
                if (args.optimize_for) params.optimize_for = args.optimize_for;
                const data = await metaGet(`${metaActId(accountId)}/reachestimate`, params);
                result = {
                    account: info.name,
                    targeting_spec: targetingSpec,
                    estimated_users: data.data?.[0]?.users ?? data.users ?? null,
                    estimate_ready: data.data?.[0]?.estimate_ready ?? data.estimate_ready ?? null,
                    bid_estimations: data.data?.[0]?.bid_estimations ?? null,
                };
            } catch (e) { result = { error: e.message }; }
        }

    } else if (name === "manage_meta_ad_rules") {
        const search = (args.account_name || "").toLowerCase();
        const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!acctMatch) {
            result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
        } else {
            const [accountId, info] = acctMatch;
            const action = args.action || "list";
            const confirm = !!args.confirm;
            try {
                if (action === "list") {
                    const rules = await metaGetAll(`${metaActId(accountId)}/adrules_library`, {
                        fields: "id,name,status,evaluation_spec,execution_spec,schedule_spec",
                    });
                    result = { account: info.name, total: rules.length, rules: rules.map(r => ({
                        id: r.id, name: r.name, status: r.status,
                        evaluation_type: r.evaluation_spec?.evaluation_type,
                        execution_type: r.execution_spec?.execution_type,
                    })) };

                } else if (action === "read") {
                    if (!args.rule_id) { result = { error: "rule_id is required for read." }; }
                    else {
                        const rule = await metaGet(args.rule_id, { fields: "id,name,status,evaluation_spec,execution_spec,schedule_spec,created_time,updated_time" });
                        result = { account: info.name, rule };
                    }

                } else if (action === "create") {
                    if (!args.name || !args.evaluation_spec || !args.execution_spec) {
                        result = { error: "name, evaluation_spec, and execution_spec are required for create." };
                    } else {
                        const body = {
                            name: args.name,
                            evaluation_spec: JSON.stringify(args.evaluation_spec),
                            execution_spec: JSON.stringify(args.execution_spec),
                        };
                        if (args.schedule_spec) body.schedule_spec = JSON.stringify(args.schedule_spec);
                        if (args.status) body.status = args.status;
                        if (!confirm) {
                            result = { dry_run: true, message: "DRY RUN — set confirm=true to create", account: info.name, rule: { name: args.name, ...body } };
                        } else {
                            const data = await metaPost(`${metaActId(accountId)}/adrules_library`, body);
                            result = { success: true, account: info.name, rule_id: data.id, name: args.name };
                        }
                    }

                } else if (action === "update") {
                    if (!args.rule_id) { result = { error: "rule_id is required for update." }; }
                    else {
                        const body = {};
                        if (args.name) body.name = args.name;
                        if (args.evaluation_spec) body.evaluation_spec = JSON.stringify(args.evaluation_spec);
                        if (args.execution_spec) body.execution_spec = JSON.stringify(args.execution_spec);
                        if (args.schedule_spec) body.schedule_spec = JSON.stringify(args.schedule_spec);
                        if (args.status) body.status = args.status;
                        if (!confirm) {
                            result = { dry_run: true, message: "DRY RUN — set confirm=true to update", account: info.name, rule_id: args.rule_id, updates: body };
                        } else {
                            await metaPost(args.rule_id, body);
                            result = { success: true, account: info.name, rule_id: args.rule_id, updated_fields: Object.keys(body) };
                        }
                    }

                } else if (action === "delete") {
                    if (!args.rule_id) { result = { error: "rule_id is required for delete." }; }
                    else if (!confirm) {
                        result = { dry_run: true, message: "DRY RUN — set confirm=true to delete", account: info.name, rule_id: args.rule_id, warning: "This permanently deletes the rule." };
                    } else {
                        await metaDelete(args.rule_id);
                        result = { success: true, account: info.name, rule_id: args.rule_id, deleted: true };
                    }

                } else if (action === "preview") {
                    if (!args.rule_id) { result = { error: "rule_id is required for preview." }; }
                    else {
                        const data = await metaPost(`${args.rule_id}/preview`, {});
                        result = { account: info.name, rule_id: args.rule_id, preview: data };
                    }

                } else if (action === "execute") {
                    if (!args.rule_id) { result = { error: "rule_id is required for execute." }; }
                    else if (!confirm) {
                        result = { dry_run: true, message: "DRY RUN — set confirm=true to execute", account: info.name, rule_id: args.rule_id, warning: "This will run the rule immediately." };
                    } else {
                        const data = await metaPost(`${args.rule_id}/execute`, {});
                        result = { success: true, account: info.name, rule_id: args.rule_id, execution: data };
                    }

                } else if (action === "history") {
                    if (!args.rule_id) { result = { error: "rule_id is required for history." }; }
                    else {
                        const history = await metaGetAll(`${args.rule_id}/history`, {});
                        result = { account: info.name, rule_id: args.rule_id, total: history.length, entries: history.slice(0, 50) };
                    }
                } else {
                    result = { error: `Unknown action '${action}'. Valid: list, read, create, update, delete, preview, execute, history.` };
                }
            } catch (e) { result = { error: e.message }; }
        }

    } else if (name === "get_meta_ad_issues") {
        const search = (args.account_name || "").toLowerCase();
        const targets = Object.entries(META_ACCOUNTS).filter(([, info]) => !search || info.name.toLowerCase().includes(search));
        if (!targets.length) {
            result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
        } else {
            const accounts = [];
            let totalIssues = 0;
            let errorCount = 0;
            for (const [accountId, info] of targets) {
                try {
                    const ads = await metaGetAll(`${metaActId(accountId)}/ads`, {
                        fields: "id,name,status,effective_status,ad_review_feedback,campaign{name}",
                        filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["DISAPPROVED", "PENDING_REVIEW", "WITH_ISSUES"] }]),
                    });
                    if (ads.length) {
                        totalIssues += ads.length;
                        accounts.push({
                            account: info.name,
                            issue_count: ads.length,
                            ads: ads.map(a => ({
                                id: a.id, name: a.name, status: a.status,
                                effective_status: a.effective_status,
                                campaign: a.campaign?.name,
                                review_feedback: a.ad_review_feedback,
                            })),
                        });
                    }
                } catch (e) { errorCount++; accounts.push({ account: info.name, error: e.message }); }
            }
            const message = errorCount > 0
                ? `${errorCount} account(s) failed to check — results are incomplete.`
                : totalIssues === 0 ? "All Meta ads are approved and delivering." : `${totalIssues} ad(s) have issues.`;
            result = {
                checked: targets.length,
                errors: errorCount,
                total_issues: totalIssues,
                message,
                accounts,
            };
        }

    } else if (name === "get_meta_insights") {
        const search = (args.account_name || "").toLowerCase();
        const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!acctMatch) {
            result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
        } else {
            const [accountId, info] = acctMatch;
            try {
                const params = {
                    fields: "spend,impressions,clicks,ctr,cpc,cpm,actions,cost_per_action_type,reach,frequency",
                    breakdowns: args.breakdown,
                };
                const datePreset = args.date_preset || (args.start_date ? undefined : "last_30d");
                if (datePreset) params.date_preset = datePreset;
                if (args.start_date && args.end_date) {
                    params.time_range = JSON.stringify({ since: args.start_date, until: args.end_date });
                }
                const level = args.level || "account";
                let endpoint = `${metaActId(accountId)}/insights`;
                if (level === "campaign") endpoint = `${metaActId(accountId)}/insights`;
                if (args.campaign_name && level !== "account") {
                    params.filtering = JSON.stringify([{ field: "campaign.name", operator: "CONTAIN", value: args.campaign_name }]);
                }
                params.level = level;
                params.limit = 200;

                const rows = await metaGetAll(endpoint, params);
                const formatted = rows.map(r => {
                    const row = {
                        [args.breakdown]: r[args.breakdown],
                        spend: parseFloat(r.spend || 0),
                        impressions: parseInt(r.impressions || 0),
                        clicks: parseInt(r.clicks || 0),
                        ctr: parseFloat(r.ctr || 0),
                        cpc: parseFloat(r.cpc || 0),
                        cpm: parseFloat(r.cpm || 0),
                        reach: parseInt(r.reach || 0),
                    };
                    if (r.actions) {
                        for (const a of r.actions) {
                            row[`actions_${a.action_type}`] = parseInt(a.value);
                        }
                    }
                    if (r.cost_per_action_type) {
                        for (const a of r.cost_per_action_type) {
                            row[`cost_per_${a.action_type}`] = parseFloat(a.value);
                        }
                    }
                    if (level !== "account") {
                        row.campaign_name = r.campaign_name;
                        if (level === "adset" || level === "ad") row.adset_name = r.adset_name;
                        if (level === "ad") row.ad_name = r.ad_name;
                    }
                    return row;
                });
                result = { account: info.name, breakdown: args.breakdown, level, date_preset: datePreset, total_rows: formatted.length, rows: formatted };
            } catch (e) { result = { error: e.message }; }
        }

    } else if (name === "get_meta_ad_performance") {
        const search = (args.account_name || "").toLowerCase();
        const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!acctMatch) {
            result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
        } else {
            const [accountId, info] = acctMatch;
            const dateRange = args.date_range || "LAST_30_DAYS";
            if (dateRange === "CUSTOM" && (!args.start_date || !args.end_date)) {
                result = { error: "start_date and end_date are required when date_range is CUSTOM." };
            } else {
                const { startDate, endDate } = metaAdPerfDateRange(dateRange, args.start_date, args.end_date);
                try {
                    const params = {
                        fields: "ad_id,ad_name,adset_name,campaign_name,spend,impressions,clicks,ctr,cpc,cpm,reach,actions,cost_per_action_type,action_values",
                        time_range: JSON.stringify({ since: startDate, until: endDate }),
                        level: "ad",
                        limit: 100,
                    };
                    if (args.campaign_name) {
                        params.filtering = JSON.stringify([{ field: "campaign.name", operator: "CONTAIN", value: args.campaign_name }]);
                    }

                    const rows = await metaGetAll(`${metaActId(accountId)}/insights`, params);
                    const actionVal = (arr, type) => parseFloat((arr || []).find(a => a.action_type === type)?.value || 0);

                    // effective_object_story_id lives on the ad object, not the insights
                    // endpoint (Graph API rejects it as an insights field) — fetch it separately.
                    const storyIdByAdId = {};
                    const adIds = [...new Set(rows.map(r => r.ad_id).filter(Boolean))];
                    if (adIds.length) {
                        const adObjects = await metaGetAll(`${metaActId(accountId)}/ads`, {
                            fields: "id,effective_object_story_id",
                            filtering: JSON.stringify([{ field: "id", operator: "IN", value: adIds }]),
                            limit: 100,
                        });
                        for (const a of adObjects) storyIdByAdId[a.id] = a.effective_object_story_id;
                    }

                    const minSpend = args.min_spend || 0;
                    let ads = rows.map(r => {
                        const spend = parseFloat(r.spend || 0);
                        const purchases = actionVal(r.actions, "purchase");
                        const revenue = actionVal(r.action_values, "purchase");
                        const cpa = purchases > 0 ? spend / purchases : null;
                        const roas = spend > 0 ? revenue / spend : null;
                        return {
                            ad_name: r.ad_name,
                            adset_name: r.adset_name,
                            campaign_name: r.campaign_name,
                            effective_object_story_id: storyIdByAdId[r.ad_id] || null,
                            spend: Math.round(spend * 100) / 100,
                            impressions: parseInt(r.impressions || 0),
                            clicks: parseInt(r.clicks || 0),
                            ctr: parseFloat(r.ctr || 0),
                            cpc: parseFloat(r.cpc || 0),
                            cpm: parseFloat(r.cpm || 0),
                            reach: parseInt(r.reach || 0),
                            link_clicks: actionVal(r.actions, "link_click"),
                            landing_page_views: actionVal(r.actions, "landing_page_view"),
                            purchases,
                            post_engagement: actionVal(r.actions, "post_engagement"),
                            revenue: Math.round(revenue * 100) / 100,
                            cpa: cpa !== null ? Math.round(cpa * 100) / 100 : null,
                            roas: roas !== null ? Math.round(roas * 100) / 100 : null,
                        };
                    }).filter(ad => ad.spend >= minSpend);

                    const sortBy = args.sort_by || "spend";
                    const sortKey = sortBy === "purchases" ? "purchases" : sortBy;
                    ads.sort((a, b) => (b[sortKey] ?? -Infinity) - (a[sortKey] ?? -Infinity));

                    const totals = ads.reduce((acc, ad) => {
                        acc.spend += ad.spend;
                        acc.clicks += ad.clicks;
                        acc.impressions += ad.impressions;
                        acc.purchases += ad.purchases;
                        acc.revenue += ad.revenue;
                        return acc;
                    }, { spend: 0, clicks: 0, impressions: 0, purchases: 0, revenue: 0 });

                    result = {
                        account: info.name,
                        date_range: dateRange,
                        start_date: startDate,
                        end_date: endDate,
                        ads,
                        summary: {
                            total_spend: Math.round(totals.spend * 100) / 100,
                            total_clicks: totals.clicks,
                            total_impressions: totals.impressions,
                            total_purchases: totals.purchases,
                            total_revenue: Math.round(totals.revenue * 100) / 100,
                            blended_cpa: totals.purchases > 0 ? Math.round((totals.spend / totals.purchases) * 100) / 100 : null,
                            blended_roas: totals.spend > 0 ? Math.round((totals.revenue / totals.spend) * 100) / 100 : null,
                        },
                    };
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else if (name === "update_meta_object") {
        const search = (args.account_name || "").toLowerCase();
        const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!acctMatch) {
            result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
        } else {
            const [, info] = acctMatch;
            const confirm = !!args.confirm;
            const updates = args.updates || {};
            const body = { ...updates };
            const budgetFields = Object.keys(BUDGET_LIMITS);
            const budgetValues = {};
            for (const f of budgetFields) {
                if (body[f] !== undefined) budgetValues[f] = body[f];
            }
            const budgetErrors = validateBudgets(budgetValues);
            if (budgetErrors) {
                result = { error: budgetErrors.join(" | ") };
            } else {
                const budgetLines = budgetConfirmationSummary(budgetValues);
                for (const f of budgetFields) {
                    if (body[f] !== undefined) body[f] = Math.round(body[f] * 100);
                }
                if (body.bid_strategy === "BID_CAP") body.bid_strategy = "LOWEST_COST_WITH_BID_CAP";
                if (body.roas_control) {
                    body.bid_constraints = JSON.stringify({ roas_average_floor: Math.round(body.roas_control * 10000) });
                    delete body.roas_control;
                }
                if (!confirm) {
                    const dryRun = { dry_run: true, message: "DRY RUN — set confirm=true to apply", account: info.name, object_id: args.object_id, level: args.level, updates: body };
                    if (budgetLines.length) dryRun.budget_confirmation = "BUDGET CHANGES (in dollars):\n" + budgetLines.join("\n");
                    result = dryRun;
                } else if (budgetLines.length && !args.budget_confirmed) {
                    result = { error: "BUDGET CHANGE REQUIRES CONFIRMATION. Set budget_confirmed=true in addition to confirm=true. Budget changes:\n" + budgetLines.join("\n") };
                } else {
                    try {
                        await metaPost(args.object_id, body);
                        result = { success: true, account: info.name, object_id: args.object_id, level: args.level, updated_fields: Object.keys(updates) };
                        if (budgetLines.length) result.budget_applied = budgetLines.join(", ");
                    } catch (e) { result = { error: e.message }; }
                }
            }
        }

    } else if (name === "manage_meta_leads") {
        const search = (args.account_name || "").toLowerCase();
        const acctMatch = Object.entries(META_ACCOUNTS).find(([, info]) => info.name.toLowerCase().includes(search));
        if (!acctMatch) {
            result = { error: `No Meta account found matching '${args.account_name}'. Available: ${Object.values(META_ACCOUNTS).map(a => a.name).join(", ")}` };
        } else {
            const [, info] = acctMatch;
            const pageId = info.page_id;
            if (!pageId && args.action === "list_forms") {
                result = { error: `No page_id configured for '${info.name}'. Add page_id to accounts.json.` };
            } else {
                try {
                    if (args.action === "list_forms") {
                        const forms = await metaGetAll(`${pageId}/leadgen_forms`, {
                            fields: "id,name,status,leads_count,created_time,questions",
                        });
                        result = {
                            account: info.name, page_id: pageId, total: forms.length,
                            forms: forms.map(f => ({
                                id: f.id, name: f.name, status: f.status,
                                leads_count: f.leads_count, created_time: f.created_time,
                                questions: f.questions?.map(q => q.label || q.key),
                            })),
                        };
                    } else if (args.action === "get_leads") {
                        if (!args.form_id) { result = { error: "form_id is required for get_leads." }; }
                        else {
                            const limit = args.limit || 100;
                            const leads = await metaGetAll(`${args.form_id}/leads`, {
                                fields: "id,created_time,field_data,ad_id,ad_name",
                                limit,
                            });
                            result = {
                                account: info.name, form_id: args.form_id, total: leads.length,
                                leads: leads.slice(0, limit).map(l => ({
                                    id: l.id, created_time: l.created_time,
                                    ad_name: l.ad_name,
                                    fields: l.field_data?.reduce((acc, f) => { acc[f.name] = f.values?.join(", "); return acc; }, {}),
                                })),
                            };
                        }
                    } else {
                        result = { error: `Unknown action '${args.action}'. Valid: list_forms, get_leads.` };
                    }
                } catch (e) { result = { error: e.message }; }
            }
        }

    } else {
        result = { error: `Unknown tool: ${name}` };
    }

    // Every mutation gates on confirm=true, so this catches all confirmed writes
    if (args && args.confirm === true) logWriteAction(name, args, result);

    return result;
}

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
                let body;
                try {
                    body = JSON.parse(Buffer.concat(chunks).toString());
                } catch {
                    res.writeHead(400, { "Content-Type": "text/plain" });
                    res.end("Invalid JSON body");
                    return;
                }
                await transport.handlePostMessage(req, res, body);

            } else if (url.pathname === "/digest/run") {
                // Manual digest trigger. Auth is its own DIGEST_TRIGGER_TOKEN,
                // separate from MCP_AUTH_TOKEN, and fails closed when unset.
                const { handleDigestRequest } = require("./src/digest/schedule");
                await handleDigestRequest(req, res, url, {
                    resolve: (name) => (args) => handleToolCall(name, args),
                });

            } else if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
                // Streamable HTTP transport (stateless) — this is what claude.ai
                // custom connectors speak, so it's how Claude mobile reaches this
                // server. Each request gets its own transport + Server instance;
                // there is no session to resume or delete, hence 405 on GET/DELETE.
                // The connector UI can't set headers, so the token may ride the
                // query (?token=) or the path (/mcp/<token>).
                const pathToken = url.pathname.startsWith("/mcp/") ? decodeURIComponent(url.pathname.slice(5)) : null;
                if (!isAuthorized(req, url) && !(AUTH_TOKEN && pathToken === AUTH_TOKEN)) {
                    res.writeHead(401, { "Content-Type": "text/plain" });
                    res.end(AUTH_TOKEN ? "Unauthorized" : "Server auth not configured (MCP_AUTH_TOKEN missing)");
                    return;
                }
                if (req.method !== "POST") {
                    res.writeHead(405, { "Content-Type": "text/plain" });
                    res.end("Method not allowed — stateless /mcp only supports POST.");
                    return;
                }
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                let body;
                try {
                    body = JSON.parse(Buffer.concat(chunks).toString());
                } catch {
                    res.writeHead(400, { "Content-Type": "text/plain" });
                    res.end("Invalid JSON body");
                    return;
                }
                const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
                res.on("close", () => transport.close());
                const mcpServer = makeServer();
                await mcpServer.connect(transport);
                await transport.handleRequest(req, res, body);

            } else if (url.pathname === "/") {
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("KayComm MCP Server v2 — running" + (AUTH_TOKEN ? "" : " (auth not configured)"));

            } else {
                // 404 everything else. A 200 here made claude.ai's OAuth discovery
                // probes (/.well-known/*, /register) think this server had a
                // sign-in service, breaking custom-connector setup.
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("Not found");
            }
        });

        httpServer.listen(parseInt(PORT), () => {
            console.error(`KayComm MCP running on port ${PORT} (SSE mode: /sse + /messages; Streamable HTTP: /mcp; auth ${AUTH_TOKEN ? "enabled" : "NOT CONFIGURED"})`);
        });

        // ── Morning pacing digest ────────────────────────────────────────────
        // HTTP mode only. In stdio mode this process is a short-lived local
        // Claude Desktop child, so a 7am cron there would never fire (and if it
        // did, it would post a duplicate). Opt out with DIGEST_ENABLED=0.
        // resolve wires the digest straight into handleToolCall, skipping the
        // HTTP round trip and the MCP auth token.
        if (process.env.DIGEST_ENABLED !== "0") {
            try {
                const { registerDigest } = require("./src/digest/schedule");
                registerDigest({ resolve: (name) => (args) => handleToolCall(name, args) });
            } catch (err) {
                console.error("[digest] failed to register, server continues:", err.message);
            }
        }

        // ── Change event archiver ────────────────────────────────────────────
        // Daily sweep of change_event data into Postgres before the 30-day API
        // window closes. Opt out with ARCHIVE_ENABLED=0 or by not setting DATABASE_URL.
        if (process.env.ARCHIVE_ENABLED !== "0" && process.env.DATABASE_URL) {
            try {
                const cron = require("node-cron");
                const { collectAll } = require("./src/archive/change_collector");
                cron.schedule("0 6 * * *", async () => {
                    const started = Date.now();
                    try {
                        const results = await collectAll();
                        console.log(`[archive] completed in ${Date.now() - started}ms`, JSON.stringify(results));
                    } catch (err) {
                        console.error("[archive] run failed:", err);
                    }
                }, { timezone: "America/Chicago" });
                console.log("[archive] scheduled daily at 6:00 AM CT");
            } catch (err) {
                console.error("[archive] failed to register, server continues:", err.message);
            }
        }

        // Railway sends SIGTERM on every redeploy. Without this, node dies
        // instantly and in-flight requests / open SSE streams are severed.
        let shuttingDown = false;
        const shutdown = (sig) => {
            if (shuttingDown) return;
            shuttingDown = true;
            console.error(`Received ${sig} — draining connections, then exiting`);
            try { require("./src/archive/db").shutdown(); } catch (_) {}
            httpServer.close(() => process.exit(0));
            // Railway allows ~10s before SIGKILL; don't hang past that.
            setTimeout(() => {
                console.error("Drain timed out — forcing exit");
                process.exit(0);
            }, 10000).unref();
        };
        process.on("SIGTERM", () => shutdown("SIGTERM"));
        process.on("SIGINT", () => shutdown("SIGINT"));

    } else {
        // ── stdio mode (local Claude Desktop) ───────────────────────────────
        const transport = new StdioServerTransport();
        await server.connect(transport);
    }
}

module.exports = {
    handleToolCall,
    getPacingLabel, getFlightPacing, buildDailyBudgetRec, getDateInfo, getEffectiveBudget, pctChange,
    // Exported for tests
    clampTopN, shapeAgg, emptyAgg, addAgg, mergeAgg, listingCaseValueLabel, SHOPPING_GROUP_DIMENSIONS,
};

if (!process.env.MCP_TEST) main().catch(console.error);
