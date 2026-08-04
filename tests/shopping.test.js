process.env.MCP_TEST = "1";
const test = require("node:test");
const assert = require("node:assert/strict");

const {
    clampTopN, shapeAgg, emptyAgg, addAgg, mergeAgg,
    listingCaseValueLabel, SHOPPING_GROUP_DIMENSIONS,
} = require("../server.js");

// Shapes the Google Ads REST API returns for a metrics row
const row = (costMicros, impressions, clicks, conversions, conversionsValue) => ({
    metrics: { costMicros: String(costMicros), impressions: String(impressions), clicks: String(clicks), conversions, conversionsValue },
});

// ── clampTopN ───────────────────────────────────────────────────────────────

test("clampTopN: falls back when unset", () => {
    assert.equal(clampTopN(undefined, 50), 50);
    assert.equal(clampTopN(null, 50), 50);
});

test("clampTopN: rejects zero, negatives and junk", () => {
    assert.equal(clampTopN(0, 50), 50);
    assert.equal(clampTopN(-10, 50), 50);
    assert.equal(clampTopN("abc", 50), 50);
});

test("clampTopN: honours a valid value and accepts numeric strings", () => {
    assert.equal(clampTopN(10, 50), 10);
    assert.equal(clampTopN("25", 50), 25);
});

test("clampTopN: caps at the hard maximum so a payload cannot blow up", () => {
    assert.equal(clampTopN(100000, 50), 500);
});

// ── aggregation ─────────────────────────────────────────────────────────────

test("addAgg: sums micros into dollars and parses string counters", () => {
    const agg = emptyAgg();
    addAgg(agg, row(1_500_000, 100, 10, 2, 250.5));
    addAgg(agg, row(500_000, 50, 5, 1, 100));
    assert.equal(agg.spend, 2);
    assert.equal(agg.impressions, 150);
    assert.equal(agg.clicks, 15);
    assert.equal(agg.conversions, 3);
    assert.equal(agg.conv_value, 350.5);
});

test("addAgg: missing metrics are treated as zero, not NaN", () => {
    const agg = emptyAgg();
    addAgg(agg, { metrics: {} });
    addAgg(agg, {});
    assert.deepEqual(agg, emptyAgg());
});

test("mergeAgg: adds one aggregate into another", () => {
    const a = emptyAgg(); const b = emptyAgg();
    addAgg(a, row(1_000_000, 10, 1, 1, 5));
    addAgg(b, row(2_000_000, 20, 3, 2, 15));
    mergeAgg(a, b);
    assert.equal(a.spend, 3);
    assert.equal(a.clicks, 4);
    assert.equal(a.conv_value, 20);
});

// ── shapeAgg — derived metrics come from the totals, never averaged ─────────

test("shapeAgg: derives CTR, CPC, CPA and ROAS from summed totals", () => {
    const agg = emptyAgg();
    addAgg(agg, row(100_000_000, 10000, 500, 25, 1000));
    const s = shapeAgg(agg);
    assert.equal(s.spend, 100);
    assert.equal(s.ctr, "5.00%");        // 500/10000
    assert.equal(s.avg_cpc, "$0.20");    // 100/500
    assert.equal(s.cpa, "$4");           // 100/25
    assert.equal(s.roas, 10);            // 1000/100
});

test("shapeAgg: CTR is recomputed from the rollup, not averaged per row", () => {
    // 1 click / 1000 impr  +  99 clicks / 1000 impr  →  100/2000 = 5.00%
    const agg = emptyAgg();
    addAgg(agg, row(0, 1000, 1, 0, 0));
    addAgg(agg, row(0, 1000, 99, 0, 0));
    assert.equal(shapeAgg(agg).ctr, "5.00%");
});

test("shapeAgg: no divide-by-zero on an empty aggregate", () => {
    const s = shapeAgg(emptyAgg());
    assert.equal(s.ctr, "0.00%");
    assert.equal(s.avg_cpc, "$0.00");
    assert.equal(s.cpa, null);
    assert.equal(s.roas, null);
});

test("shapeAgg: spend with no conversions yields null CPA and ROAS", () => {
    const agg = emptyAgg();
    addAgg(agg, row(50_000_000, 1000, 100, 0, 0));
    const s = shapeAgg(agg);
    assert.equal(s.spend, 50);
    assert.equal(s.cpa, null);
    assert.equal(s.roas, null);
});

// ── group_by dimension mapping ──────────────────────────────────────────────

test("SHOPPING_GROUP_DIMENSIONS: custom labels map to product_custom_attribute", () => {
    // There is no segments.product_custom_label* field in the Google Ads API.
    for (let i = 0; i <= 4; i++) {
        const dim = SHOPPING_GROUP_DIMENSIONS[`custom_label_${i}`];
        assert.equal(dim.field, `segments.product_custom_attribute${i}`);
        assert.equal(dim.key, `productCustomAttribute${i}`);
    }
});

test("SHOPPING_GROUP_DIMENSIONS: product_type maps to the levelled l1 field", () => {
    assert.equal(SHOPPING_GROUP_DIMENSIONS.product_type.field, "segments.product_type_l1");
    assert.equal(SHOPPING_GROUP_DIMENSIONS.product_type.key, "productTypeL1");
});

test("SHOPPING_GROUP_DIMENSIONS: every entry has a GAQL field and a response key", () => {
    for (const [name, dim] of Object.entries(SHOPPING_GROUP_DIMENSIONS)) {
        assert.ok(dim.field.startsWith("segments."), `${name} field`);
        assert.ok(dim.key && !dim.key.includes("_"), `${name} key must be camelCase`);
    }
});

// ── listing group case values ───────────────────────────────────────────────

test("listingCaseValueLabel: root node has no case value", () => {
    assert.equal(listingCaseValueLabel(null), null);
    assert.equal(listingCaseValueLabel(undefined), null);
});

test("listingCaseValueLabel: item id, brand and product type", () => {
    assert.equal(listingCaseValueLabel({ productItemId: { value: "WOCA-123" } }), "item_id = WOCA-123");
    assert.equal(listingCaseValueLabel({ productBrand: { value: "Woca" } }), "brand = Woca");
    assert.equal(
        listingCaseValueLabel({ productType: { value: "Oils", level: "LEVEL2" } }),
        "product_type_level2 = Oils",
    );
});

test("listingCaseValueLabel: custom attribute index maps to the feed's custom label", () => {
    assert.equal(
        listingCaseValueLabel({ productCustomAttribute: { value: "bestseller", index: "INDEX3" } }),
        "custom_label_3 = bestseller",
    );
});

test("listingCaseValueLabel: a dimension with no value is the 'everything else' node", () => {
    assert.equal(listingCaseValueLabel({ productBrand: {} }), "brand = (everything else)");
    assert.equal(listingCaseValueLabel({ productItemId: { value: "" } }), "item_id = (everything else)");
});

test("listingCaseValueLabel: condition and channel", () => {
    assert.equal(listingCaseValueLabel({ productCondition: { condition: "NEW" } }), "condition = NEW");
    assert.equal(listingCaseValueLabel({ productChannel: { channel: "ONLINE" } }), "channel = ONLINE");
});
