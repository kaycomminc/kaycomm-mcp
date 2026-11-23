process.env.MCP_TEST = "1";
const test = require("node:test");
const assert = require("node:assert/strict");

// server.js captures fetch at load, so install the fake first.
const realFetch = global.fetch;
let lastQuery, nextRows = [];
global.fetch = async (url, opts) => {
    lastQuery = JSON.parse(opts.body).query;
    return new Response(JSON.stringify({ results: nextRows }), { status: 200, headers: { "content-type": "application/json" } });
};
const { fetchPlacementPerformance, PLACEMENT_VIEWS } = require("../server.js");
const mockRows = rows => { nextRows = rows; };
test.after(() => { global.fetch = realFetch; });

const row = (name, placement, cost, impr, views, clicks = 0) => ({
    groupPlacementView: { displayName: name, placement, placementType: "YOUTUBE_CHANNEL", targetUrl: `https://youtube.com/${placement}` },
    metrics: { costMicros: String(cost * 1e6), impressions: String(impr), clicks: String(clicks), conversions: 0,
               videoTrueviewViews: String(views), },
});

test("placements: rolls up duplicate placements, sorts by spend, computes CPV", async () => {
    mockRows([row("Chan A", "a", 10, 1000, 100), row("Chan B", "b", 50, 4000, 250), row("Chan A", "a", 10, 1000, 100)]);
    const r = await fetchPlacementPerformance("t", "1", "2", "DURING THIS_MONTH", "channel", null, 50, 0);
    assert.equal(r.placements[0].name, "Chan B");
    assert.equal(r.placements[1].spend, 20);
    assert.equal(r.placements[1].views, 200);
    assert.equal(r.placements[1].cpv, 0.1);
    assert.equal(r.totals.placements_total, 2);
    assert.equal(r.totals.spend, 70);
});

test("placements: top_n truncates, min_impressions filters, flagged in returned", async () => {
    mockRows([row("A", "a", 10, 1000, 10), row("B", "b", 5, 10, 1), row("C", "c", 1, 500, 5)]);
    const r = await fetchPlacementPerformance("t", "1", "2", "DURING THIS_MONTH", "channel", null, 1, 100);
    assert.equal(r.placements.length, 1);
    assert.equal(r.returned.rows_matching, 2);
    assert.equal(r.returned.truncated, true);
});

test("placements: campaign filter is escaped in GAQL and view selects resource", async () => {
    mockRows([]);
    await fetchPlacementPerformance("t", "1", "2", "DURING THIS_MONTH", "detail", "O'Brien_%", 50, 0);
    assert.match(lastQuery, /FROM detail_placement_view/);
    assert.match(lastQuery, /group_placement_target_url/);
    assert.ok(lastQuery.includes("O\\'Brien\\_\\%"));
    assert.ok(PLACEMENT_VIEWS.channel);
});

test("placements: query omits quartile metrics (unsupported on placement views)", async () => {
    mockRows([]);
    await fetchPlacementPerformance("t", "1", "2", "DURING THIS_MONTH", "channel", null, 50, 0);
    assert.doesNotMatch(lastQuery, /quartile/);
});
