const fs = require('node:fs');
const path = require('node:path');
const { fault } = require('./contracts');

// Storage never contains request arguments, uploaded media, or audience PII.
// Pending/unknown outcomes do not expire automatically: reconcile before retrying.
class FileWriteStore {
  constructor(directory) { this.directory = directory; }
  async reserve(key, payloadHash) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, key + '.json');
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ payloadHash, state: 'pending', created: Date.now() })); }
      finally { fs.closeSync(fd); }
      return { acquired: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // A concurrent writer may still be filling the record. Fail closed.
      let existing;
      try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { existing = { state: 'pending' }; }
      return { acquired: false, ...existing };
    }
  }
  async finish(key, state) {
    const file = path.join(this.directory, key + '.json');
    if (state === 'rejected') { fs.unlinkSync(file); return; }
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ ...existing, state, completed: Date.now() }), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
}
class PostgresWriteStore {
  constructor(getPool) { this.getPool = getPool; this.ready = null; }
  async db() {
    const pool = this.getPool();
    if (!this.ready) this.ready = pool.query(`CREATE TABLE IF NOT EXISTS mcp_write_requests (
      key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, state TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
    )`).catch(e => { this.ready = null; throw e; });
    await this.ready;
    return pool;
  }
  async reserve(key, payloadHash) {
    const db = await this.db();
    const inserted = await db.query("INSERT INTO mcp_write_requests(key,payload_hash,state) VALUES($1,$2,'pending') ON CONFLICT DO NOTHING RETURNING key", [key, payloadHash]);
    if (inserted.rowCount) return { acquired: true };
    const result = await db.query('SELECT payload_hash, state FROM mcp_write_requests WHERE key=$1', [key]);
    return { acquired: false, payloadHash: result.rows[0]?.payload_hash, state: result.rows[0]?.state || 'pending' };
  }
  async finish(key, state) {
    const db = await this.db();
    if (state === 'rejected') await db.query('DELETE FROM mcp_write_requests WHERE key=$1', [key]);
    else await db.query('UPDATE mcp_write_requests SET state=$2, completed_at=NOW() WHERE key=$1', [key, state]);
  }
}
function assertReserved(reservation) {
  if (!reservation.acquired) throw fault('DUPLICATE_WRITE_BLOCKED', `This operation is already ${reservation.state}. Reconcile its outcome before retrying; use a new idempotency_key only for a deliberately new operation.`);
}
module.exports = { FileWriteStore, PostgresWriteStore, assertReserved };
