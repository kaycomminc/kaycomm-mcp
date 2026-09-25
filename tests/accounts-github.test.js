const test = require("node:test");
const assert = require("node:assert/strict");

const { createAccountsSync, syncedWriteAllowed } = require("../src/accounts-github.js");

// Minimal in-memory stand-in for the GitHub contents API.
function fakeGitHub(initial) {
    const repo = { text: initial, sha: "sha1", n: 1, puts: [] };
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    repo.fetch = async (url, options = {}) => {
        assert.match(url, /\/repos\/o\/r\/contents\/accounts\.json/);
        assert.equal(options.headers.Authorization, "Bearer t");
        if (!options.method) {
            return json(200, { sha: repo.sha, content: Buffer.from(repo.text).toString("base64") });
        }
        const body = JSON.parse(options.body);
        repo.puts.push(body);
        if (body.sha !== repo.sha) return json(409, { message: "conflict" });
        repo.text = Buffer.from(body.content, "base64").toString("utf8");
        repo.sha = `sha${++repo.n}`;
        return json(200, { content: { sha: repo.sha }, commit: { sha: `c${repo.n}abcdef`, html_url: `https://github.com/o/r/commit/c${repo.n}` } });
    };
    return repo;
}

const make = gh => createAccountsSync({ token: "t", repo: "o/r", fetch: gh.fetch });

test("accounts sync: disabled without a token", () => {
    assert.equal(createAccountsSync({ repo: "o/r", fetch() {} }).enabled, false);
});

test("accounts sync: pull then push commits against the pulled sha", async () => {
    const gh = fakeGitHub('{"google":{}}\n');
    const sync = make(gh);
    const { text, sha } = await sync.pull();
    assert.equal(text, '{"google":{}}\n');
    assert.equal(sha, "sha1");
    const commit = await sync.push('{"google":{"1":{}}}\n', "accounts: test");
    assert.equal(gh.text, '{"google":{"1":{}}}\n');
    assert.equal(gh.puts[0].sha, "sha1");
    assert.equal(gh.puts[0].branch, "main");
    assert.equal(gh.puts[0].message, "accounts: test");
    assert.match(commit.url, /commit\/c2/);
    assert.equal(sync.sha, "sha2");
});

test("accounts sync: push refuses without a pulled base", async () => {
    const sync = make(fakeGitHub("{}"));
    await assert.rejects(sync.push("{}", "m"), { code: "GITHUB_NO_BASE" });
});

test("accounts sync: a change pushed from the Mac in between is a conflict, not an overwrite", async () => {
    const gh = fakeGitHub("{}");
    const sync = make(gh);
    await sync.pull();
    gh.text = '{"mac":true}';
    gh.sha = "mac-sha";
    await assert.rejects(sync.push('{"railway":true}', "m"), { code: "GITHUB_CONFLICT" });
    assert.equal(gh.text, '{"mac":true}');
});

test("accounts sync: refuses to load invalid JSON", async () => {
    const sync = make(fakeGitHub("{not json"));
    await assert.rejects(sync.pull(), SyntaxError);
});

test("accounts sync: exclusive runs callers one at a time, even after a failure", async () => {
    const sync = make(fakeGitHub("{}"));
    const order = [];
    const slow = sync.exclusive(async () => { order.push("a-start"); await new Promise(r => setTimeout(r, 20)); order.push("a-end"); throw new Error("boom"); });
    const fast = sync.exclusive(async () => { order.push("b"); return 2; });
    await assert.rejects(slow, /boom/);
    assert.equal(await fast, 2);
    assert.deepEqual(order, ["a-start", "a-end", "b"]);
});

test("syncedWriteAllowed: notes and routine rules only", () => {
    assert.ok(syncedWriteAllowed({ action: "update", platform: "google", id: "1", add_note: "x", note_expires: "2026-10-01", confirm: true }).ok);
    assert.ok(syncedWriteAllowed({ action: "update", platform: "google", id: "1", clear_notes: true }).ok);
    assert.ok(syncedWriteAllowed({ action: "add_rule", rule: "x", confirm: true }).ok);
    assert.ok(syncedWriteAllowed({ action: "remove_rule", rule_id: "r1" }).ok);
    assert.ok(syncedWriteAllowed({ action: "context" }).ok);

    assert.deepEqual(syncedWriteAllowed({ action: "update", platform: "google", id: "1", budget: 5000, add_note: "x" }), { ok: false, fields: ["budget"] });
    assert.deepEqual(syncedWriteAllowed({ action: "update", platform: "google", id: "1", inactive: false }), { ok: false, fields: ["inactive"] });
    assert.equal(syncedWriteAllowed({ action: "add", platform: "google", id: "1", name: "n", budget: 1 }).ok, false);
    assert.equal(syncedWriteAllowed({ action: "remove", platform: "google", id: "1" }).ok, false);
});
