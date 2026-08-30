/**
 * Change event archiver.
 *
 * Pulls the last 7 days of change_event data from every Google Ads account
 * in accounts.json and upserts into Postgres. The unique constraint on
 * (account_id, change_resource_name, change_date_time, resource_change_operation)
 * makes reruns idempotent.
 *
 * Run daily via cron. 7-day window (not 30) keeps each run small and survives
 * a few missed runs thanks to overlap + dedup.
 */

const path = require("path");
const fs = require("fs");
const { getPool, ensureSchema } = require("./db");

const ACCOUNTS_FILE = path.join(__dirname, "..", "..", "accounts.json");
const LOOKBACK_DAYS = 7;
const PAGE_SIZE = 10000;

function loadGoogleAccounts() {
  const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
  return Object.entries(data.google || {});
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

async function getAccessToken(customerId, info) {
  const refreshToken =
    (info.refresh_token_env && process.env[info.refresh_token_env]) ||
    process.env.GOOGLE_REFRESH_TOKEN;
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error(data.error_description || JSON.stringify(data));
  return data.access_token;
}

async function fetchChangeEvents(token, customerId, mccId, startDate, today) {
  const apiVersion = process.env.GOOGLE_API_VERSION || "v19";
  const allRows = [];
  let pageToken = null;

  do {
    const query = `
      SELECT change_event.change_date_time,
             change_event.change_resource_type,
             change_event.change_resource_name,
             change_event.resource_change_operation,
             change_event.changed_fields,
             change_event.user_email,
             change_event.old_resource,
             change_event.new_resource,
             change_event.campaign,
             change_event.ad_group
      FROM change_event
      WHERE change_event.change_date_time BETWEEN '${startDate}' AND '${today}'
      ORDER BY change_event.change_date_time DESC
      LIMIT ${PAGE_SIZE}`;

    const body = pageToken ? { query, pageToken } : { query };
    const resp = await fetch(
      `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/googleAds:search`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "developer-token": process.env.GOOGLE_DEVELOPER_TOKEN,
          "login-customer-id": mccId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
    const data = await resp.json();
    if (!resp.ok) {
      const msg = data?.error?.message || JSON.stringify(data);
      throw new Error(`Google Ads API ${resp.status}: ${msg}`);
    }
    allRows.push(...(data.results || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return allRows;
}

function rowToRecord(row, accountId, accountName) {
  const e = row.changeEvent;
  return {
    account_id: accountId,
    account_name: accountName,
    change_date_time: e.changeDateTime,
    resource_type: e.changeResourceType || null,
    change_resource_name: e.changeResourceName || null,
    resource_change_operation: e.resourceChangeOperation || null,
    changed_fields: e.changedFields || null,
    user_email: e.userEmail || null,
    campaign_name: e.campaign || null,
    ad_group_name: e.adGroup || null,
    old_value: e.oldResource ? JSON.stringify(e.oldResource) : null,
    new_value: e.newResource ? JSON.stringify(e.newResource) : null,
  };
}

async function insertRecords(db, records) {
  if (records.length === 0) return { inserted: 0, skipped: 0 };

  let inserted = 0;
  let skipped = 0;
  const BATCH = 100;

  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let idx = 1;

    for (const r of batch) {
      const placeholders = [];
      for (const val of [
        r.account_id, r.account_name, r.change_date_time, r.resource_type,
        r.change_resource_name, r.resource_change_operation, r.changed_fields,
        r.user_email, r.campaign_name, r.ad_group_name, r.old_value, r.new_value,
      ]) {
        placeholders.push(`$${idx++}`);
        params.push(val);
      }
      values.push(`(${placeholders.join(", ")})`);
    }

    const res = await db.query(
      `INSERT INTO change_events
        (account_id, account_name, change_date_time, resource_type,
         change_resource_name, resource_change_operation, changed_fields,
         user_email, campaign_name, ad_group_name, old_value, new_value)
       VALUES ${values.join(", ")}
       ON CONFLICT (account_id, change_resource_name, change_date_time, resource_change_operation)
       DO NOTHING`,
      params
    );
    inserted += res.rowCount;
    skipped += batch.length - res.rowCount;
  }

  return { inserted, skipped };
}

async function collectAll() {
  await ensureSchema();
  const db = getPool();
  const accounts = loadGoogleAccounts();
  const startDate = daysAgo(LOOKBACK_DAYS);
  const today = new Date().toISOString().split("T")[0];
  const results = [];

  for (const [cid, info] of accounts) {
    const label = info.name || cid;
    try {
      const token = await getAccessToken(cid, info);
      const rows = await fetchChangeEvents(token, cid, info.mcc || cid, startDate, today);
      const records = rows.map((r) => rowToRecord(r, cid, info.name));
      const { inserted, skipped } = await insertRecords(db, records);
      console.log(`[archive] ${label}: ${rows.length} fetched, ${inserted} inserted, ${skipped} dupes`);
      results.push({ account: label, fetched: rows.length, inserted, skipped });
    } catch (err) {
      console.error(`[archive] ${label}: ERROR — ${err.message}`);
      results.push({ account: label, error: err.message });
    }
  }

  return results;
}

module.exports = { collectAll };

if (require.main === module) {
  collectAll()
    .then((results) => {
      console.log("\n[archive] Summary:", JSON.stringify(results, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("[archive] Fatal:", err);
      process.exit(1);
    });
}
