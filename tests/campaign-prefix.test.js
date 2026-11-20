process.env.MCP_TEST = "1";
const test = require("node:test");
const assert = require("node:assert/strict");

// campaign_prefix scope: shared client accounts (e.g. PCL) where only "V9 - "
// campaigns are ours. Graph API is faked; server.js captures fetch at load.
const realFetch = global.fetch;
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
global.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/insights")) {
        return json({ data: [
            { campaign_name: "V9 - Search", spend: "12.50" },
            { campaign_name: "V9 - Retargeting", spend: "7.50" },
            { campaign_name: "PCL Recruitment", spend: "100" },
        ] });
    }
    if (target.includes("/campaigns")) {
        return json({ data: [
            { id: "c1", name: "V9 - Search", effective_status: "ACTIVE", daily_budget: "1000" },       // $10 CBO
            { id: "c2", name: "PCL Recruitment", effective_status: "ACTIVE", daily_budget: "5000" },   // $50, not ours
            { id: "c3", name: "V9 - ABO", effective_status: "ACTIVE" },
            { id: "c4", name: "PCL Hot Jobs", effective_status: "ACTIVE" },
        ] });
    }
    return json({ data: [
        { id: "s1", campaign_id: "c3", effective_status: "ACTIVE", daily_budget: "2000" }, // $20, ours
        { id: "s2", campaign_id: "c4", effective_status: "ACTIVE", daily_budget: "4000" }, // $40, not ours
    ] });
};
const { fetchMetaMTD, fetchMetaDailyBudgets, inCampaignScope } = require("../server.js");
global.fetch = realFetch;

test("inCampaignScope: no prefix keeps everything; prefix is a case-sensitive startsWith", () => {
    assert.equal(inCampaignScope("anything", null), true);
    assert.equal(inCampaignScope("V9 - Search", "V9 - "), true);
    assert.equal(inCampaignScope("PCL V9 - Search", "V9 - "), false);
    assert.equal(inCampaignScope(undefined, "V9 - "), false);
});

test("fetchMetaMTD with prefix sums only in-scope campaigns", async () => {
    const r = await fetchMetaMTD("act_scope", "2026-11-01", "2026-11-19", "V9 - ");
    assert.equal(r.error, null);
    assert.equal(r.spend, 20);
});

test("fetchMetaDailyBudgets with prefix skips out-of-scope campaigns and their ad sets", async () => {
    const scoped = await fetchMetaDailyBudgets("act_scope", "V9 - ");
    assert.equal(scoped.total, 30); // $10 c1 + $20 s1
    const all = await fetchMetaDailyBudgets("act_scope");
    assert.equal(all.total, 120);   // unscoped behaviour unchanged
});
