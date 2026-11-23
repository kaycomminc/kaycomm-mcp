process.env.MCP_TEST = "1";
process.env.ACCOUNTS_FILE = require("node:path").join(__dirname, "fixtures", "accounts-2026-10-25.json");
const test = require("node:test");
const assert = require("node:assert/strict");

const CH = "UC0Z9Id3pirzJg7JVUmiyPPw";
const mutates = [];
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const realFetch = global.fetch;
global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("oauth2.googleapis.com/token")) return json({ access_token: "t", expires_in: 3600 });
    if (target.includes("googleAds:mutate")) { mutates.push(JSON.parse(options.body)); return json({ mutateOperationResponses: [{}] }); }
    if (target.includes("googleAds:search")) {
        const q = JSON.parse(options.body).query;
        if (q.includes("FROM campaign_criterion")) return json({ results: [{ campaign: { name: "YT EN" }, campaignCriterion: { resourceName: "customers/1/campaignCriteria/9~7", negative: true, youtubeChannel: { channelId: CH } } }] });
        if (q.includes("FROM campaign\n") || q.includes("FROM campaign ")) {
            return json({ results: [{ campaign: { id: "9", name: "YT EN", status: "ENABLED", advertisingChannelType: "VIDEO", resourceName: "customers/1/campaigns/9" } }] });
        }
        return json({ results: [] });
    }
    throw new Error(`Unexpected URL ${target}`);
};
const { handleToolCall } = require("../server.js");
global.fetch = realFetch;
const run = `t-${Date.now()}-${Math.random()}`;
const account = Object.values(require("./fixtures/accounts-2026-10-25.json").google)[0].name;

test("manage_placements: exclude dry run validates only; skips existing; confirm applies without validateOnly", async () => {
    mutates.length = 0;
    const base = { account_name: account, action: "exclude", campaign_name: "YT EN", placements: [CH, "UCYQo8CdhXD22qfwUBUw591Q"] };
    const dry = await handleToolCall("manage_placements", base);
    assert.equal(dry.dry_run, true);
    assert.deepEqual(dry.skipped_already_present, [CH]);
    assert.equal(dry.operations, 1);
    assert.equal(mutates.length, 1);
    assert.equal(mutates[0].validateOnly, true);

    mutates.length = 0;
    const live = await handleToolCall("manage_placements", { ...base, confirm: true, idempotency_key: `${run}-ex` });
    assert.equal(live.success, true);
    assert.equal(mutates.length, 1);
    assert.equal(mutates[0].validateOnly, undefined);
    assert.equal(mutates[0].mutateOperations[0].campaignCriterionOperation.create.negative, true);
});

test("manage_placements: inclusions are ad_group only; bad placements fail before any API call", async () => {
    const r1 = await handleToolCall("manage_placements", { account_name: account, action: "include", level: "campaign", campaign_name: "YT EN", placements: [CH] });
    assert.match(r1.error, /ad_group level only/);
    const r2 = await handleToolCall("manage_placements", { account_name: account, action: "exclude", campaign_name: "YT EN", placements: ["https://youtube.com/@bluey"] });
    assert.match(r2.error, /channel ID/);
});

test("manage_placements: list returns exclusions with totals; remove targets the resource", async () => {
    const list = await handleToolCall("manage_placements", { account_name: account, action: "list", campaign_name: "YT EN" });
    assert.equal(list.totals.exclusions, 1);
    assert.equal(list.exclusions[0].value, CH);
    mutates.length = 0;
    const rm = await handleToolCall("manage_placements", { account_name: account, action: "remove", campaign_name: "YT EN", placements: [CH], confirm: true, idempotency_key: `${run}-rm` });
    assert.equal(rm.success, true);
    assert.deepEqual(mutates[0].mutateOperations, [{ campaignCriterionOperation: { remove: "customers/1/campaignCriteria/9~7" } }]);
});
