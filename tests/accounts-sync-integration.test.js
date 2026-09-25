// End-to-end: manage_accounts on a server with ACCOUNTS_GITHUB_TOKEN set
// (the Railway setup). accounts.json lives in memory and GitHub is faked, so
// nothing touches the real file or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');
const serverFilename = path.join(root, 'server.js');
const accountsPath = path.join(root, 'accounts.json');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaycomm-accounts-sync-'));

Object.assign(process.env, {
  MCP_TEST: '1',
  DIGEST_ENABLED: '0',
  ARCHIVE_ENABLED: '0',
  WRITE_LOG_FILE: path.join(tempDir, 'write-log.jsonl'),
  WRITE_STATE_DIR: path.join(tempDir, 'write-state'),
  ACCOUNTS_GITHUB_TOKEN: 'synthetic-gh-token',
  ACCOUNTS_GITHUB_REPO: 'o/r',
});
delete process.env.PORT;

const initial = JSON.stringify({
  routine_rules: [],
  google: { '111': { name: 'Client A', budget: 1000, mcc: '111' } },
  meta: {},
}, null, 2) + '\n';

let localFile = initial;
const gh = { text: initial, sha: 'sha1', n: 1, puts: [], failPut: null };

const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
global.fetch = async (url, options = {}) => {
  assert.match(String(url), /^https:\/\/api\.github\.com\/repos\/o\/r\/contents\/accounts\.json/);
  if (!options.method) return json(200, { sha: gh.sha, content: Buffer.from(gh.text).toString('base64') });
  const body = JSON.parse(options.body);
  gh.puts.push(body);
  if (gh.failPut) { const status = gh.failPut; gh.failPut = null; return json(status, {}); }
  if (body.sha !== gh.sha) return json(409, {});
  gh.text = Buffer.from(body.content, 'base64').toString('utf8');
  gh.sha = `sha${++gh.n}`;
  return json(200, { content: { sha: gh.sha }, commit: { sha: `abc${gh.n}def0`, html_url: `https://github.com/o/r/commit/abc${gh.n}` } });
};

const fakeFs = {
  ...fs,
  readFileSync(file, ...args) {
    if (String(file) === accountsPath) return localFile;
    return fs.readFileSync(file, ...args);
  },
  writeFileSync(file, data, ...args) {
    if (String(file) === accountsPath) { localFile = String(data); return; }
    return fs.writeFileSync(file, data, ...args);
  },
};

const serverModule = new Module(serverFilename, module);
serverModule.filename = serverFilename;
serverModule.paths = Module._nodeModulePaths(root);
const originalRequire = serverModule.require.bind(serverModule);
serverModule.require = name => (name === 'fs' ? fakeFs : originalRequire(name));
serverModule._compile(fs.readFileSync(serverFilename, 'utf8'), serverFilename);
const callHandler = serverModule.exports.makeServer()._requestHandlers.get('tools/call');

async function manage(args) {
  const wire = await callHandler({ method: 'tools/call', params: { name: 'manage_accounts', arguments: args } }, {});
  return JSON.parse(wire.content[0].text);
}

test('synced add_note commits to GitHub on top of the latest remote version', async () => {
  // A change pushed from the Mac since boot must be kept, not overwritten.
  const macVersion = JSON.parse(gh.text);
  macVersion.google['222'] = { name: 'Client B', budget: 500, mcc: '222' };
  gh.text = JSON.stringify(macVersion, null, 2) + '\n';
  gh.sha = 'mac-sha';

  const result = await manage({ action: 'update', platform: 'google', id: '111', add_note: 'Search paused on purpose', note_expires: '2026-10-25', confirm: true });
  assert.equal(result.success, true);
  assert.match(result.github_commit, /github\.com\/o\/r\/commit/);
  assert.equal(result.ephemeral_warning, undefined);

  const put = gh.puts.at(-1);
  assert.equal(put.sha, 'mac-sha');
  assert.equal(put.message, 'accounts: Client A: add note (google 111) [via Railway]');
  const saved = JSON.parse(gh.text);
  assert.equal(saved.google['222'].name, 'Client B');
  assert.equal(saved.google['111'].notes[0].text, 'Search paused on purpose');
  assert.equal(localFile, gh.text);
});

test('synced add_rule commits to GitHub', async () => {
  const result = await manage({ action: 'add_rule', rule: 'Ignore paused ads', confirm: true });
  assert.equal(result.success, true);
  assert.match(gh.puts.at(-1).message, /^accounts: add routine rule: Ignore paused ads/);
  assert.equal(JSON.parse(gh.text).routine_rules[0].text, 'Ignore paused ads');
});

test('synced server refuses budget changes without calling GitHub', async () => {
  const before = gh.puts.length;
  const result = await manage({ action: 'update', platform: 'google', id: '111', budget: 9999, confirm: true });
  assert.match(result.error, /only manages notes and routine rules/);
  assert.match(result.error, /budget/);
  assert.equal(gh.puts.length, before);
  assert.equal(JSON.parse(gh.text).google['111'].budget, 1000);
});

test('failed GitHub write leaves nothing changed', async () => {
  const beforeText = gh.text;
  gh.failPut = 409;
  const result = await manage({ action: 'update', platform: 'google', id: '111', add_note: 'lost', confirm: true });
  assert.match(result.error, /Not saved/);
  assert.equal(gh.text, beforeText);
  assert.equal(localFile, beforeText);
  const listed = await manage({ action: 'list' });
  assert.ok(!listed.google.find(a => a.id === '111').notes.some(n => n.text === 'lost'));
});

test('dry run on the synced server does not touch GitHub', async () => {
  const before = gh.puts.length;
  const result = await manage({ action: 'update', platform: 'google', id: '111', add_note: 'preview' });
  assert.equal(result.dry_run, true);
  assert.equal(gh.puts.length, before);
});
