const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { resolveShareLink, downloadMedia, describeImage, createChunkStore, filenameFromDisposition } = require('../src/meta-media');

test('share links: Google Drive /file/d/{id}/view and ?id= forms become direct downloads', () => {
    const view = resolveShareLink('https://drive.google.com/file/d/1AbC_d-EF/view?usp=sharing');
    assert.deepEqual(view, { provider: 'google_drive', file_id: '1AbC_d-EF', url: 'https://drive.usercontent.google.com/download?id=1AbC_d-EF&export=download&confirm=t' });
    assert.equal(resolveShareLink('https://drive.google.com/open?id=XYZ').file_id, 'XYZ');
    assert.equal(resolveShareLink('https://drive.google.com/uc?export=download&id=XYZ').file_id, 'XYZ');
    assert.equal(resolveShareLink('https://drive.google.com/drive/folders/abc'), null);
});

test('share links: Dropbox forces dl=1 and keeps rlkey', () => {
    const r = resolveShareLink('https://www.dropbox.com/scl/fi/abc123/hire.jpg?rlkey=k9&dl=0');
    assert.equal(r.provider, 'dropbox');
    const u = new URL(r.url);
    assert.equal(u.searchParams.get('dl'), '1');
    assert.equal(u.searchParams.get('rlkey'), 'k9');
    assert.equal(new URL(resolveShareLink('https://www.dropbox.com/s/xyz/a.png?raw=1').url).searchParams.get('raw'), null);
});

test('share links: other URLs are left alone', () => {
    assert.equal(resolveShareLink('https://cdn.example.com/a.jpg'), null);
    assert.equal(resolveShareLink('not a url'), null);
});

const fakeResponse = (body, headers, status = 200) => ({
    ok: status < 300, status,
    headers: { get: k => headers[k.toLowerCase()] ?? null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
});

test('download: image content-type is accepted and filename read from Content-Disposition', async () => {
    const png = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: '#123456' } }).png().toBuffer();
    const r = await downloadMedia('https://x', { fetch: async () => fakeResponse(png, { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="hire.png"' }) });
    assert.equal(r.mediaType, 'image');
    assert.equal(r.filename, 'hire.png');
    assert.deepEqual(await describeImage(r.buffer), { width: 1080, height: 1350, format: 'png' });
});

test('download: HTML (private link / interstitial) is rejected with a sharing hint', async () => {
    await assert.rejects(
        downloadMedia('https://x', { fetch: async () => fakeResponse(Buffer.from('<html>'), { 'content-type': 'text/html; charset=utf-8' }) }),
        /not an image or video — got a web page.*Anyone with the link/);
});

test('download: HTTP errors and oversize files are rejected', async () => {
    await assert.rejects(downloadMedia('https://x', { fetch: async () => fakeResponse(Buffer.alloc(0), {}, 404) }), /HTTP 404/);
    await assert.rejects(downloadMedia('https://x', { maxBytes: 10, fetch: async () => fakeResponse(Buffer.alloc(20), { 'content-type': 'image/jpeg' }) }), /limit is 10/);
});

test('Content-Disposition filename* (RFC 5987) is decoded', () => {
    assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''Summit%20Hire.jpg"), 'Summit Hire.jpg');
});

test('chunks: arbitrary base64 splits, out-of-order arrival and retries reassemble exactly', async () => {
    const original = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#ff0000' } }).jpeg().toBuffer();
    const b64 = original.toString('base64');
    const parts = [b64.slice(0, 7), b64.slice(7, 101), b64.slice(101)];   // not multiples of 4
    const store = createChunkStore();
    const base = { upload_id: 'u1', account_id: 'act_1', total_chunks: 3, name: 'x.jpg' };
    assert.equal(store.put({ ...base, chunk_index: 2, data: parts[2] }).complete, false);
    store.put({ ...base, chunk_index: 0, data: 'data:image/jpeg;base64,' + parts[0] });
    store.put({ ...base, chunk_index: 0, data: parts[0] });              // idempotent retry
    const s = store.put({ ...base, chunk_index: 1, data: parts[1] });
    assert.equal(s.complete, true);
    const { buffer, name } = store.assemble('u1', 'act_1');
    assert.equal(Buffer.compare(buffer, original), 0);
    assert.equal(name, 'x.jpg');
});

test('chunks: missing chunks, conflicting retries and mismatched totals/accounts are errors', () => {
    const store = createChunkStore();
    const base = { upload_id: 'u2', account_id: 'act_1', total_chunks: 2 };
    store.put({ ...base, chunk_index: 0, data: 'QUJD' });
    assert.throws(() => store.assemble('u2', 'act_1'), /missing chunks: 1/);
    assert.throws(() => store.put({ ...base, chunk_index: 0, data: 'REVG' }), /different data/);
    assert.throws(() => store.put({ ...base, total_chunks: 3, chunk_index: 1, data: 'QUJD' }), /total_chunks=2/);
    assert.throws(() => store.put({ ...base, account_id: 'act_2', chunk_index: 1, data: 'QUJD' }), /different account/);
    assert.throws(() => store.put({ ...base, chunk_index: 2, data: 'QUJD' }), /chunk_index must be 0-1/);
    assert.throws(() => store.put({ ...base, chunk_index: 1, data: 'not base64!' }), /base64/);
    assert.throws(() => store.assemble('u2', 'act_2'), /No staged upload/);
});

test('chunks: incomplete uploads expire 30 minutes after the first chunk', () => {
    let t = 0;
    const store = createChunkStore({ now: () => t });
    store.put({ upload_id: 'u3', account_id: 'a', total_chunks: 2, chunk_index: 0, data: 'QUJD' });
    t = 29 * 60 * 1000;
    assert.equal(store.status('u3', 'a').received, 1);
    t = 30 * 60 * 1000 + 1;
    assert.equal(store.status('u3', 'a'), null);
    assert.equal(store.size, 0);
});

test('chunks: total size cap discards the upload', () => {
    const store = createChunkStore({ maxBytes: 6 });
    store.put({ upload_id: 'u4', account_id: 'a', total_chunks: 3, chunk_index: 0, data: 'QUJD' });
    assert.throws(() => store.put({ upload_id: 'u4', account_id: 'a', total_chunks: 3, chunk_index: 1, data: 'QUJDREVG' }), /exceeds 6 bytes/);
    assert.equal(store.size, 0);
});
