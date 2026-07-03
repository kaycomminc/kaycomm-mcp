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
 * IMPORTANT: the exchange only works while the current token is still
 * VALID. Run this before expiry (health_check warns at 14 days out). If
 * the token has already expired, mint a new long-lived token manually
 * once (Graph API Explorer → extend), paste it into the config, and get
 * back on schedule.
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

const TOKEN  = process.env.META_ACCESS_TOKEN;
const APP_ID = process.env.META_APP_ID;
const SECRET = process.env.META_APP_SECRET;

if (!TOKEN || !APP_ID || !SECRET) {
    console.error("Missing credentials:");
    if (!TOKEN)  console.error("  META_ACCESS_TOKEN — the current (still-valid) token");
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
