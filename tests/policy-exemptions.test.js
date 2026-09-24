process.env.MCP_TEST = "1";
const test = require("node:test");
const assert = require("node:assert/strict");

// Programmable Google Ads mock: each test queues responses and inspects request bodies.
const realFetch = global.fetch;
let queue = [];
const bodies = [];
global.fetch = async (url, options = {}) => {
    bodies.push(JSON.parse(options.body || "{}"));
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected request: ${url}`);
    return new Response(JSON.stringify(next.body), { status: next.status });
};
const { collectPolicyViolations, googleAdsError, createGoogleCampaignFull, addKeywordsToAdGroup } = require("../server.js");
global.fetch = realFetch;

test.beforeEach(() => { queue = []; bodies.length = 0; });

function policyError(index, text, { exemptible = true, field = "mutate_operations" } = {}) {
    return {
        errorCode: { policyViolationError: "POLICY_ERROR" },
        message: "A policy was violated. See PolicyViolationDetails for more detail.",
        location: { fieldPathElements: [{ fieldName: field, index }, { fieldName: "keyword" }] },
        details: { policyViolationDetails: {
            externalPolicyName: "Healthcare and medicines",
            key: { policyName: "HEALTH_IN_PERSONALIZED_ADS", violatingText: text },
            isExemptible: exemptible,
        } },
    };
}
const failure = (...errors) => ({ status: 400, body: { error: { message: "Request contains an invalid argument.", details: [{ errors }] } } });

const config = {
    campaign_name: "Lasik - Tallahassee",
    daily_budget: 15,
    bidding_strategy: "MAXIMIZE_CLICKS",
    geo_targets: [200530],
    ad_groups: [{ name: "LASIK Tallahassee", keywords: [
        { text: "lasik tallahassee", match_type: "EXACT" },        // op 3
        { text: "eye doctor tallahassee", match_type: "EXACT" },   // op 4
        { text: "lasik surgery tallahassee", match_type: "PHRASE" }, // op 5
    ] }],
};

test("collectPolicyViolations groups keys by op and only allows retry when every error is exemptible policy", () => {
    const ok = collectPolicyViolations(failure(policyError(3, "lasik"), policyError(3, "surgery"), policyError(5, "surgery")).body);
    assert.equal(ok.retryable, true);
    assert.deepEqual([...ok.byOp.keys()], [3, 5]);
    assert.equal(ok.byOp.get(3).keys.length, 2);

    assert.equal(collectPolicyViolations(failure(policyError(3, "x", { exemptible: false })).body).retryable, false);
    const mixed = failure(policyError(3, "x"), { errorCode: { fieldError: "REQUIRED" }, message: "missing", location: { fieldPathElements: [{ fieldName: "mutate_operations", index: 1 }] } });
    assert.equal(collectPolicyViolations(mixed.body).retryable, false);
});

test("googleAdsError names the policy and violating text", () => {
    const msg = googleAdsError(failure(policyError(3, "lasik")).body);
    assert.match(msg, /policy: Healthcare and medicines; text: "lasik"; exemptible/);
    assert.match(msg, /at mutate_operations\[3\]\.keyword/);
});

test("createGoogleCampaignFull retries with exemptions on only the flagged keyword ops", async () => {
    queue.push(failure(policyError(3, "lasik"), policyError(5, "surgery")));
    queue.push({ status: 200, body: { mutateOperationResponses: [
        { campaignBudgetResult: { resourceName: "customers/1/campaignBudgets/9" } },
        { campaignResult: { resourceName: "customers/1/campaigns/8" } },
    ] } });

    const res = await createGoogleCampaignFull("t", "1", "1", config);
    assert.equal(bodies.length, 2);
    const ops = bodies[1].mutateOperations;
    assert.equal(ops[3].adGroupCriterionOperation.exemptPolicyViolationKeys[0].violatingText, "lasik");
    assert.equal(ops[4].adGroupCriterionOperation.exemptPolicyViolationKeys, undefined);
    assert.equal(ops[5].adGroupCriterionOperation.exemptPolicyViolationKeys[0].violatingText, "surgery");
    assert.equal(res.campaign_resource, "customers/1/campaigns/8");
    assert.deepEqual(res.policy_exemptions_requested.map(e => e.text), ["lasik tallahassee", "lasik surgery tallahassee"]);
});

test("createGoogleCampaignFull does not retry non-exemptible violations and passes validateOnly through", async () => {
    queue.push(failure(policyError(3, "lasik", { exemptible: false })));
    await assert.rejects(createGoogleCampaignFull("t", "1", "1", { ...config, validate_only: true }), /not exemptible/);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].validateOnly, true);
});

test("addKeywordsToAdGroup sends each keyword only its own exemption keys", async () => {
    queue.push(failure(policyError(1, "surgery", { field: "operations" })));
    queue.push({ status: 200, body: { results: [{ resourceName: "a" }, { resourceName: "b" }] } });
    await addKeywordsToAdGroup("t", "1", "1", "customers/1/adGroups/2", [
        { text: "lasik doctor", match_type: "EXACT" },
        { text: "lasik surgery", match_type: "EXACT" },
    ]);
    const ops = bodies[1].operations;
    assert.equal(ops[0].exemptPolicyViolationKeys, undefined);
    assert.equal(ops[1].exemptPolicyViolationKeys[0].violatingText, "surgery");
});
