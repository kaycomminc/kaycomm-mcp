#!/usr/bin/env node
/**
 * Local test harness — run any MCP tool directly without deploying or
 * restarting Claude Desktop:
 *
 *   node test.js get_google_pacing
 *   node test.js get_account_detail '{"account_name":"Spartan"}'
 *
 * Credentials: uses env vars if set, otherwise reads ./.env so it Just Works
 * on this machine.
 */
process.env.MCP_TEST = "1";

// Pull creds from ./.env when not already in the environment
require("./local-env").loadLocalEnv();

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
