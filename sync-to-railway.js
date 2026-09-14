#!/usr/bin/env node
/**
 * Sync kaycomm-pacing env vars from Claude Desktop config → Railway.
 *
 *   node sync-to-railway.js                  # sync all token/secret vars
 *   node sync-to-railway.js META_ACCESS_TOKEN LINKEDIN_ACCESS_TOKEN   # sync specific vars
 *   node sync-to-railway.js --dry-run        # show what would be synced without changing Railway
 *
 * Reads the kaycomm-pacing env block from claude_desktop_config.json and
 * pushes each variable to Railway using the CLI. The Railway project must
 * be linked in this directory (run `railway link` if not).
 */
const os   = require("os");
const fs   = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const CONFIG_PATH = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");

const SYNCABLE_KEYS = [
    "GOOGLE_DEVELOPER_TOKEN",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "GOOGLE_REFRESH_TOKEN_2",
    "META_ACCESS_TOKEN",
    "META_APP_ID",
    "META_APP_SECRET",
    "STACKADAPT_API_KEY",
    "LINKEDIN_ACCESS_TOKEN",
    "MCP_AUTH_TOKEN",
];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const requestedKeys = args.filter(a => !a.startsWith("--"));

// Load local config
let localEnv;
try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    localEnv = cfg?.mcpServers?.["kaycomm-pacing"]?.env || {};
} catch (e) {
    console.error(`Cannot read ${CONFIG_PATH}: ${e.message}`);
    process.exit(1);
}

const keysToSync = requestedKeys.length > 0
    ? requestedKeys.filter(k => {
        if (!localEnv[k]) { console.warn(`⚠️  ${k} not found in local config, skipping`); return false; }
        return true;
    })
    : SYNCABLE_KEYS.filter(k => localEnv[k]);

if (keysToSync.length === 0) {
    console.log("Nothing to sync.");
    process.exit(0);
}

function findRailwayCli() {
    for (const candidate of ["/opt/homebrew/bin/railway", "/usr/local/bin/railway"]) {
        if (fs.existsSync(candidate)) return candidate;
    }
    try {
        return execFileSync("which", ["railway"], { encoding: "utf8" }).trim() || null;
    } catch { return null; }
}

const railwayBin = findRailwayCli();
if (!railwayBin) {
    console.error("Railway CLI not found. Install it: brew install railway");
    process.exit(1);
}

console.log(`Syncing ${keysToSync.length} variable(s) to Railway${dryRun ? " (dry run)" : ""}...\n`);

let ok = 0, failed = 0;
for (const key of keysToSync) {
    const value = localEnv[key];
    const masked = value.length > 12 ? `...${value.slice(-6)}` : "***";
    if (dryRun) {
        console.log(`  ${key} = ${masked}`);
        ok++;
        continue;
    }
    try {
        execFileSync(railwayBin, ["variables", "set", `${key}=${value}`], {
            cwd: __dirname,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30_000,
        });
        console.log(`  ✅ ${key} (${masked})`);
        ok++;
    } catch (e) {
        console.error(`  ❌ ${key} — ${e.stderr?.toString().trim() || e.message}`);
        failed++;
    }
}

console.log(`\n${dryRun ? "Would sync" : "Synced"}: ${ok}${failed ? `, failed: ${failed}` : ""}`);
if (!dryRun && ok > 0) console.log("Railway will auto-redeploy with the updated variable(s).");
