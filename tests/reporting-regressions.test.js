process.env.MCP_TEST = "1";
const test = require("node:test");
const assert = require("node:assert/strict");

// Keep this test independent of credentials and live APIs. server.js captures
// global.fetch at load time, so install a tiny Graph API fixture first.
const realFetch = global.fetch;
const calls = [];
let failPaging = false;
global.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (failPaging && target.includes("after=2")) {
        return new Response(JSON.stringify({ error: { message: "page unavailable" } }), { status: 200 });
    }
    const isCampaign = target.includes("/campaigns");
    const secondPage = target.includes("after=2");
    let body;
    if (isCampaign) {
        body = secondPage
            ? { data: [{ id: "c2", effective_status: "ACTIVE", lifetime_budget: "5000" }] }
            : { data: [{ id: "c1", effective_status: "ACTIVE", daily_budget: "1000" }], paging: { next: "https://graph.facebook.com/v25.0/act_test/campaigns?after=2" } };
    } else {
        body = secondPage
            ? { data: [{ id: "s2", campaign_id: "c3", effective_status: "ACTIVE", daily_budget: "3000" }] }
            : { data: [{ id: "s1", campaign_id: "c1", effective_status: "ACTIVE", daily_budget: "9000" }], paging: { next: "https://graph.facebook.com/v25.0/act_test/adsets?after=2" } };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

const {
    fetchMetaDailyBudgets, reportingPeriod, resolveAccount,
} = require("../server.js");
global.fetch = realFetch;

test("Meta daily budgets follow campaign and ad set cursors and dedupe CBO/ABO", async () => {
    const budgets = await fetchMetaDailyBudgets("act_test");
    assert.equal(budgets.total, 40); // $10 campaign + $30 standalone ad set
    assert.equal(budgets.has_lifetime_budgets, true);
    assert.equal(budgets.complete, true);
    assert.equal(calls.filter(url => url.includes("after=2")).length, 2);
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
