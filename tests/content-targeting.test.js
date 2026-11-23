process.env.MCP_TEST = "1";
process.env.ACCOUNTS_FILE = require("node:path").join(__dirname, "fixtures", "accounts-2026-10-25.json");
const test = require("node:test");
const assert = require("node:assert/strict");
const CT = require("../src/google-content-targeting");

const CONSTS = [
    { id: "19", path: ["Games"] },
    { id: "20", path: ["Games", "Roleplaying Games"] },
    { id: "21", path: ["Games", "Card Games"] },
    { id: "3", path: ["Arts & Entertainment"] },
];

test("resolveTopic: id, exact path, unique leaf, ambiguity and miss", () => {
    assert.equal(CT.resolveTopic("19", CONSTS).key, "TOPIC:19");
    assert.equal(CT.resolveTopic("/Games/Roleplaying Games", CONSTS).value, "20");
    assert.equal(CT.resolveTopic("card games", CONSTS).value, "21");
    assert.equal(CT.resolveTopic("Games", CONSTS).value, "19");          // exact leaf beats substring
    assert.throws(() => CT.resolveTopic("Game", CONSTS), /matches 3 topics/);
    assert.throws(() => CT.resolveTopic("nope", CONSTS), /No topic matching/);
    assert.throws(() => CT.resolveTopic("", CONSTS), /Empty/);
});

test("parseContentLabel: normalises, flags unknown labels, rejects junk", () => {
    assert.deepEqual(CT.parseContentLabel("juvenile"), { kind: "CONTENT_LABEL", value: "JUVENILE", key: "CONTENT_LABEL:JUVENILE", known: true });
    assert.equal(CT.parseContentLabel("live streaming video").value, "LIVE_STREAMING_VIDEO");
    assert.equal(CT.parseContentLabel("SOME_NEW_LABEL").known, false);
    assert.throws(() => CT.parseContentLabel("12 ; drop"), /not a valid content label/);
});

test("planAdd: topic + label operations per scope, existing skipped", () => {
    const targets = [CT.resolveTopic("20", CONSTS), CT.parseContentLabel("JUVENILE"), CT.parseContentLabel("JUVENILE")];
    const camp = CT.planAdd({ scope: "campaign", parentResource: "customers/1/campaigns/9", targets, existing: [{ key: "TOPIC:20" }], negative: true });
    assert.equal(camp.ops.length, 1);
    assert.deepEqual(camp.ops[0].campaignCriterionOperation.create, { contentLabel: { type: "JUVENILE" }, campaign: "customers/1/campaigns/9", negative: true });
    assert.equal(camp.skipped_already_present.length, 2);
    const acct = CT.planAdd({ scope: "account", targets: [CT.parseContentLabel("PROFANITY")], existing: [], negative: true });
    assert.deepEqual(acct.ops[0], { customerNegativeCriterionOperation: { create: { contentLabel: { type: "PROFANITY" } } } });
    const inc = CT.planAdd({ scope: "ad_group", parentResource: "customers/1/adGroups/5", targets: [CT.resolveTopic("20", CONSTS)], existing: [], negative: false });
    assert.deepEqual(inc.ops[0].adGroupCriterionOperation.create, { topic: { topicConstant: "topicConstants/20" }, adGroup: "customers/1/adGroups/5", negative: false });
});

test("planRemove + mapRow round trip", () => {
    const row = CT.mapRow("campaign", { campaignCriterion: { resourceName: "customers/1/campaignCriteria/9~4", negative: true, topic: { topicConstant: "topicConstants/20", path: ["Games", "Roleplaying Games"] } }, campaign: { name: "C" } });
    assert.equal(row.key, "TOPIC:20");
    assert.equal(row.label, "/Games/Roleplaying Games");
    const plan = CT.planRemove({ scope: "campaign", targets: [CT.resolveTopic("20", CONSTS), CT.parseContentLabel("PROFANITY")], existing: [row] });
    assert.deepEqual(plan.ops, [{ campaignCriterionOperation: { remove: "customers/1/campaignCriteria/9~4" } }]);
    assert.deepEqual(plan.not_found, ["CONTENT_LABEL: PROFANITY"]);
    assert.match(CT.contentQuery("account"), /customer_negative_criterion/);
    const ag = CT.contentQuery("ad_group", { adGroupId: 5 });
    assert.doesNotMatch(ag, /content_label/);
    assert.match(ag, /ad_group_criterion\.type = 'TOPIC'/);
});

// ── handler ─────────────────────────────────────────────────────────────────
const mutates = [];
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const realFetch = global.fetch;
global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("oauth2.googleapis.com/token")) return json({ access_token: "t", expires_in: 3600 });
    if (target.includes("googleAds:mutate")) { mutates.push(JSON.parse(options.body)); return json({ mutateOperationResponses: [{}] }); }
    if (target.includes("googleAds:search")) {
        const q = JSON.parse(options.body).query;
        if (q.includes("FROM topic_constant")) return json({ results: CONSTS.map(c => ({ topicConstant: c })) });
        if (q.includes("FROM campaign_criterion")) return json({ results: [] });
        if (q.includes("FROM campaign\n") || q.includes("FROM campaign ")) return json({ results: [{ campaign: { id: "9", name: "YT EN", status: "ENABLED", advertisingChannelType: "VIDEO", resourceName: "customers/1/campaigns/9" } }] });
        return json({ results: [] });
    }
    throw new Error(`Unexpected URL ${target}`);
};
const { handleToolCall } = require("../server.js");
global.fetch = realFetch;
const run = `c-${Date.now()}-${Math.random()}`;
const account = Object.values(require("./fixtures/accounts-2026-10-25.json").google)[0].name;

test("manage_content_targeting: dry run validates, confirm applies, topics resolved", async () => {
    mutates.length = 0;
    const base = { account_name: account, action: "exclude", campaign_name: "YT EN", topics: ["Roleplaying Games"], content_labels: ["juvenile"] };
    const dry = await handleToolCall("manage_content_targeting", base);
    assert.equal(dry.dry_run, true);
    assert.equal(dry.operations, 2);
    assert.equal(mutates[0].validateOnly, true);
    mutates.length = 0;
    const live = await handleToolCall("manage_content_targeting", { ...base, confirm: true, idempotency_key: run });
    assert.equal(live.success, true);
    assert.equal(mutates[0].validateOnly, undefined);
    assert.equal(mutates[0].mutateOperations.length, 2);
});

test("manage_content_targeting: guards (topics at account, label inclusion, inclusion level) and search_topics", async () => {
    const a = await handleToolCall("manage_content_targeting", { account_name: account, action: "exclude", level: "account", topics: ["19"] });
    assert.match(a.error, /Topics can't be set at account level/);
    const b = await handleToolCall("manage_content_targeting", { account_name: account, action: "include", level: "ad_group", content_labels: ["PROFANITY"] });
    assert.match(b.error, /only be excluded/);
    const c = await handleToolCall("manage_content_targeting", { account_name: account, action: "include", level: "campaign", topics: ["19"] });
    assert.match(c.error, /ad_group level only/);
    const d = await handleToolCall("manage_content_targeting", { account_name: account, action: "exclude", level: "ad_group", ad_group_name: "x", content_labels: ["JUVENILE"] });
    assert.match(d.error, /Content labels can't be set at ad_group level/);
    const s = await handleToolCall("manage_content_targeting", { account_name: account, action: "search_topics", query: "games" });
    assert.equal(s.topics.length, 3);
});
