#!/usr/bin/env node
/**
 * Local test harness — run any MCP tool directly without deploying or
 * restarting Claude Desktop:
 *
 *   node test.js get_google_pacing
 *   node test.js get_account_detail '{"account_name":"Spartan"}'
 *
 * Credentials: uses env vars if set, otherwise reads the env block from
 * Claude Desktop's config so it Just Works on this machine.
 */
process.env.MCP_TEST = "1";

// Pull creds from claude_desktop_config.json when not already in the environment
const REQUIRED = ["GOOGLE_DEVELOPER_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "META_ACCESS_TOKEN"];
if (REQUIRED.some(k => !process.env[k])) {
    try {
        const os = require("os");
        const path = require("path");
        const fs = require("fs");
        const cfgPath = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        const env = cfg?.mcpServers?.["kaycomm-pacing"]?.env || {};
        for (const [k, v] of Object.entries(env)) {
            if (!process.env[k]) process.env[k] = v;
        }
    } catch (_) { /* fall through — server will report auth errors */ }
}

const { handleToolCall } = require("./server.js");

const [,, tool, json] = process.argv;
if (!tool) {
    console.log("Usage: node test.js <tool_name> ['<json args>']");
    process.exit(1);
}

let args = {};
if (json) {
    try { args = JSON.parse(json); }
    catch (e) { console.error("Invalid JSON args:", e.message); process.exit(1); }
}

handleToolCall(tool, args)
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error("ERROR:", e.message); process.exit(1); });
