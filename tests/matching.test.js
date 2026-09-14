// MCP_TEST must be set before server.js is loaded — see accounts.test.js.
process.env.MCP_TEST = "1";
const test = require("node:test");
const assert = require("node:assert/strict");

const {
    matchByName, resolveAccount, skippedRow, partitionSkipped, buildDailyBudgetRec,
} = require("../server.js");

const campaigns = [
    { name: "Brand - Search" },
    { name: "Brand - Shopping" },
    { name: "Competitor - Search" },
];
const byName = c => c.name;

// ── ambiguity ───────────────────────────────────────────────────────────────

test("matchByName: a substring matching several campaigns errors, never guesses", () => {
    const r = matchByName(campaigns, byName, "brand", { label: "campaign" });
    assert.equal(r.item, undefined);
    assert.match(r.error, /Ambiguous campaign/);
    assert.deepEqual(r.candidates, ["Brand - Search", "Brand - Shopping"]);
});

test("matchByName: a unique substring resolves during a dry run", () => {
    const r = matchByName(campaigns, byName, "competitor");
    assert.equal(r.item.name, "Competitor - Search");
});

test("matchByName: no match reports empty, distinct from an error", () => {
    const r = matchByName(campaigns, byName, "nonexistent");
    assert.equal(r.empty, true);
    assert.equal(r.item, undefined);
    assert.equal(r.error, undefined);
});

test("matchByName: an exact name beats the substring that also matches it", () => {
    const items = [{ name: "Shoes" }, { name: "Shoes - Clearance" }];
    assert.equal(matchByName(items, byName, "Shoes").item.name, "Shoes");
});

test("matchByName: exact matching ignores case and surrounding space", () => {
    assert.equal(matchByName(campaigns, byName, "  BRAND - SEARCH  ").item.name, "Brand - Search");
});

test("matchByName: an empty search never resolves to a target", () => {
    const r = matchByName(campaigns, byName, "");
    assert.equal(r.item, undefined);
    assert.ok(r.error);
});

// ── confirmed writes must name the target exactly ───────────────────────────

test("matchByName: a confirmed write refuses a partial and names the full target", () => {
    const r = matchByName(campaigns, byName, "competitor", { confirmed: true, label: "campaign" });
    assert.equal(r.item, undefined);
    assert.match(r.error, /exact name/);
    assert.deepEqual(r.candidates, ["Competitor - Search"]);
});

test("matchByName: a confirmed write proceeds on an exact name", () => {
    const r = matchByName(campaigns, byName, "Competitor - Search", { confirmed: true });
    assert.equal(r.item.name, "Competitor - Search");
});

// ── the same rule on accounts ───────────────────────────────────────────────

const accounts = {
    "111": { name: "Boulevard Carroll" },
    "222": { name: "Boulevard Dental" },
    "333": { name: "Woca Woodcare" },
};

test("resolveAccount: a partial still resolves when not confirming", () => {
    const { match } = resolveAccount(accounts, "Woca");
    assert.equal(match[0], "333");
});

test("resolveAccount: a confirmed write refuses a partially-matched account", () => {
    const { match, error } = resolveAccount(accounts, "Woca", { confirmed: true });
    assert.equal(match, undefined);
    assert.match(error, /exact name/);
});

test("resolveAccount: a confirmed write proceeds on an exact account name", () => {
    const { match } = resolveAccount(accounts, "Woca Woodcare", { confirmed: true });
    assert.equal(match[0], "333");
});

test("resolveAccount: ambiguity still errors when confirming", () => {
    const { match, error } = resolveAccount(accounts, "Boulevard", { confirmed: true });
    assert.equal(match, undefined);
    assert.match(error, /Ambiguous/);
});

// ── inactive accounts ───────────────────────────────────────────────────────

test("skippedRow keeps the budget so the account is not silently lost", () => {
    const r = skippedRow({ name: "Axis Office", budget: 10000, inactive: "CUSTOMER_NOT_ENABLED" });
    assert.equal(r.skipped, true);
    assert.equal(r.budget, 10000);
    assert.equal(r.reason, "CUSTOMER_NOT_ENABLED");
});

test("skippedRow falls back to a generic reason for `inactive: true`", () => {
    assert.match(skippedRow({ name: "X", budget: 1, inactive: true }).reason, /accounts\.json/);
});

test("partitionSkipped separates live rows from skipped ones", () => {
    const { active, skipped } = partitionSkipped([
        { account: "Live", mtd_spend: 10 },
        { account: "Dead", skipped: true },
    ]);
    assert.deepEqual(active.map(r => r.account), ["Live"]);
    assert.deepEqual(skipped.map(r => r.account), ["Dead"]);
});

test("a real error stays an active row rather than an expected skip", () => {
    const { active, skipped } = partitionSkipped([{ account: "Broken", error: "auth failed" }]);
    assert.equal(skipped.length, 0);
    assert.equal(active[0].error, "auth failed");
});

// ── lifetime budgets ────────────────────────────────────────────────────────

test("daily budgets still give an actionable RAISE recommendation", () => {
    const r = buildDailyBudgetRec(50, 3000, 10);
    assert.match(r.recommendation, /^RAISE/);
    assert.equal(r.confidence, undefined);
});

test("lifetime budgets downgrade the recommendation instead of advising a raise", () => {
    const r = buildDailyBudgetRec(50, 3000, 10, 15, { hasLifetimeBudgets: true });
    assert.equal(r.confidence, "reduced");
    assert.match(r.recommendation, /^REDUCED_CONFIDENCE/);
    assert.doesNotMatch(r.recommendation, /^RAISE/);
    assert.match(r.note, /lifetime/);
});

test("an exhausted budget stays exhausted even with lifetime budgets", () => {
    const r = buildDailyBudgetRec(50, -100, 10, 15, { hasLifetimeBudgets: true });
    assert.match(r.recommendation, /^BUDGET_EXHAUSTED/);
});

test("the per-account tolerance still applies alongside the lifetime flag", () => {
    const r = buildDailyBudgetRec(100, 1000, 10, 15);
    assert.match(r.recommendation, /ON_TRACK/);
});
