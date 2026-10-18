process.env.MCP_TEST = "1";
const test = require("node:test");
const assert = require("node:assert/strict");

// Keep this test independent of credentials and live APIs. server.js captures
// global.fetch at load time, so install a tiny Graph API fixture first.
const realFetch = global.fetch;
const calls = [];
let failPaging = false;
// Ten days out, so the conversion is stable whenever the test runs.
const lifeEnd = new Date(Date.now() + 9.5 * 86400000).toISOString();
global.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (failPaging && target.includes("after=2")) {
        return new Response(JSON.stringify({ error: { message: "page unavailable" } }), { status: 200 });
    }
    if (target.includes("/insights")) {
        // c6's lifetime spend; anything else (e.g. c7) fails the insights read
        const body = target.includes("/c6/") ? { data: [{ spend: "400" }] } : { error: { message: "insights unavailable" } };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("act_life/")) {
        const body = target.includes("/campaigns")
            ? { data: [{ id: "c6", effective_status: "ACTIVE", lifetime_budget: "100000", stop_time: lifeEnd }] }
            : { data: [{ id: "s6", campaign_id: "c8", effective_status: "ACTIVE", daily_budget: "1000" }] };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("act_lifefail/")) {
        const body = target.includes("/campaigns")
            ? { data: [{ id: "c7", effective_status: "ACTIVE", lifetime_budget: "100000", stop_time: lifeEnd }] }
            : { data: [] };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    const isCampaign = target.includes("/campaigns");
    const secondPage = target.includes("after=2");
    let body;
    if (isCampaign) {
        body = secondPage
            ? { data: [
                { id: "c2", effective_status: "ACTIVE", lifetime_budget: "5000" },
                // Completed flight: Meta leaves it ACTIVE after stop_time passes.
                { id: "c4", effective_status: "ACTIVE", daily_budget: "2000", stop_time: "2020-01-31T23:59:00-0500" },
            ] }
            : { data: [{ id: "c1", effective_status: "ACTIVE", daily_budget: "1000" }], paging: { next: "https://graph.facebook.com/v25.0/act_test/campaigns?after=2" } };
    } else {
        body = secondPage
            ? { data: [
                { id: "s2", campaign_id: "c3", effective_status: "ACTIVE", daily_budget: "3000" },
                { id: "s3", campaign_id: "c5", effective_status: "ACTIVE", daily_budget: "4000", end_time: "2020-01-31T23:59:00-0500" },
            ] }
            : { data: [{ id: "s1", campaign_id: "c1", effective_status: "ACTIVE", daily_budget: "9000" }], paging: { next: "https://graph.facebook.com/v25.0/act_test/adsets?after=2" } };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

const {
    fetchMetaDailyBudgets, reportingPeriod, resolveAccount, metaLifetimeDailyEquivalent,
} = require("../server.js");
global.fetch = realFetch;

test("Meta daily budgets follow campaign and ad set cursors and dedupe CBO/ABO", async () => {
    const budgets = await fetchMetaDailyBudgets("act_test");
    assert.equal(budgets.total, 40); // $10 campaign + $30 standalone ad set; ended c4/s3 excluded
    assert.equal(budgets.has_lifetime_budgets, true);
    // c2's lifetime budget has no stop_time, so it can't be converted to a daily figure
    assert.equal(budgets.lifetime_converted, false);
    assert.equal(budgets.complete, true);
    assert.equal(calls.filter(url => url.includes("after=2")).length, 2);
});

test("Meta lifetime budgets count as remaining budget over days left", async () => {
    const budgets = await fetchMetaDailyBudgets("act_life");
    // $10 daily ad set + ($1,000 − $400) / 10 days = $70
    assert.equal(budgets.lifetime_converted, true);
    assert.equal(budgets.lifetime_daily_equivalent, 60);
    assert.equal(Math.round(budgets.total * 100) / 100, 70);
});

test("a failed lifetime spend read falls back to the reduced-confidence flag", async () => {
    const budgets = await fetchMetaDailyBudgets("act_lifefail");
    assert.equal(budgets.has_lifetime_budgets, true);
    assert.equal(budgets.lifetime_converted, false);
    assert.equal(budgets.total, 0);
});

test("a failed Meta budget page rejects instead of producing a partial raise input", async () => {
    failPaging = true;
    await assert.rejects(fetchMetaDailyBudgets("act_test"), /page unavailable/);
    failPaging = false;
});

test("detail period uses the flight window, capped at spend-through", () => {
    assert.deepEqual(reportingPeriod({ flight_start: "2026-08-01", flight_end: "2026-08-31" }, "2026-09-01", "2026-08-20"), {
        type: "flight", start_date: "2026-08-01", end_date: "2026-08-31", spend_through: "2026-08-20",
    });
});

test("detail period identifies month-to-date explicitly", () => {
    assert.deepEqual(reportingPeriod({}, "2026-09-01", "2026-09-13"), {
        type: "month_to_date", start_date: "2026-09-01", end_date: "2026-09-13",
    });
});

test("detail account resolution refuses ambiguous requests before any read", () => {
    const accounts = { one: { name: "Acme Search" }, two: { name: "Acme Shopping" } };
    const resolved = resolveAccount(accounts, "Acme");
    assert.equal(resolved.match, undefined);
    assert.match(resolved.error, /Ambiguous/);
});

test("lifetime budget converts to remaining budget over days left, today included", () => {
    const now = Date.parse("2026-10-15T12:00:00-04:00");
    // $1,000 lifetime, $400 spent, ends Oct 31 23:59 → 17 days left → ~$35.29/day
    const eq = metaLifetimeDailyEquivalent("100000", "400", "2026-10-31T23:59:00-0400", now);
    assert.equal(Math.round(eq * 100) / 100, 35.29);
});

test("lifetime budget without an end date can't be converted", () => {
    assert.equal(metaLifetimeDailyEquivalent("100000", "0", undefined), null);
});

test("an overspent lifetime budget counts as $0/day, never negative", () => {
    const now = Date.parse("2026-10-15T12:00:00-04:00");
    assert.equal(metaLifetimeDailyEquivalent("50000", "650", "2026-10-31T23:59:00-0400", now), 0);
});
