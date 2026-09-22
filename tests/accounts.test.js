// MCP_TEST must be set before server.js is loaded, or main() starts the stdio
// server and the test process never exits. That is also why this file uses
// require() rather than import: ESM hoists the import above any assignment.
process.env.MCP_TEST = "1";
const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveAccount } = require("../server.js");

// Test store
const testStore = {
    id1: { name: "Account One" },
    id2: { name: "Account Two" },
    id3: { name: "Another Account" },
};

test("resolveAccount: exact match wins", () => {
    const { match } = resolveAccount(testStore, "Account One");
    assert.ok(match);
    assert.equal(match[0], "id1");
    assert.equal(match[1].name, "Account One");
});

test("resolveAccount: unique substring match", () => {
    const { match } = resolveAccount(testStore, "Another");
    assert.ok(match);
    assert.equal(match[0], "id3");
    assert.equal(match[1].name, "Another Account");
});

test("resolveAccount: exact match preferred over partial", () => {
    const { match } = resolveAccount(testStore, "Account Two");
    assert.ok(match);
    assert.equal(match[0], "id2");
});

test("resolveAccount: ambiguous match returns error", () => {
    const { error } = resolveAccount(testStore, "Account");
    assert.ok(error);
    assert(error.includes("Ambiguous account 'Account'"));
    assert(error.includes("Account One"));
    assert(error.includes("Account Two"));
    assert(error.includes("Another Account"));
});

test("resolveAccount: no match returns error", () => {
    const { error } = resolveAccount(testStore, "Nonexistent");
    assert.ok(error);
    assert(error.includes("No account matching"));
});

test("resolveAccount: empty search returns required error", () => {
    const { error } = resolveAccount(testStore, "");
    assert.ok(error);
    assert(error.includes("required"));
});

test("resolveAccount: null search returns required error", () => {
    const { error } = resolveAccount(testStore, null);
    assert.ok(error);
    assert(error.includes("required"));
});

test("resolveAccount: case insensitive matching", () => {
    const { match } = resolveAccount(testStore, "account one");
    assert.ok(match);
    assert.equal(match[0], "id1");
});

const { buildAccountContext, addDays } = require("../server.js");

test("addDays: crosses month boundary", () => {
    assert.equal(addDays("2026-09-22", 30), "2026-10-22");
    assert.equal(addDays("2026-01-31", 1), "2026-02-01");
});

test("buildAccountContext: groups by name and splits live vs expired notes", () => {
    const stores = {
        google: {
            "111": { name: "Soap Co", budget: 3000, budget_schedule: [{ from: "2026-09-01", budget: 5500 }],
                notes: [
                    { text: "Meta budget redirected to Google", added: "2026-09-01", expires: "2026-10-01" },
                    { text: "Old permission issue", added: "2026-07-01", expires: "2026-08-01" },
                ] },
            "222": { name: "Gone Co", budget: 100, inactive: "CUSTOMER_NOT_ENABLED", health: false },
        },
        meta: { act_1: { name: "Soap Co", budget: 0 } },
    };
    const ctx = buildAccountContext(stores, "2026-09-22");
    const soap = ctx.accounts.find(a => a.name === "Soap Co");
    assert.equal(soap.platforms.length, 2);
    assert.equal(soap.platforms[0].budget, 5500);
    assert.deepEqual(soap.notes.map(n => n.text), ["Meta budget redirected to Google"]);
    assert.deepEqual(soap.expired_notes.map(n => n.text), ["Old permission issue"]);
    const gone = ctx.accounts.find(a => a.name === "Gone Co");
    assert.equal(gone.platforms[0].inactive, "CUSTOMER_NOT_ENABLED");
    assert.equal(gone.platforms[0].health_check, "excluded");
    assert.equal(gone.notes, undefined);
});
