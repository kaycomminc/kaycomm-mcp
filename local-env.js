/**
 * Local credential store for the helper scripts (test.js, refresh-meta-token.js,
 * sync-to-railway.js). Credentials live in ./.env (gitignored, chmod 600) as
 * plain KEY=VALUE lines. Production reads Railway variables instead.
 */
const fs   = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, ".env");

function readEnvFile() {
    const vars = {};
    let raw;
    try { raw = fs.readFileSync(ENV_PATH, "utf8"); }
    catch (_) { return vars; }
    for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
        if (m) vars[m[1]] = m[2].trim();
    }
    return vars;
}

// Fill process.env from .env without overriding anything already set
function loadLocalEnv() {
    for (const [k, v] of Object.entries(readEnvFile())) {
        if (!process.env[k]) process.env[k] = v;
    }
}

// Set or replace one key in .env, keeping other lines and comments intact
function writeEnvVar(key, value) {
    let lines = [];
    try { lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/); } catch (_) { /* new file */ }
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const idx = lines.findIndex(l => l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1] === key);
    if (idx >= 0) lines[idx] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
    fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n", { mode: 0o600 });
    fs.chmodSync(ENV_PATH, 0o600);
}

// Claude Desktop launches the local MCP with the env block in its config, and
// those values WIN over ./.env (loadLocalEnv never overrides). So a token
// renewed only in .env leaves the running MCP on the stale one. This updates
// the key in every MCP server env block that already defines it.
// Returns the names of the servers updated ([] if config or key not found).
const DESKTOP_CONFIG_PATH = path.join(
    process.env.HOME || "", "Library", "Application Support", "Claude", "claude_desktop_config.json");

function writeDesktopConfigVar(key, value) {
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(DESKTOP_CONFIG_PATH, "utf8")); }
    catch (_) { return []; }
    const updated = [];
    for (const [name, server] of Object.entries(cfg.mcpServers || {})) {
        if (server && server.env && Object.prototype.hasOwnProperty.call(server.env, key)) {
            server.env[key] = value;
            updated.push(name);
        }
    }
    if (updated.length) {
        const tmp = DESKTOP_CONFIG_PATH + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
        fs.renameSync(tmp, DESKTOP_CONFIG_PATH);
    }
    return updated;
}

module.exports = { ENV_PATH, DESKTOP_CONFIG_PATH, readEnvFile, loadLocalEnv, writeEnvVar, writeDesktopConfigVar };
