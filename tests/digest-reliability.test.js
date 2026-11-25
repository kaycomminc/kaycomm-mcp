const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildAccountsFromConfig, buildAccountsFromData } = require('../src/digest/config');
const { gatherAccounts, buildSubject } = require('../src/digest/digest');

const config = accounts => ({
  accounts,
  thresholds: { warnPercent: 10, alertPercent: 20 },
  ignoreUnlisted: [],
});

test('digest builds account roster from each current registry snapshot and current date', () => {
  const registry = {
    google: { '1': { name: 'Current', budget: 100 }, '2': { name: 'Flight', budget: 200, flight_start: '2026-11-01', flight_end: '2026-11-30' } },
    meta: { 'act_1': { name: 'Current', budget: 100 } },
  };
  const first = buildAccountsFromData(registry, new Date('2026-11-24T12:00:00Z'));
  assert.deepEqual(first.map(row => row.name), ['Current', 'Flight']);
  registry.google['3'] = { name: 'Added', budget: 10 };
  registry.google['2'].flight_end = '2026-11-24';
  const next = buildAccountsFromData(registry, new Date('2026-11-25T12:00:00Z'));
  assert.deepEqual(next.map(row => row.name), ['Current', 'Added']);
});

test('digest standalone account file can be re-read between runs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaycomm-digest-roster-'));
  const file = path.join(directory, 'accounts.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ google: { a: { name: 'First', budget: 10 } } }));
    assert.equal(buildAccountsFromConfig({ filePath: file, now: new Date('2026-11-25T12:00:00Z') })[0].name, 'First');
    fs.writeFileSync(file, JSON.stringify({ google: { b: { name: 'Second', budget: 20 } } }));
    assert.equal(buildAccountsFromConfig({ filePath: file, now: new Date('2026-11-25T12:00:00Z') })[0].name, 'Second');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('top-level tool errors become unavailable data and cannot yield healthy subject', async () => {
  const result = await gatherAccounts({ callToolWithRetry: async () => ({
    error: 'provider unavailable', _meta: { status: 'error', errors: [{ message: 'provider unavailable' }] },
  }) }, config([{ name: 'Client A', label: 'Client A', platforms: ['google', 'meta'] }]));
  assert.equal(result.pullStatus, 'error');
  assert.match(buildSubject(result), /data unavailable/);
  assert.doesNotMatch(buildSubject(result), /all on pace/);
});

test('partial rows retain healthy account data and report missing accounts as incomplete', async () => {
  const result = await gatherAccounts({ callToolWithRetry: async () => ({
    google: [{ account: 'Client A', budget: 100, mtd_spend: 50, pct_expected: 100 }],
    meta: [{ error: 'authentication failed' }],
    _meta: { status: 'partial_success', errors: [] },
  }) }, config([
    { name: 'Client A', label: 'Client A', platforms: ['google', 'meta'] },
    { name: 'Client B', label: 'Client B', platforms: ['google'] },
  ]));
  assert.equal(result.accounts[0].platforms[0].status, 'ok');
  assert.equal(result.accounts[1].platforms[0].missing, true);
  assert.match(buildSubject(result), /data unavailable/);
  assert.doesNotMatch(buildSubject(result), /all on pace/);
});

test('successful empty reports are distinguished from full failures', async () => {
  const successful = await gatherAccounts({ callToolWithRetry: async () => ({
    google: [], meta: [], _meta: { status: 'success' },
  }) }, config([{ name: 'Client A', label: 'Client A', platforms: ['google'] }]));
  assert.match(buildSubject(successful), /data incomplete/);
  assert.doesNotMatch(buildSubject(successful), /all on pace/);
});
