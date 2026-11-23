process.env.MCP_TEST = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const PL = require("../src/google-placements");

const CH = "UC0Z9Id3pirzJg7JVUmiyPPw";
const CH2 = "UCYQo8CdhXD22qfwUBUw591Q";

test("parsePlacement: detects channel ID, channel URL, video URL/ID, domain, app", () => {
    assert.deepEqual(PL.parsePlacement(CH), { type: "YOUTUBE_CHANNEL", value: CH, key: `YOUTUBE_CHANNEL:${CH.toLowerCase()}` });
    assert.equal(PL.parsePlacement(`https://www.youtube.com/channel/${CH}`).value, CH);
    assert.equal(PL.parsePlacement("https://youtu.be/b-LpXnF7UYg").type, "YOUTUBE_VIDEO");
    assert.equal(PL.parsePlacement("https://www.youtube.com/watch?v=b-LpXnF7UYg&t=3").value, "b-LpXnF7UYg");
    assert.equal(PL.parsePlacement("b-LpXnF7UYg").type, "YOUTUBE_VIDEO");
    const w = PL.parsePlacement("https://www.Example.com/path/");
    assert.equal(w.type, "WEBSITE");
    assert.equal(w.value, "example.com/path");
    assert.equal(PL.parsePlacement("mobileapp::1-com.kids.game").type, "MOBILE_APP");
});

test("parsePlacement: rejects handles, junk, bad IDs and unknown types", () => {
    assert.throws(() => PL.parsePlacement("https://youtube.com/@bluey"), /channel ID/);
    assert.throws(() => PL.parsePlacement("   "), /Empty/);
    assert.throws(() => PL.parsePlacement("notadomain"), /not a valid website/);
    assert.throws(() => PL.parsePlacement("UCshort", "YOUTUBE_CHANNEL"), /not a valid YouTube channel/);
    assert.throws(() => PL.parsePlacement("x.com", "NOPE"), /Unknown placement_type/);
    assert.throws(() => PL.parsePlacement("mobileapp::bad", "MOBILE_APP"), /not a valid app ID/);
});

test("planAdd: campaign exclusion builds negative criteria and skips existing/dupes", () => {
    const placements = [CH, CH, CH2, "spam.com"].map(x => PL.parsePlacement(x));
    const existing = [{ resource_name: "r1", key: PL.parsePlacement(CH2).key }];
    const plan = PL.planAdd({ scope: "campaign", parentResource: "customers/1/campaigns/9", placements, existing, negative: true });
    assert.equal(plan.ops.length, 2);
    assert.deepEqual(plan.ops[0], { campaignCriterionOperation: { create: { youtubeChannel: { channelId: CH }, campaign: "customers/1/campaigns/9", negative: true } } });
    assert.deepEqual(plan.ops[1].campaignCriterionOperation.create.placement, { url: "spam.com" });
    assert.deepEqual(plan.skipped_already_present, [CH, CH2]);
});

test("planAdd: ad group inclusion is positive, carries cpc bid; account scope has no parent/negative flag", () => {
    const inc = PL.planAdd({ scope: "ad_group", parentResource: "customers/1/adGroups/5", placements: [PL.parsePlacement(CH)], existing: [], negative: false, cpcBidMicros: 500000 });
    assert.deepEqual(inc.ops[0].adGroupCriterionOperation.create, { youtubeChannel: { channelId: CH }, adGroup: "customers/1/adGroups/5", negative: false, cpcBidMicros: "500000" });
    const acct = PL.planAdd({ scope: "account", placements: [PL.parsePlacement(CH)], existing: [], negative: true });
    assert.deepEqual(acct.ops[0], { customerNegativeCriterionOperation: { create: { youtubeChannel: { channelId: CH } } } });
});

test("planRemove: removes matches by resource name, reports not found", () => {
    const existing = [{ resource_name: "customers/1/campaignCriteria/9~7", key: PL.parsePlacement(CH).key }];
    const plan = PL.planRemove({ scope: "campaign", placements: [PL.parsePlacement(CH), PL.parsePlacement(CH2)], existing });
    assert.deepEqual(plan.ops, [{ campaignCriterionOperation: { remove: "customers/1/campaignCriteria/9~7" } }]);
    assert.deepEqual(plan.not_found, [CH2]);
});

test("mapRow + placementQuery: maps each criterion type per scope", () => {
    const row = { campaignCriterion: { resourceName: "rn", negative: true, youtubeChannel: { channelId: CH } }, campaign: { name: "C" } };
    const m = PL.mapRow("campaign", row);
    assert.equal(m.type, "YOUTUBE_CHANNEL");
    assert.equal(m.negative, true);
    assert.equal(PL.mapRow("account", { customerNegativeCriterion: { resourceName: "x", placement: { url: "A.com" } } }).key, "WEBSITE:a.com");
    assert.equal(PL.mapRow("campaign", { campaignCriterion: { resourceName: "x" } }), null);
    assert.match(PL.placementQuery("ad_group", { adGroupId: 5 }), /FROM ad_group_criterion[\s\S]*ad_group.id = 5/);
    assert.match(PL.placementQuery("account"), /FROM customer_negative_criterion/);
});
