process.env.MCP_TEST = "1";
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildPmaxChannelReport, pmaxChannelName } = require("../server.js");

// Shapes the Google Ads REST API returns for campaign rows
const metrics = (dollars, conversions = 0, conversionsValue = 0) => ({
    costMicros: String(Math.round(dollars * 1_000_000)), impressions: "100", clicks: "10", conversions, conversionsValue,
});
const chanRow = (name, network, product, video, dollars, conv, value) => ({
    campaign: { name }, segments: { adNetworkType: network, adUsingProductData: product, adUsingVideo: video },
    metrics: metrics(dollars, conv, value),
});
const campRow = (name, dollars, conv, value) => ({ campaign: { name }, metrics: metrics(dollars, conv, value) });
const vtcRow  = (name, network, vtc) => ({ campaign: { name }, segments: { adNetworkType: network }, metrics: { viewThroughConversions: vtc } });

test("pmaxChannelName: Shopping is SEARCH + product data; CONTENT is Display", () => {
    assert.equal(pmaxChannelName("SEARCH", true), "Shopping");
    assert.equal(pmaxChannelName("SEARCH", false), "Search");
    assert.equal(pmaxChannelName("CONTENT", true), "Display");
    assert.equal(pmaxChannelName("SEARCH_PARTNERS", true), "Search Partners");
    assert.equal(pmaxChannelName("MIXED", false), "Unattributed");
    assert.equal(pmaxChannelName("SOMETHING_NEW", false), "Unattributed");
});

test("buildPmaxChannelReport: splits channels, shares, display summary and reconciles", () => {
    const report = buildPmaxChannelReport(
        [
            chanRow("PMax A", "SEARCH",  false, false, 60, 6, 600),
            chanRow("PMax A", "SEARCH",  true,  false, 20, 2, 200),
            chanRow("PMax A", "CONTENT", true,  false, 15, 1, 30),
            chanRow("PMax A", "CONTENT", false, false,  5, 0, 0),
        ],
        [vtcRow("PMax A", "CONTENT", 4), vtcRow("PMax A", "SEARCH", 1)],
        [campRow("PMax A", 100, 9, 830)],
    );
    const ch = Object.fromEntries(report.account_rollup.channels.map(c => [c.channel, c]));
    assert.equal(ch.Search.spend, 60);
    assert.equal(ch.Shopping.spend, 20);
    assert.equal(ch.Display.spend, 20);
    assert.deepEqual(ch.Display.format_split, { product_ads: 15, video_ads: 0, other: 5 });
    assert.equal(ch.Display.view_through_conversions, 4);
    assert.equal(ch.Search.view_through_conversions, 1);       // SEARCH VTC lands on Search
    assert.equal(ch.Display.share_of_spend, "20.0%");
    assert.equal(ch.Search.share_of_conversions, "66.7%");
    assert.equal(report.display_summary.spend, 20);
    assert.equal(report.display_summary.roas, 1.5);
    assert.equal(report.reconciliation.difference, 0);
    assert.equal(report.reconciliation.flagged, false);
    assert.equal(report.unattributed_only, false);
});

test("buildPmaxChannelReport: flags MIXED rows and spend missing from the channel query", () => {
    const report = buildPmaxChannelReport(
        [chanRow("PMax A", "SEARCH", false, false, 80, 1, 10), chanRow("PMax A", "MIXED", false, false, 5, 0, 0)],
        null,
        [campRow("PMax A", 100, 1, 10)],
    );
    const rec = report.reconciliation;
    assert.equal(rec.unknown_channel_spend, 5);
    assert.equal(rec.difference, 15);
    assert.equal(rec.total_unattributed_spend, 20);
    assert.equal(rec.flagged, true);
    assert.equal(report.account_rollup.channels[0].view_through_conversions, null);   // VTC query failed
    assert.equal(report.display_summary.spend, 0);
});

test("buildPmaxChannelReport: all-MIXED data is reported as unattributed_only", () => {
    const report = buildPmaxChannelReport([chanRow("PMax A", "MIXED", false, false, 50)], [], [campRow("PMax A", 50)]);
    assert.equal(report.unattributed_only, true);
});

test("buildPmaxChannelReport: campaign filter is a case-insensitive substring", () => {
    const report = buildPmaxChannelReport(
        [chanRow("PMax_Non Brand", "SEARCH", false, false, 10), chanRow("PMax_All products", "SEARCH", false, false, 90)],
        [],
        [campRow("PMax_Non Brand", 10), campRow("PMax_All products", 90)],
        "non brand",
    );
    assert.deepEqual(report.campaigns.map(c => c.campaign), ["PMax_Non Brand"]);
    assert.equal(report.account_rollup.totals.spend, 10);
});
