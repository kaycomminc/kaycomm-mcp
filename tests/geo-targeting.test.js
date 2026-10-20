process.env.MCP_TEST = "1";
const test = require("node:test");
const assert = require("node:assert/strict");

// Capture mutate bodies from the campaign creators
const realFetch = global.fetch;
const bodies = [];
global.fetch = async (url, options = {}) => {
    bodies.push(JSON.parse(options.body || "{}"));
    return new Response(JSON.stringify({ mutateOperationResponses: [] }), { status: 200 });
};
const {
    normalizeGeoTargetSpec, buildGeoCriterion, shapeGeoCriteria, geoTargetToSpec, planGeoTargetingChange,
    describeGeoSpec, parseProximityAddress, createGoogleCampaignFull, createPmaxCampaignFull, createVideoCampaignFull,
} = require("../server.js");
global.fetch = realFetch;

test.beforeEach(() => { bodies.length = 0; });

const CAMP = "customers/9040402786/campaigns/23571836626";

// campaign_criterion rows as the REST API returns them (Alderwood "Neuropsychological Evaluations")
const locationRow = (id, negative = false) => ({
    campaignCriterion: {
        resourceName: `${CAMP.replace("campaigns/", "campaignCriteria/")}~${id}`,
        type: "LOCATION", negative,
        location: { geoTargetConstant: `geoTargetConstants/${id}` },
    },
});
const proximityRow = (critId, lat, lng, radius, units = "MILES") => ({
    campaignCriterion: {
        resourceName: `${CAMP.replace("campaigns/", "campaignCriteria/")}~${critId}`,
        type: "PROXIMITY", negative: false,
        proximity: {
            radius, radiusUnits: units,
            geoPoint: { latitudeInMicroDegrees: Math.round(lat * 1e6), longitudeInMicroDegrees: Math.round(lng * 1e6) },
            address: { streetAddress: "10724 Carmel Commons Blvd, Charlotte, NC 28226" },
        },
    },
});
const names = { "geoTargetConstants/1021048": { name: "Charlotte", canonical_name: "Charlotte,North Carolina,United States", target_type: "City" } };
const geo = (targets, positive = "PRESENCE") => ({ targets, geo_target_type: { positive, negative: "PRESENCE" } });

test("normalizeGeoTargetSpec: IDs, resource names, and location names", () => {
    assert.deepEqual(normalizeGeoTargetSpec(1021048), { kind: "location", geo_target_constant: "geoTargetConstants/1021048", negative: false });
    assert.deepEqual(normalizeGeoTargetSpec("2840"), { kind: "location", geo_target_constant: "geoTargetConstants/2840", negative: false });
    assert.equal(normalizeGeoTargetSpec("geoTargetConstants/2840").geo_target_constant, "geoTargetConstants/2840");
    assert.deepEqual(normalizeGeoTargetSpec("Mesa, AZ"), { kind: "location", name: "Mesa, AZ", negative: false });
    assert.equal(normalizeGeoTargetSpec({ geo_target_constant: 1021048, negative: true }).negative, true);
    assert.equal(normalizeGeoTargetSpec({ id: "2840" }).geo_target_constant, "geoTargetConstants/2840");
});

test("normalizeGeoTargetSpec: radius targets by lat/lng or address, units aliases", () => {
    assert.deepEqual(normalizeGeoTargetSpec({ lat: 35.086073, lng: -80.851883, radius: 15, units: "miles" }),
        { kind: "proximity", radius: 15, units: "MILES", lat: 35.086073, lng: -80.851883 });
    assert.equal(normalizeGeoTargetSpec({ latitude: 1, longitude: 2, radius: 5, radius_units: "km" }).units, "KILOMETERS");
    assert.equal(normalizeGeoTargetSpec({ lat: 1, lng: 2, radius: 5 }).units, "MILES");   // default
    const a = normalizeGeoTargetSpec({ address: "10724 Carmel Commons Blvd, Charlotte, NC 28226", radius: 10 });
    assert.deepEqual(a.address, { streetAddress: "10724 Carmel Commons Blvd", cityName: "Charlotte", provinceCode: "NC", countryCode: "US", postalCode: "28226" });
    assert.equal(a.lat, undefined);
});

test("normalizeGeoTargetSpec: rejects bad radius specs", () => {
    assert.throws(() => normalizeGeoTargetSpec({ lat: 1, lng: 2, radius: 0 }), /positive radius/);
    assert.throws(() => normalizeGeoTargetSpec({ lat: 1, lng: 2, radius: 5, units: "FEET" }), /MILES or KILOMETERS/);
    assert.throws(() => normalizeGeoTargetSpec({ lat: 95, lng: 2, radius: 5 }), /invalid lat\/lng/);
    assert.throws(() => normalizeGeoTargetSpec({ radius: 5 }), /lat\/lng or an address/);
    assert.throws(() => normalizeGeoTargetSpec({ lat: 1, lng: 2, radius: 5, negative: true }), /negative/);
    assert.throws(() => normalizeGeoTargetSpec({ address: "somewhere nice", radius: 5 }), /Can't parse address/);
});

test("parseProximityAddress: object input accepts snake_case and drops empties", () => {
    assert.deepEqual(parseProximityAddress({ street_address: "1 Main St", city_name: "Charlotte", province_code: "NC", postal_code: "" }),
        { streetAddress: "1 Main St", cityName: "Charlotte", provinceCode: "NC", countryCode: "US" });
});

test("buildGeoCriterion: proximity uses micro-degree geoPoint; address only without lat/lng; negative locations", () => {
    assert.deepEqual(buildGeoCriterion(CAMP, normalizeGeoTargetSpec({ lat: 35.086073, lng: -80.851883, radius: 15 })), {
        campaign: CAMP,
        proximity: { radius: 15, radiusUnits: "MILES", geoPoint: { latitudeInMicroDegrees: 35086073, longitudeInMicroDegrees: -80851883 } },
    });
    const byAddr = buildGeoCriterion(CAMP, normalizeGeoTargetSpec({ address: "1 Main St, Charlotte, NC", radius: 3, units: "KILOMETERS" }));
    assert.equal(byAddr.proximity.address.cityName, "Charlotte");
    assert.equal(byAddr.proximity.geoPoint, undefined);
    assert.deepEqual(buildGeoCriterion(CAMP, normalizeGeoTargetSpec({ geo_target_constant: 2840, negative: true })),
        { campaign: CAMP, location: { geoTargetConstant: "geoTargetConstants/2840" }, negative: true });
    assert.throws(() => buildGeoCriterion(CAMP, normalizeGeoTargetSpec("Mesa, AZ")), /not resolved/);
});

test("shapeGeoCriteria: returns LOCATION and PROXIMITY rows, negatives flagged", () => {
    const out = shapeGeoCriteria([locationRow(1021048), locationRow(2840, true), proximityRow("2467989798905", 35.086073, -80.851883, 15)], names);
    assert.equal(out.length, 3);
    assert.deepEqual(out[0], {
        type: "LOCATION", criterion: `${CAMP.replace("campaigns/", "campaignCriteria/")}~1021048`, criterion_id: "1021048",
        negative: false, geo_target_constant: "geoTargetConstants/1021048", name: "Charlotte,North Carolina,United States", target_type: "City",
    });
    assert.equal(out[1].negative, true);
    assert.equal(out[1].name, "geoTargetConstants/2840");   // no name lookup → falls back to resource name
    const p = out[2];
    assert.equal(p.type, "PROXIMITY");
    assert.equal(p.criterion_id, "2467989798905");
    assert.equal(p.radius, 15);
    assert.equal(p.radius_units, "MILES");
    assert.equal(p.lat, 35.086073);
    assert.equal(p.lng, -80.851883);
    assert.equal(p.address, "10724 Carmel Commons Blvd, Charlotte, NC 28226");
    assert.match(p.name, /^15 mi radius around 10724 Carmel/);
});

test("geoTargetToSpec round-trips shaped targets back into create payloads", () => {
    const [loc, neg, prox] = shapeGeoCriteria([locationRow(1021048), locationRow(2840, true), proximityRow("9", 35.086073, -80.851883, 15)], names);
    assert.deepEqual(buildGeoCriterion(CAMP, normalizeGeoTargetSpec(geoTargetToSpec(loc))).location, { geoTargetConstant: "geoTargetConstants/1021048" });
    assert.equal(buildGeoCriterion(CAMP, normalizeGeoTargetSpec(geoTargetToSpec(neg))).negative, true);
    assert.deepEqual(buildGeoCriterion(CAMP, normalizeGeoTargetSpec(geoTargetToSpec(prox))).proximity.geoPoint,
        { latitudeInMicroDegrees: 35086073, longitudeInMicroDegrees: -80851883 });
});

test("planGeoTargetingChange: remove a radius target by criterion ID and add a new one", () => {
    const current = geo(shapeGeoCriteria([proximityRow("2471640119732", 35.086073, -80.851883, 15)]));
    const plan = planGeoTargetingChange({
        campaignResource: CAMP, current,
        add: [normalizeGeoTargetSpec({ lat: 35.086073, lng: -80.851883, radius: 10, units: "KILOMETERS" })],
        remove: ["2471640119732"],
    });
    assert.equal(plan.ops.length, 2);
    assert.equal(plan.ops[0].campaignCriterionOperation.remove, current.targets[0].criterion);
    assert.deepEqual(plan.ops[1].campaignCriterionOperation.create.proximity.radiusUnits, "KILOMETERS");
    assert.equal(plan.set_geo_target_type, null);
});

test("planGeoTargetingChange: unknown remove token lists current targets", () => {
    const current = geo(shapeGeoCriteria([locationRow(1021048)], names));
    assert.throws(() => planGeoTargetingChange({ campaignResource: CAMP, current, remove: ["Denver"] }), /Charlotte,North Carolina,United States \[1021048\]/);
});

test("planGeoTargetingChange: copy_from_campaign adds missing criteria and skips ones already present", () => {
    // Play Therapy (radius only) ← Neuropsychological Evaluations (Charlotte + same radius)
    const current = geo(shapeGeoCriteria([proximityRow("2471640119732", 35.086073, -80.851883, 15)]));
    const source = geo(shapeGeoCriteria([locationRow(1021048), proximityRow("2467989798905", 35.086073, -80.851883, 15)], names));
    const plan = planGeoTargetingChange({ campaignResource: CAMP, current, source });
    assert.equal(plan.adding.length, 1);
    assert.equal(plan.adding[0].geo_target_constant, "geoTargetConstants/1021048");
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0].kind, "proximity");
    assert.equal(plan.removing.length, 0);
    assert.equal(plan.ops.length, 1);
});

test("planGeoTargetingChange: replace_existing removes criteria the source lacks and copies the presence setting", () => {
    const current = geo(shapeGeoCriteria([locationRow(2840), locationRow(1021048)], names), "PRESENCE_OR_INTEREST");
    const source = geo(shapeGeoCriteria([locationRow(1021048), proximityRow("5", 35.086073, -80.851883, 15)], names), "PRESENCE");
    const plan = planGeoTargetingChange({ campaignResource: CAMP, current, source, replaceExisting: true });
    assert.deepEqual(plan.removing.map(t => t.criterion_id), ["2840"]);
    assert.deepEqual(plan.adding.map(n => n.kind), ["proximity"]);
    assert.equal(plan.set_geo_target_type, "PRESENCE");
    const campOp = plan.ops.find(o => o.campaignOperation).campaignOperation;
    assert.deepEqual(campOp, {
        update: { resourceName: CAMP, geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" } },
        updateMask: "geo_target_type_setting.positive_geo_target_type",
    });
});

test("planGeoTargetingChange: explicit geo_target_type overrides the source; no-op when unchanged", () => {
    const current = geo([], "PRESENCE");
    assert.equal(planGeoTargetingChange({ campaignResource: CAMP, current, source: geo([], "PRESENCE_OR_INTEREST"), geoTargetType: "PRESENCE" }).ops.length, 0);
    assert.equal(planGeoTargetingChange({ campaignResource: CAMP, current, geoTargetType: "PRESENCE_OR_INTEREST" }).set_geo_target_type, "PRESENCE_OR_INTEREST");
});

test("describeGeoSpec labels locations, exclusions, and radius targets", () => {
    assert.equal(describeGeoSpec(normalizeGeoTargetSpec({ lat: 35.08, lng: -80.85, radius: 15 })), "15 mi radius around 35.08, -80.85");
    assert.equal(describeGeoSpec(normalizeGeoTargetSpec({ geo_target_constant: 2840, negative: true }), { "geoTargetConstants/2840": "United States" }),
        "EXCLUDE United States (geoTargetConstants/2840)");
});

const geoCreates = body => body.mutateOperations
    .map(o => o.campaignCriterionOperation?.create)
    .filter(c => c && (c.location || c.proximity));

test("createGoogleCampaignFull: geo_targets mixes IDs, exclusions, and radius targets", async () => {
    await createGoogleCampaignFull("tok", "9040402786", "7631184147", {
        campaign_name: "Play Therapy Copy", daily_budget: 10, bidding_strategy: "MAXIMIZE_CLICKS",
        geo_targets: [1021048, { geo_target_constant: 2840, negative: true }, { lat: 35.086073, lng: -80.851883, radius: 15, units: "MILES" }],
        ad_groups: [{ name: "AG", keywords: [{ text: "play therapy", match_type: "EXACT" }] }],
    });
    const creates = geoCreates(bodies[0]);
    assert.equal(creates.length, 3);
    assert.deepEqual(creates[0].location, { geoTargetConstant: "geoTargetConstants/1021048" });
    assert.equal(creates[1].negative, true);
    assert.deepEqual(creates[2].proximity, {
        radius: 15, radiusUnits: "MILES", geoPoint: { latitudeInMicroDegrees: 35086073, longitudeInMicroDegrees: -80851883 },
    });
    assert.ok(creates.every(c => c.campaign === "customers/9040402786/campaigns/-2"));
});

test("createPmaxCampaignFull and createVideoCampaignFull accept radius targets", async () => {
    const geo_targets = [{ address: "1 Main St, Charlotte, NC 28202", radius: 5 }];
    await createPmaxCampaignFull("tok", "1", "2", {
        campaign_name: "PMax", daily_budget: 10, final_url: "https://example.com", geo_targets,
        business_name_asset: "customers/1/assets/1", logo_asset: "customers/1/assets/2", asset_group_name: "AG",
        headlines: [{ text: "a" }, { text: "b" }, { text: "c" }], long_headlines: [{ text: "l" }], descriptions: [{ text: "d" }, { text: "e" }],
        marketing_images: ["customers/1/assets/3"], square_marketing_images: ["customers/1/assets/4"],
    });
    assert.equal(geoCreates(bodies[0])[0].proximity.address.cityName, "Charlotte");

    bodies.length = 0;
    await createVideoCampaignFull("tok", "1", "2", {
        campaign_name: "Video", daily_budget: 10, final_url: "https://example.com", geo_targets,
        ad_groups: [{ name: "AG", youtube_video: "customers/1/assets/5" }],
    }).catch(() => {});   // response shape doesn't matter; only the request body
    const videoBody = bodies.find(b => b.mutateOperations);
    assert.equal(geoCreates(videoBody)[0].proximity.radius, 5);
});
