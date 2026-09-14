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
