process.env.MCP_TEST = "1";
const test = require("node:test");
const assert = require("node:assert/strict");

const {
    getPacingLabel, getFlightPacing, buildDailyBudgetRec, getDateInfo, getEffectiveBudget, pctChange,
    buildCampaignBudgetLines,
} = require("../server.js");

// ── getPacingLabel ──────────────────────────────────────────────────────────

test("getPacingLabel: mid-month on pace", () => {
    const r = getPacingLabel(480, 1000, 15, 30);
    assert.equal(r.status, "ON PACE");
    assert.equal(r.pct_expected, 96);
});

test("getPacingLabel: mid-month overpacing", () => {
    const r = getPacingLabel(124.5, 2500, 1, 31);
    assert.equal(r.status, "OVERPACING");
});

test("getPacingLabel: mid-month underpacing", () => {
    const r = getPacingLabel(24.09, 1000, 1, 31);
    assert.equal(r.status, "UNDERPACING");
});

test("getPacingLabel: day 1 of month (dom=0) — no division blowup", () => {
    const r = getPacingLabel(50, 1000, 0, 31);
    assert.equal(r.status, "NO_COMPLETE_DAYS_YET");
    assert.equal(r.remaining, 950);
    assert.ok(Number.isFinite(r.remaining));
});

test("getPacingLabel: last day of month (dom === dim), default 5% tolerance", () => {
    const r = getPacingLabel(950, 1000, 31, 31);
    assert.equal(r.status, "UNDERPACING");
    assert.equal(r.pct_budget, 95);
    assert.equal(r.pct_expected, 95);
    assert.ok(Number.isFinite(r.projected_month_end));
});

test("getPacingLabel: last day of month with 15% tolerance returns ON PACE", () => {
    const r = getPacingLabel(950, 1000, 31, 31, 15);
    assert.equal(r.status, "ON PACE");
});

test("getPacingLabel: budget = 0 short-circuits to no_cap", () => {
    assert.deepEqual(getPacingLabel(50, 0, 15, 31), { status: "no_cap" });
});

// ── getFlightPacing ─────────────────────────────────────────────────────────

test("getFlightPacing: before flight start", () => {
    const r = getFlightPacing(0, 1000, "2026-08-01", "2026-08-31", "2026-07-01");
    assert.equal(r.status, "FLIGHT_NOT_STARTED");
    assert.equal(r.complete_days_elapsed, 0);
});

test("getFlightPacing: mid-flight", () => {
    const r = getFlightPacing(500, 1000, "2026-07-01", "2026-07-31", "2026-07-15");
    assert.equal(r.status, "ON PACE");
    assert.equal(r.flight_days, 31);
    assert.equal(r.complete_days_elapsed, 15);
    assert.equal(r.days_remaining, 16);
    assert.ok(Number.isFinite(r.needed_per_day));
});

test("getFlightPacing: after flight end", () => {
    const r = getFlightPacing(1000, 1000, "2026-06-01", "2026-06-30", "2026-07-01");
    assert.equal(r.status, "FLIGHT_ENDED");
    assert.equal(r.note, "Flight delivered in full.");
});

test("getFlightPacing: flight ended under budget note", () => {
    const r = getFlightPacing(500, 1000, "2026-06-01", "2026-06-30", "2026-07-01");
    assert.equal(r.status, "FLIGHT_ENDED");
    assert.equal(r.note, "Flight ended under budget.");
});

// ── buildDailyBudgetRec ─────────────────────────────────────────────────────

test("buildDailyBudgetRec: last day of month (days_remaining = 0) — no divide-by-zero, returns null", () => {
    assert.equal(buildDailyBudgetRec(10, 100, 0), null);
});

test("buildDailyBudgetRec: null daysRemaining also returns null", () => {
    assert.equal(buildDailyBudgetRec(10, 100, null), null);
});

test("buildDailyBudgetRec: null currentDaily returns null", () => {
    assert.equal(buildDailyBudgetRec(null, 100, 10), null);
});

test("buildDailyBudgetRec: remaining <= 0 reports BUDGET_EXHAUSTED", () => {
    const r = buildDailyBudgetRec(10, 0, 5);
    assert.match(r.recommendation, /^BUDGET_EXHAUSTED/);
});

test("buildDailyBudgetRec: currentDaily <= 0 reports NO_DAILY_BUDGETS", () => {
    const r = buildDailyBudgetRec(0, 100, 10);
    assert.match(r.recommendation, /^NO_DAILY_BUDGETS/);
    assert.equal(r.needed_per_day, 10);
});

test("buildDailyBudgetRec: within 10% is ON_TRACK", () => {
    const r = buildDailyBudgetRec(100, 1050, 10); // needed=105, diff=5%
    assert.match(r.recommendation, /^ON_TRACK/);
});

test("buildDailyBudgetRec: needed higher than current recommends RAISE", () => {
    const r = buildDailyBudgetRec(23, 975.91, 30);
    assert.match(r.recommendation, /^RAISE/);
});

test("buildDailyBudgetRec: needed lower than current recommends LOWER", () => {
    const r = buildDailyBudgetRec(119.5, 2375.5, 30);
    assert.match(r.recommendation, /^LOWER/);
});

// ── getDateInfo ─────────────────────────────────────────────────────────────

test("getDateInfo: returns well-formed today/yesterday/month_start and finite dom/dim", () => {
    const d = getDateInfo();
    assert.match(d.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(d.yesterday, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(d.month_start, /^\d{4}-\d{2}-01$/);
    assert.ok(Number.isInteger(d.dom));
    assert.ok(Number.isInteger(d.dim));
    assert.ok(d.dim >= 28 && d.dim <= 31);
});

test("getDateInfo: pace_dom is a non-negative integer (0 only possible on the 1st)", () => {
    const d = getDateInfo();
    assert.ok(Number.isInteger(d.pace_dom));
    assert.ok(d.pace_dom >= 0);
    if (d.dom === 1) assert.equal(d.pace_dom, 0);
});

// ── getEffectiveBudget ──────────────────────────────────────────────────────

test("getEffectiveBudget: no schedule returns base budget, no nc_budget", () => {
    const r = getEffectiveBudget({ budget: 1000 }, "2026-07-02");
    assert.deepEqual(r, { budget: 1000, nc_budget: undefined, effective_from: null });
});

test("getEffectiveBudget: with nc_budget and no schedule", () => {
    const r = getEffectiveBudget({ budget: 1000, nc_budget: 200 }, "2026-07-02");
    assert.equal(r.budget, 1000);
    assert.equal(r.nc_budget, 200);
    assert.equal(r.effective_from, null);
});

test("getEffectiveBudget: schedule entry on/before today wins, sorted by latest", () => {
    const info = {
        budget: 1000, nc_budget: 200,
        budget_schedule: [
            { from: "2026-06-01", budget: 1500 },
            { from: "2026-07-01", budget: 2000, nc_budget: 300 },
        ],
    };
    const r = getEffectiveBudget(info, "2026-07-02");
    assert.equal(r.budget, 2000);
    assert.equal(r.nc_budget, 300);
    assert.equal(r.effective_from, "2026-07-01");
});

test("getEffectiveBudget: future schedule entries do not apply yet", () => {
    const info = { budget: 1000, budget_schedule: [{ from: "2026-08-01", budget: 5000 }] };
    const r = getEffectiveBudget(info, "2026-07-02");
    assert.equal(r.budget, 1000);
    assert.equal(r.effective_from, null);
});

// ── pctChange ───────────────────────────────────────────────────────────────

test("pctChange: prior = 0, current > 0 reports 'new'", () => {
    assert.equal(pctChange(50, 0), "new");
});

test("pctChange: prior = 0, current = 0 reports em-dash", () => {
    assert.equal(pctChange(0, 0), "—");
});

test("pctChange: prior = null reports 'new' when current > 0", () => {
    assert.equal(pctChange(50, null), "new");
});

test("pctChange: normal increase is prefixed with +", () => {
    assert.equal(pctChange(150, 100), "+50.0%");
});

test("pctChange: normal decrease has no + prefix", () => {
    assert.equal(pctChange(50, 100), "-50.0%");
});

// ── buildCampaignBudgetLines ────────────────────────────────────────────────

const lineData = {
    spend:  { "v9 - catering dtc": 200, "v9 - catering downtown": 50, "catering downtown old": 999 },
    daily:  { "v9 - catering dtc": 10, "v9 - catering downtown": 10.5, "catering downtown old": 0 },
    status: { "v9 - catering dtc": "ENABLED", "v9 - catering downtown": "ENABLED", "catering downtown old": "PAUSED" },
};

test("campaign lines: exact names only, full month paced like the account", () => {
    const [line] = buildCampaignBudgetLines(
        [{ label: "DTC", campaigns: ["V9 - Catering DTC"], budget: 600 }], lineData, "2026-10-01", 10, 31);
    assert.equal(line.mtd_spend, 200);
    assert.equal(line.prorated_budget, undefined);
    assert.equal(line.pct_budget, 33.3);
    assert.equal(line.daily_budget.days_remaining, 21);
});

test("campaign lines: substring names never join a line", () => {
    const [line] = buildCampaignBudgetLines(
        [{ label: "DT", campaigns: ["V9 - Catering Downtown"], budget: 300 }], lineData, "2026-10-01", 10, 31);
    assert.equal(line.mtd_spend, 50);
});

test("campaign lines: start date prorates the first month", () => {
    const [line] = buildCampaignBudgetLines(
        [{ label: "DT", campaigns: ["V9 - Catering Downtown"], budget: 310, start: "2026-10-06" }], lineData, "2026-10-01", 10, 31);
    assert.equal(line.prorated_budget, 260);           // 310 × 26/31
    assert.equal(line.pct_expected, 100);              // 50 vs 260 × 5/26 = 50
    assert.equal(line.daily_budget.needed_per_day, 10); // 210 over 21 days
});

test("campaign lines: before start date, no complete days; missing names reported", () => {
    const [a, b] = buildCampaignBudgetLines([
        { label: "A", campaigns: ["V9 - Catering Downtown"], budget: 300, start: "2026-10-20" },
        { label: "B", campaigns: ["Renamed Campaign"], budget: 100 },
    ], lineData, "2026-10-01", 10, 31);
    assert.equal(a.status, "NO_COMPLETE_DAYS_YET");
    assert.equal(a.daily_budget.days_remaining, 12);
    assert.deepEqual(b.missing_campaigns, ["Renamed Campaign"]);
    const [c] = buildCampaignBudgetLines([{ label: "C", campaigns: [], budget: 1, start: "2026-11-02" }], lineData, "2026-10-01", 10, 31);
    assert.equal(c.status, "NOT_STARTED");
});
