#!/usr/bin/env node
/**
 * Bulk-set Google Ads conversion actions to SECONDARY.
 *
 * Usage:
 *   node set-conversions-secondary.js <customer_id> [--filter <substring>] [--dry-run]
 *
 * Lists all conversion actions for the account, lets you confirm which ones
 * to demote, then mutates them in one batch.
 *
 * Env vars (same as server.js):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
 *   GOOGLE_DEVELOPER_TOKEN
 *
 * The account's MCC (login-customer-id) is read from accounts.json.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const GOOGLE_API_VERSION = "v24";

const GOOGLE_CLIENT_ID       = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET   = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN   = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_DEVELOPER_TOKEN = process.env.GOOGLE_DEVELOPER_TOKEN;

async function getAccessToken(refreshToken) {
    const resp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
        }),
    });
    const data = await resp.json();
    if (!data.access_token) throw new Error("Token error: " + (data.error_description || JSON.stringify(data)));
    return data.access_token;
}

function loadMcc(customerId) {
    const accountsPath = path.join(__dirname, "accounts.json");
    const data = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
    const info = (data.google || {})[customerId];
    if (!info) throw new Error(`Customer ${customerId} not found in accounts.json`);
    return info.mcc || customerId;
}

function getRefreshToken(customerId) {
    const accountsPath = path.join(__dirname, "accounts.json");
    const data = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
    const info = (data.google || {})[customerId];
    if (info?.refresh_token_env && process.env[info.refresh_token_env]) {
        return process.env[info.refresh_token_env];
    }
    return GOOGLE_REFRESH_TOKEN;
}

async function googleSearch(token, customerId, mccId, query) {
    const resp = await fetch(
        `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers/${customerId}/googleAds:search`,
        {
            method: "POST",
            headers: {
                "Authorization":       `Bearer ${token}`,
                "developer-token":     GOOGLE_DEVELOPER_TOKEN,
                "login-customer-id":   mccId,
                "Content-Type":        "application/json",
            },
            body: JSON.stringify({ query }),
        }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(JSON.stringify(data.error, null, 2));
    return data.results || [];
}

async function mutateConversions(token, customerId, mccId, operations) {
    const resp = await fetch(
        `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers/${customerId}/googleAds:mutate`,
        {
            method: "POST",
            headers: {
                "Authorization":     `Bearer ${token}`,
                "developer-token":   GOOGLE_DEVELOPER_TOKEN,
                "login-customer-id": mccId,
                "Content-Type":      "application/json",
            },
            body: JSON.stringify({ mutateOperations: operations }),
        }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(JSON.stringify(data.error, null, 2));
    return data;
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const filterIdx = args.indexOf("--filter");
    const filter = filterIdx !== -1 ? args[filterIdx + 1]?.toLowerCase() : null;
    const customerId = args.find(a => !a.startsWith("--") && a !== filter)?.replace(/-/g, "");

    if (!customerId) {
        console.error("Usage: node set-conversions-secondary.js <customer_id> [--filter <substring>] [--dry-run]");
        process.exit(1);
    }

    const mccId = loadMcc(customerId);
    const refreshToken = getRefreshToken(customerId);
    const token = await getAccessToken(refreshToken);

    console.log(`\nFetching conversion actions for ${customerId} (MCC: ${mccId})...\n`);

    const rows = await googleSearch(token, customerId, mccId, `
        SELECT conversion_action.resource_name,
               conversion_action.name,
               conversion_action.category,
               conversion_action.primary_for_goal,
               conversion_action.status,
               conversion_action.type
        FROM conversion_action
        WHERE conversion_action.status = 'ENABLED'
        ORDER BY conversion_action.name
    `);

    if (!rows.length) {
        console.log("No enabled conversion actions found.");
        return;
    }

    let actions = rows.map(r => r.conversionAction);

    if (filter) {
        actions = actions.filter(a => a.name.toLowerCase().includes(filter));
    }

    const primary = actions.filter(a => a.primaryForGoal);
    const secondary = actions.filter(a => !a.primaryForGoal);

    console.log("PRIMARY conversion actions:");
    primary.forEach((a, i) => console.log(`  [${i + 1}] ${a.name}  (${a.category}, ${a.type})`));

    if (secondary.length) {
        console.log("\nAlready SECONDARY:");
        secondary.forEach(a => console.log(`  - ${a.name}  (${a.category})`));
    }

    if (!primary.length) {
        console.log("\nNo primary conversion actions to demote.");
        return;
    }

    console.log(`\nEnter numbers to make secondary (comma-separated), "all" for all, or "q" to quit:`);
    const answer = await ask("> ");

    if (answer.toLowerCase() === "q") return;

    let selected;
    if (answer.toLowerCase() === "all") {
        selected = primary;
    } else {
        const indices = answer.split(",").map(s => parseInt(s.trim(), 10) - 1);
        selected = indices.filter(i => i >= 0 && i < primary.length).map(i => primary[i]);
    }

    if (!selected.length) {
        console.log("No valid selections.");
        return;
    }

    console.log(`\nWill set ${selected.length} conversion(s) to SECONDARY:`);
    selected.forEach(a => console.log(`  - ${a.name}`));

    if (dryRun) {
        console.log("\n[DRY RUN] No changes made.");
        return;
    }

    const confirm = await ask("\nProceed? (y/n) ");
    if (confirm.toLowerCase() !== "y") {
        console.log("Cancelled.");
        return;
    }

    const ops = selected.map(a => ({
        conversionActionOperation: {
            update: {
                resourceName: a.resourceName,
                primaryForGoal: false,
            },
            updateMask: "primary_for_goal",
        },
    }));

    const result = await mutateConversions(token, customerId, mccId, ops);
    console.log(`\nDone — ${result.mutateOperationResponses?.length || 0} conversion action(s) set to secondary.`);
}

main().catch(err => { console.error("Error:", err.message); process.exit(1); });
