// Keeps accounts.json in GitHub as the single source of truth when the server
// runs somewhere with an ephemeral filesystem (Railway). Writes are
// pull → mutate → commit through the GitHub contents API, and a periodic
// refresh picks up changes pushed from the Mac without needing a redeploy.

const API = "https://api.github.com";

class AccountsSyncError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

function createAccountsSync({ token, repo, branch = "main", filePath = "accounts.json", fetch }) {
    const url = `${API}/repos/${repo}/contents/${filePath}`;
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "kaycomm-mcp",
    };
    let lastSha = null;
    let queue = Promise.resolve();

    return {
        enabled: Boolean(token && repo),
        branch,
        get sha() { return lastSha; },

        // Serialize every pull/push so a background refresh can't interleave
        // with a pull → mutate → commit write.
        exclusive(fn) {
            const run = queue.then(fn, fn);
            queue = run.catch(() => {});
            return run;
        },

        async pull() {
            const res = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
            if (!res.ok) throw new AccountsSyncError(`GitHub read failed (HTTP ${res.status})`, "GITHUB_READ_FAILED");
            const body = await res.json();
            const text = Buffer.from(body.content, "base64").toString("utf8");
            JSON.parse(text); // refuse to hand back a file we can't load
            lastSha = body.sha;
            return { text, sha: body.sha };
        },

        async push(text, message) {
            if (!lastSha) throw new AccountsSyncError("No base version — pull before pushing", "GITHUB_NO_BASE");
            const res = await fetch(url, {
                method: "PUT",
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify({ message, branch, sha: lastSha, content: Buffer.from(text, "utf8").toString("base64") }),
            });
            if (res.status === 409 || res.status === 422) {
                throw new AccountsSyncError("accounts.json changed on GitHub while saving", "GITHUB_CONFLICT");
            }
            if (!res.ok) throw new AccountsSyncError(`GitHub write failed (HTTP ${res.status})`, "GITHUB_WRITE_FAILED");
            const body = await res.json();
            lastSha = body.content.sha;
            return { commit: body.commit.sha, url: body.commit.html_url };
        },
    };
}

// On the synced server, routines may only manage notes and routine rules.
// Budgets, flights, inactive flags and add/remove still come from the Mac.
const NOTE_FIELDS = new Set(["add_note", "clear_notes", "note_expires"]);
const UPDATE_IGNORED = new Set(["action", "platform", "id", "confirm", "idempotency_key"]);

function syncedWriteAllowed(args) {
    const action = args.action || "list";
    if (["list", "context", "add_rule", "remove_rule"].includes(action)) return { ok: true };
    if (action === "update") {
        const other = Object.keys(args).filter(k => args[k] != null && !UPDATE_IGNORED.has(k) && !NOTE_FIELDS.has(k));
        if (!other.length) return { ok: true };
        return { ok: false, fields: other };
    }
    return { ok: false, fields: [action] };
}

module.exports = { createAccountsSync, syncedWriteAllowed, AccountsSyncError };
