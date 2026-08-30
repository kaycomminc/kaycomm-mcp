const { Pool } = require("pg");

let pool = null;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set — cannot connect to Postgres");
    pool = new Pool({
      connectionString: url,
      ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 3,
    });
  }
  return pool;
}

async function ensureSchema() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS change_events (
      id BIGSERIAL PRIMARY KEY,
      account_id TEXT NOT NULL,
      account_name TEXT NOT NULL,
      change_date_time TIMESTAMPTZ NOT NULL,
      resource_type TEXT,
      change_resource_name TEXT,
      resource_change_operation TEXT,
      changed_fields TEXT,
      user_email TEXT,
      campaign_name TEXT,
      ad_group_name TEXT,
      old_value JSONB,
      new_value JSONB,
      captured_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (account_id, change_resource_name, change_date_time, resource_change_operation)
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_change_events_account_time
      ON change_events (account_id, change_date_time DESC)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_change_events_resource
      ON change_events (change_resource_name)
  `);
}

async function shutdown() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, ensureSchema, shutdown };
