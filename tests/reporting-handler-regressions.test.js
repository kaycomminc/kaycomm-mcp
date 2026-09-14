process.env.MCP_TEST = "1";
const test = require("node:test");
const assert = require("node:assert/strict");

const realFetch = global.fetch;
const calls = [];
let failMetaSpend = false;
global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push(target);

    if (target.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    }
    if (target.includes("googleads.googleapis.com")) {
        const body = JSON.parse(options.body || "{}");
        const query = body.query || "";
        if (query.includes("campaign_budget")) return new Response(JSON.stringify({ results: [] }), { status: 200 });
        return new Response(JSON.stringify({ results: [{ metrics: { costMicros: "12000000" } }] }), { status: 200 });
    }
    if (target.includes("graph.facebook.com")) {
        if (target.includes("act_1172134603935325/campaigns")) {
            return new Response(JSON.stringify({ error: { message: "synthetic budget failure" } }), { status: 200 });
        }
        if (target.includes("/insights")) {
            if (failMetaSpend && target.includes("act_1172134603935325/")) return new Response("not-json", { status: 200 });
            return new Response(JSON.stringify({ data: [{ spend: "12" }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    throw new Error(`Unexpected mocked URL: ${target}`);
};

const { handleToolCall } = require("../server.js");
global.fetch = realFetch;

test("account detail and Meta pacing agree on a flight row and expose budget failure", async () => {
    const detail = await handleToolCall("get_account_detail", { account_name: "FAMU Online" });
    assert.equal(detail._meta.status, "partial_success");
    const detailMeta = detail.results.find(row => row.platform === "Meta");
    assert.equal(detailMeta.flight_spend, 12);
    assert.equal(detailMeta.status, "UNDERPACING");
    assert.deepEqual(detailMeta.period, {
        type: "flight", start_date: "2026-07-01", end_date: "2026-09-30", spend_through: "2026-09-13",
    });
    assert.deepEqual(detailMeta.daily_budget_error, { error: "synthetic budget failure", code: "BUDGET_FETCH_FAILED" });
    assert.equal(detailMeta.daily_budget, undefined);

    const pacing = await handleToolCall("get_meta_pacing", {});
    const pacingMeta = pacing.accounts.find(row => row.account === "FAMU Online");
    assert.equal(pacingMeta.flight_spend, detailMeta.flight_spend);
    assert.equal(pacingMeta.status, detailMeta.status);
    assert.deepEqual(pacingMeta.period, detailMeta.period);
    assert.deepEqual(pacingMeta.daily_budget_error, detailMeta.daily_budget_error);
});

test("empty and ambiguous account detail requests make zero upstream reads", async () => {
    const before = calls.length;
    const empty = await handleToolCall("get_account_detail", { account_name: "   " });
    assert.match(empty.error, /account_name (?:is required|must not be empty)/);
    const afterEmpty = calls.length;
    assert.equal(afterEmpty, before);

    const ambiguous = await handleToolCall("get_account_detail", { account_name: "a" });
    assert.match(ambiguous.error, /Ambiguous/);
    assert.equal(calls.length, afterEmpty);
});

test("a failed selected platform does not discard a successful platform row", async () => {
    failMetaSpend = true;
    const detail = await handleToolCall("get_account_detail", { account_name: "FAMU Online" });
    failMetaSpend = false;
    const meta = detail.results.find(row => row.platform === "Meta");
    const google = detail.results.find(row => row.platform === "Google");
    assert.match(meta.error, /Unexpected token|JSON/);
    assert.equal(google.mtd_spend, undefined);
    assert.equal(typeof google.error, "undefined");
    assert.ok(google.flight_spend >= 0);
});
