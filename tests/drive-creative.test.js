'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/drive-creative');

test('parseDriveLink: folders, files, bare IDs, non-Drive', () => {
    assert.deepEqual(D.parseDriveLink('https://drive.google.com/drive/folders/1AbCdEfGhIjK?usp=sharing'), { kind: 'folder', id: '1AbCdEfGhIjK' });
    assert.deepEqual(D.parseDriveLink('https://drive.google.com/drive/u/0/folders/XYZ_123-abc'), { kind: 'folder', id: 'XYZ_123-abc' });
    assert.deepEqual(D.parseDriveLink('https://drive.google.com/file/d/1AbC_d-EF/view'), { kind: 'file', id: '1AbC_d-EF' });
    assert.deepEqual(D.parseDriveLink('https://drive.google.com/open?id=FILEID1234'), { kind: 'file', id: 'FILEID1234' });
    assert.deepEqual(D.parseDriveLink('1AbCdEfGhIjKlMn'), { kind: 'unknown', id: '1AbCdEfGhIjKlMn' });
    assert.equal(D.parseDriveLink('https://example.com/folders/abc'), null);
    assert.equal(D.parseDriveLink('/Users/me/img.jpg'), null);
});

test('placementFit: Meta placements and Google fields by size', () => {
    assert.deepEqual(D.placementFit({ width: 1080, height: 1080, mediaType: 'image', size: 1000 }),
        { aspect: '1:1', meta: ['feed'], google: ['SQUARE_MARKETING_IMAGE', 'LOGO'] });
    const story = D.placementFit({ width: 1080, height: 1920, mediaType: 'image' });
    assert.equal(story.aspect, '9:16');
    assert.deepEqual(story.meta, ['stories', 'reels']);
    assert.deepEqual(story.google, []);
    assert.deepEqual(D.placementFit({ width: 1200, height: 628, mediaType: 'image' }).google, ['MARKETING_IMAGE']);
    assert.deepEqual(D.placementFit({ width: 960, height: 1200, mediaType: 'image' }).google, ['PORTRAIT_MARKETING_IMAGE']);
    assert.deepEqual(D.placementFit({ width: 1200, height: 300, mediaType: 'image' }).google, ['LANDSCAPE_LOGO']);
    assert.deepEqual(D.placementFit({ width: 200, height: 200, mediaType: 'image' }).google, ['LOGO']);   // too small for square marketing
    assert.match(D.placementFit({ width: 1080, height: 1080, mediaType: 'image', size: 6e6 }).google_note, /5 MB/);
    assert.deepEqual(D.placementFit({ width: 1080, height: 1920, mediaType: 'video' }).google, []);
});

test('conceptKey groups sizes of one creative', () => {
    const k = D.conceptKey('Fall_Hiring_A_1x1.jpg');
    assert.equal(k, 'fall hiring a');
    assert.equal(D.conceptKey('Fall-Hiring-A 1080x1920 story.png'), k);
    assert.equal(D.conceptKey('fall_hiring_a_4x5_v2.jpg'), k);
    assert.notEqual(D.conceptKey('Fall_Hiring_B_1x1.jpg'), k);
    assert.equal(D.conceptKey('Fall Hiring A (1080 × 1080 px).png'), k);
    assert.equal(D.placementFit({ width: 320, height: 50, mediaType: 'image' }).display_banner, '320x50');
    assert.equal(D.placementFit({ width: 320, height: 50, mediaType: 'image' }).warning, undefined);
});

function mockDrive(tree) {
    const calls = [];
    const fetch = async (url, opts = {}) => {
        calls.push({ url, auth: opts.headers?.Authorization });
        const u = new URL(url);
        const ok = payload => ({ ok: true, status: 200, json: async () => payload, arrayBuffer: async () => payload });
        if (u.pathname.endsWith('/files')) {
            const parent = u.searchParams.get('q').match(/'([^']+)' in parents/)[1];
            return ok({ files: tree.children[parent] || [] });
        }
        const id = decodeURIComponent(u.pathname.split('/').pop());
        if (u.searchParams.get('alt') === 'media') return ok(new TextEncoder().encode(`bytes-${id}`).buffer);
        const f = tree.files[id];
        return f ? ok(f) : { ok: false, status: 404, json: async () => ({ error: { message: 'File not found' } }) };
    };
    return { fetch, calls };
}

const img = (id, name, w, h, size = 200000) => ({ id, name, mimeType: 'image/jpeg', size: String(size), imageMediaMetadata: { width: w, height: h } });
const TREE = {
    children: {
        root: [
            { id: 'c1', name: 'Summit Express', mimeType: 'application/vnd.google-apps.folder' },
            { id: 'c2', name: 'La Loma', mimeType: 'application/vnd.google-apps.folder' },
        ],
        c1: [
            img('a1', 'Hiring_A_1x1.jpg', 1080, 1080),
            img('a2', 'Hiring_A_9x16.jpg', 1080, 1920),
            { id: 'doc', name: 'brief.pdf', mimeType: 'application/pdf' },
            { id: 'sub', name: 'Nov', mimeType: 'application/vnd.google-apps.folder' },
            { id: 'sc', name: 'Shortcut img', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: 'a4', targetMimeType: 'image/png' } },
        ],
        sub: [{ id: 'a3', name: 'Promo.mp4', mimeType: 'video/mp4', size: '9000000', videoMediaMetadata: { width: 1080, height: 1350, durationMillis: '15200' } }],
    },
    files: { a1: img('a1', 'Hiring_A_1x1.jpg', 1080, 1080), a4: img('a4', 'Logo.png', 512, 512) },
};

test('listMedia walks subfolders, resolves shortcuts, skips non-media, sends auth', async () => {
    const { fetch, calls } = mockDrive(TREE);
    const client = D.createDriveClient({ fetch, getToken: async () => ({ token: 'tok' }) });
    const r = await client.listMedia('c1');
    assert.deepEqual(r.files.map(f => `${f.folder}|${f.name}`).sort(), ['Nov|Promo.mp4', '|Hiring_A_1x1.jpg', '|Hiring_A_9x16.jpg', '|Shortcut img'].sort());
    assert.equal(r.skipped_non_media, 1);
    assert.deepEqual(r.subfolders, ['Nov']);
    const video = r.files.find(f => f.type === 'video');
    assert.equal(video.duration_sec, 15.2);
    assert.equal(video.fit.aspect, '4:5');
    assert.ok(calls.every(c => c.auth === 'Bearer tok'));

    const groups = D.groupByConcept(r.files);
    const a = groups.find(g => g.concept === 'hiring a');
    assert.deepEqual(a.aspects.sort(), ['1:1', '9:16']);
    assert.deepEqual(a.missing_meta, []);

    const flat = await client.listMedia('c1', { recursive: false });
    assert.equal(flat.files.some(f => f.type === 'video'), false);
});

test('findChildFolder: exact, partial, ambiguous', async () => {
    const client = D.createDriveClient({ fetch: mockDrive(TREE).fetch, getToken: async () => ({ token: 't' }) });
    assert.equal((await client.findChildFolder('root', 'summit express')).folder.id, 'c1');
    assert.equal((await client.findChildFolder('root', 'Loma')).folder.id, 'c2');
    const none = await client.findChildFolder('root', 'Charlie');
    assert.equal(none.folder, null);
    assert.deepEqual(none.candidates, ['Summit Express', 'La Loma']);
});

test('download returns bytes privately; missing auth and 404 give actionable errors', async () => {
    const client = D.createDriveClient({ fetch: mockDrive(TREE).fetch, getToken: async () => ({ token: 't' }) });
    const dl = await client.download('a1');
    assert.equal(dl.buffer.toString(), 'bytes-a1');
    assert.equal(dl.name, 'Hiring_A_1x1.jpg');
    await assert.rejects(client.download('a1', { maxBytes: 10 }), /limit/);
    await assert.rejects(client.download('missing'), /not shared with the Drive-authorized account/);
    const noAuth = D.createDriveClient({ fetch: mockDrive(TREE).fetch, getToken: async () => ({ token: null, error: 'GOOGLE_DRIVE_REFRESH_TOKEN is not set' }) });
    await assert.rejects(noAuth.listMedia('c1'), /get-refresh-token\.js GOOGLE_DRIVE_REFRESH_TOKEN --drive/);
});

// ── MCP backend ──────────────────────────────────────────────────────────────
function mockDriveMcp(tree, { sse = false } = {}) {
    const calls = [];
    const mcpFile = f => ({ id: f.id, title: f.name, mimeType: f.mimeType, ...(f.size ? { fileSize: f.size } : {}), viewUrl: `https://drive.google.com/file/d/${f.id}` });
    const fetch = async (url, opts = {}) => {
        const body = JSON.parse(opts.body);
        calls.push({ url, auth: opts.headers?.Authorization, name: body.params.name, args: body.params.arguments });
        const { name, arguments: args } = body.params;
        let payload, isError = false;
        if (name === 'search_files') {
            const parent = args.query.match(/parentId = '([^']+)'/)[1];
            const all = (tree.children[parent] || []).map(mcpFile);
            const start = args.pageToken ? Number(args.pageToken) : 0;
            payload = { files: all.slice(start, start + 2), ...(start + 2 < all.length ? { nextPageToken: String(start + 2) } : {}) };
        } else if (name === 'get_file_metadata') {
            const f = tree.files[args.fileId];
            if (f) payload = mcpFile(f); else { isError = true; payload = 'File not found: ' + args.fileId; }
        } else if (name === 'download_file_content') {
            payload = { id: args.fileId, content: Buffer.from(`bytes-${args.fileId}`).toString('base64') };
        }
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const rpc = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }], isError } };
        const headers = { get: h => h.toLowerCase() === 'content-type' ? (sse ? 'text/event-stream' : 'application/json') : null };
        return { ok: true, status: 200, headers, json: async () => rpc, text: async () => `event: message\ndata: ${JSON.stringify(rpc)}\n\n` };
    };
    return { fetch, calls };
}

// Stand-in for sharp: dimensions keyed by file id, read back from the mock bytes.
const DIMS = { a1: [1080, 1080], a2: [1080, 1920], a4: [512, 512] };
const describeImage = async buf => { const [width, height] = DIMS[buf.toString().replace('bytes-', '')]; return { width, height }; };

test('MCP backend: lists via search_files with paging, measures images, skips shortcuts, uses filename dims for video', async () => {
    const tree = JSON.parse(JSON.stringify(TREE));
    tree.children.sub[0].name = 'Promo_1080x1350.mp4';
    const { fetch, calls } = mockDriveMcp(tree, { sse: true });
    const client = D.createDriveClient({ fetch, getToken: async () => ({ token: 'tok' }), backend: 'mcp', describeImage });
    assert.equal(client.backend, 'mcp');
    const r = await client.listMedia('c1');
    assert.equal(r.backend, 'mcp');
    assert.deepEqual(r.files.map(f => `${f.folder}|${f.name}`).sort(), ['Nov|Promo_1080x1350.mp4', '|Hiring_A_1x1.jpg', '|Hiring_A_9x16.jpg'].sort());
    assert.equal(r.skipped_non_media, 2);   // pdf + shortcut (no target info over MCP)
    assert.deepEqual(r.subfolders, ['Nov']);
    assert.equal(r.files.find(f => f.name === 'Hiring_A_9x16.jpg').fit.aspect, '9:16');
    const video = r.files.find(f => f.type === 'video');
    assert.equal(video.fit.aspect, '4:5');
    assert.equal(video.dims_source, 'filename');
    assert.ok(calls.every(c => c.url === D.DRIVE_MCP_URL && c.auth === 'Bearer tok'));
    assert.ok(calls.filter(c => c.name === 'search_files' && c.args.query === "parentId = 'c1'").length >= 2, 'paginates');
    assert.ok(!calls.some(c => /in parents|trashed/.test(c.args.query || '')), 'no REST q syntax');
});

test('MCP backend: download decodes base64, enforces limits, maps not-found', async () => {
    const client = D.createDriveClient({ fetch: mockDriveMcp(TREE).fetch, getToken: async () => ({ token: 't' }), backend: 'mcp', describeImage });
    const dl = await client.download('a1');
    assert.equal(dl.buffer.toString(), 'bytes-a1');
    assert.equal(dl.name, 'Hiring_A_1x1.jpg');
    assert.equal(dl.file.fit.aspect, '1:1');
    await assert.rejects(client.download('a1', { maxBytes: 10 }), /limit/);
    await assert.rejects(client.download('missing'), /not shared with the Drive-authorized account/);
    assert.equal((await client.findChildFolder('root', 'summit express')).folder.id, 'c1');
});

test('MCP backend: HTTP 403 points at the AI-agent client setting', async () => {
    const fetch = async () => ({ ok: false, status: 403, headers: { get: () => 'application/json' }, json: async () => ({ error: { message: 'PERMISSION_DENIED' } }) });
    const client = D.createDriveClient({ fetch, getToken: async () => ({ token: 't' }), backend: 'mcp' });
    await assert.rejects(client.listMedia('c1'), /AI-powered agent/);
});

test('dimsFromName', () => {
    assert.deepEqual(D.dimsFromName('Promo 1080x1920 story.mp4'), { width: 1080, height: 1920 });
    assert.deepEqual(D.dimsFromName('banner_300×250.png'), { width: 300, height: 250 });
    assert.equal(D.dimsFromName('Hiring_A_1x1.jpg'), null);
});
