#!/usr/bin/env node
/**
 * Refresh the Meta long-lived access token before it expires.
 *
 *   node refresh-meta-token.js
 *
 * Exchanges the current META_ACCESS_TOKEN for a fresh ~60-day token
 * (grant_type=fb_exchange_token), verifies the new token works, writes it
 * into Claude Desktop's config, and prints it for pasting into
 * Railway → Variables.
 *
 * Needs META_APP_ID and META_APP_SECRET (Meta app → Settings → Basic) in
 * addition to the existing credentials — set them as env vars or add them
 * to the kaycomm-pacing env block in claude_desktop_config.json.
 *
 * IMPORTANT: Meta anchors a token's 60-day window to when the user last
 * AUTHENTICATED — exchanging a long-lived token re-issues it with the
 * SAME expiry, it does not extend it. So the renewal cycle is:
 *
 *   1. developers.facebook.com/tools/explorer → app "Kay Comm App" →
 *      permissions ads_management + ads_read → Generate Access Token
 *      (this is the real login that resets the 60-day clock)
 *   2. node refresh-meta-token.js <paste-that-token>
 *
 * The script exchanges it for a long-lived (~60 day) token, verifies it,
 * updates Claude Desktop's config, and prints it for Railway.
 * health_check warns 14 days before expiry.
 */
const os   = require("os");
const fs   = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");

// Pull creds from claude_desktop_config.json when not already in the environment
if (["META_ACCESS_TOKEN", "META_APP_ID", "META_APP_SECRET"].some(k => !process.env[k])) {
    try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        const env = cfg?.mcpServers?.["kaycomm-pacing"]?.env || {};
        for (const [k, v] of Object.entries(env)) {
            if (!process.env[k]) process.env[k] = v;
        }
    } catch (_) { /* fall through — missing creds reported below */ }
}

// A freshly generated token (Graph API Explorer) can be passed as the first
// argument — that's what actually resets the 60-day clock. Without it, the
// current token is re-exchanged, which only re-issues the same expiry window.
const TOKEN  = process.argv[2] || process.env.META_ACCESS_TOKEN;
const APP_ID = process.env.META_APP_ID;
const SECRET = process.env.META_APP_SECRET;

if (!process.argv[2]) console.log("Note: no fresh token passed — re-exchanging the current one keeps its existing expiry.\nTo reset the 60-day clock: node refresh-meta-token.js <token from developers.facebook.com/tools/explorer>\n");

if (!TOKEN || !APP_ID || !SECRET) {
    console.error("Missing credentials:");
    if (!TOKEN)  console.error("  META_ACCESS_TOKEN — the current (still-valid) token, or pass a fresh one as an argument");
    if (!APP_ID) console.error("  META_APP_ID      — Meta app → Settings → Basic → App ID");
    if (!SECRET) console.error("  META_APP_SECRET  — Meta app → Settings → Basic → App Secret (click Show)");
    console.error(`\nAdd the missing keys to the kaycomm-pacing env block in:\n  ${CONFIG_PATH}\nthen re-run: node refresh-meta-token.js`);
    process.exit(1);
}

// Keep the Graph API version in lockstep with server.js
let META_API_VERSION = "v21.0";
try {
    const m = fs.readFileSync(path.join(__dirname, "server.js"), "utf8").match(/META_API_VERSION\s*=\s*"(v[\d.]+)"/);
    if (m) META_API_VERSION = m[1];
} catch (_) { /* fallback above */ }

const GRAPH = `https://graph.facebook.com/${META_API_VERSION}`;

async function graphGet(pathname, params) {
    const qs = new URLSearchParams(params);
    const resp = await fetch(`${GRAPH}/${pathname}?${qs}`);
    const data = await resp.json();
    if (data.error) throw new Error(`${pathname}: ${data.error.message}`);
    return data;
}

async function main() {
    // 1. Exchange the current token for a fresh long-lived one
    console.log("Exchanging current token for a fresh 60-day token...");
    const exch = await graphGet("oauth/access_token", {
        grant_type:        "fb_exchange_token",
        client_id:         APP_ID,
        client_secret:     SECRET,
        fb_exchange_token: TOKEN,
    });
    const newToken = exch.access_token;
    if (!newToken) throw new Error("Exchange returned no access_token");
    if (newToken === TOKEN) console.log("Note: Meta returned the same token (it was issued recently) — expiry unchanged.");

    // 2. Verify it works and report the new expiry
    const me  = await graphGet("me", { fields: "id,name", access_token: newToken });
    const dbg = await graphGet("debug_token", { input_token: newToken, access_token: `${APP_ID}|${SECRET}` });
    const exp = dbg.data?.expires_at;
    const expStr = exp === 0 ? "never" : exp ? new Date(exp * 1000).toISOString().split("T")[0] : "unknown";
    console.log(`New token verified — authenticated as ${me.name}, expires: ${expStr}`);

    // 3. Write it into Claude Desktop's config (backup first)
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw);
    const env = cfg?.mcpServers?.["kaycomm-pacing"]?.env;
    if (env) {
        fs.writeFileSync(CONFIG_PATH + ".bak", raw);
        env.META_ACCESS_TOKEN = newToken;
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
        console.log(`Updated ${CONFIG_PATH} (backup at .bak) — restart Claude Desktop to pick it up.`);
    } else {
        console.log("Could not find the kaycomm-pacing env block in Claude Desktop's config — update META_ACCESS_TOKEN there manually.");
    }

    // 4. Railway must be updated by hand
    console.log("\nNow paste the new token into Railway → kaycomm-mcp → Variables → META_ACCESS_TOKEN:\n");
    console.log(newToken);
    console.log("\n(Railway restarts the service automatically when the variable is saved.)");
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
