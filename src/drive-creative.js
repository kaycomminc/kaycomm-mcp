'use strict';

// Google Drive creative intake: private (OAuth) folder listing and file
// downloads, plus per-platform placement fit for each image.
//
// Auth is a refresh token with the drive.readonly scope
// (GOOGLE_DRIVE_REFRESH_TOKEN, minted with `node get-refresh-token.js
// GOOGLE_DRIVE_REFRESH_TOKEN --drive`), so creative folders never need
// "Anyone with the link" sharing. Without it, single-file share links still
// fall back to the public download path in meta-media.js.

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink,' +
    'imageMediaMetadata(width,height),videoMediaMetadata(width,height,durationMillis),' +
    'shortcutDetails(targetId,targetMimeType)';
const MAX_DEPTH = 3;
const MAX_FILES = 500;

// ── Links ────────────────────────────────────────────────────────────────────
// Returns { kind: 'folder'|'file', id } for Drive links or bare IDs, else null.
function parseDriveLink(raw) {
    const s = String(raw || '').trim();
    if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return { kind: 'unknown', id: s };
    let u;
    try { u = new URL(s); } catch (_) { return null; }
    const host = u.hostname.toLowerCase();
    if (host !== 'drive.google.com' && host !== 'docs.google.com') return null;
    const folder = u.pathname.match(/\/folders\/([A-Za-z0-9_-]+)/)?.[1];
    if (folder) return { kind: 'folder', id: folder };
    const file = u.pathname.match(/\/file\/d\/([A-Za-z0-9_-]+)/)?.[1] || u.searchParams.get('id');
    return file ? { kind: 'file', id: file } : null;
}

// ── Placement fit ────────────────────────────────────────────────────────────
const RATIOS = [
    { label: '1:1', value: 1 },
    { label: '4:5', value: 0.8 },
    { label: '9:16', value: 9 / 16 },
    { label: '1.91:1', value: 1.91 },
    { label: '16:9', value: 16 / 9 },
    { label: '4:1', value: 4 },
    { label: '2:3', value: 2 / 3 },
];

function aspectLabel(w, h) {
    if (!w || !h) return null;
    const r = w / h;
    const hit = RATIOS.find(x => Math.abs(r - x.value) / x.value <= 0.02);
    return hit ? hit.label : `${(r).toFixed(2)}:1`;
}

// Google Ads asset field types (PMax / Demand Gen / Display) with minimum
// sizes; Google allows 1% aspect tolerance.
const GOOGLE_IMAGE_SPECS = [
    { field: 'MARKETING_IMAGE', ratio: 1.91, min: [600, 314] },
    { field: 'SQUARE_MARKETING_IMAGE', ratio: 1, min: [300, 300] },
    { field: 'PORTRAIT_MARKETING_IMAGE', ratio: 0.8, min: [480, 600] },
    { field: 'LOGO', ratio: 1, min: [128, 128] },
    { field: 'LANDSCAPE_LOGO', ratio: 4, min: [512, 128] },
];
const GOOGLE_MAX_IMAGE_BYTES = 5120 * 1024;

const META_PLACEMENTS = {
    '1:1': ['feed'], '4:5': ['feed'], '9:16': ['stories', 'reels'], '1.91:1': ['right_column', 'search', 'link'],
};

function googleFields(w, h) {
    if (!w || !h) return [];
    const r = w / h;
    return GOOGLE_IMAGE_SPECS
        .filter(s => Math.abs(r - s.ratio) / s.ratio <= 0.01 && w >= s.min[0] && h >= s.min[1])
        .map(s => s.field);
}

// Standard IAB display banner sizes — fixed-size uploaded display ads, not
// responsive assets, so they get a label instead of Meta/Google asset fields.
const IAB_BANNERS = new Set(['300x250', '336x280', '728x90', '320x50', '320x100', '300x600', '160x600', '970x250', '970x90', '468x60', '300x50', '250x250', '200x200', '120x600']);

function placementFit({ width, height, mediaType, size }) {
    const aspect = aspectLabel(width, height);
    const fit = { aspect, meta: META_PLACEMENTS[aspect] || [] };
    if (mediaType === 'image' && IAB_BANNERS.has(`${width}x${height}`)) fit.display_banner = `${width}x${height}`;
    if (mediaType === 'image') {
        fit.google = googleFields(width, height);
        if (fit.google.length && size && size > GOOGLE_MAX_IMAGE_BYTES) fit.google_note = 'Over Google\'s 5 MB image limit';
    }
    if (mediaType === 'video') fit.google = [];   // Google video assets must be YouTube
    if (mediaType === 'image' && !fit.display_banner && width && width < 600 && height < 600) fit.warning = 'Below 600px — too small for most placements';
    return fit;
}

// "Fall_Hiring_A_1x1.jpg" / "fall-hiring-a 1080x1350 feed.png" → "fall hiring a",
// so sizes of the same concept group together.
function conceptKey(name) {
    return String(name || '')
        .replace(/\.[A-Za-z0-9]+$/, '')
        .replace(/[_\-()[\]]+/g, ' ')        // "_" is a word char, so split first for \b below
        .replace(/\b\d{2,5}\s*[x×]\s*\d{2,5}\b/gi, ' ')
        .replace(/\b(1\.91|16|9|4|1|2)\s*[x×:_-]\s*(1|9|16|5|3)\b/gi, ' ')
        .replace(/\b(square|story|stories|reel|reels|feed|portrait|landscape|vertical|horizontal|final|px|v\d+)\b/gi, ' ')
        .replace(/[_\-.()[\]]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function mediaTypeOf(mime) {
    if (String(mime).startsWith('image/')) return 'image';
    if (String(mime).startsWith('video/')) return 'video';
    return null;
}

// ── Transports ───────────────────────────────────────────────────────────────
// Two ways to reach Drive, selected with DRIVE_BACKEND:
//   rest (default) — Drive REST v3 directly.
//   mcp            — Google's remote Drive MCP server (drivemcp.googleapis.com).
//                    Google requires AI agents to use MCP for Workspace data
//                    from 2027-02-01. Same drive.readonly token; the OAuth client
//                    must be marked "Use this client for an AI-powered agent" and
//                    drivemcp.googleapis.com enabled on the Cloud project.
// Each transport returns files in REST shape (id, name, mimeType, size, ...) so
// the listing, placement-fit and grouping code above stays transport-agnostic.

async function authHeader(getToken) {
    const { token, error } = await getToken();
    if (!token) throw new Error(`Drive auth: ${error || 'GOOGLE_DRIVE_REFRESH_TOKEN is not set'}. Run: node get-refresh-token.js GOOGLE_DRIVE_REFRESH_TOKEN --drive`);
    return { Authorization: `Bearer ${token}` };
}

function createRestTransport({ fetch, getToken }) {
    async function api(pathAndQuery) {
        const resp = await fetch(`${DRIVE_API}/${pathAndQuery}`, { headers: await authHeader(getToken) });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            const msg = data?.error?.message || `HTTP ${resp.status}`;
            if (resp.status === 404) throw new Error(`Drive: not found or not shared with the Drive-authorized account (${msg})`);
            if (resp.status === 403 && /scope/i.test(msg)) throw new Error('Drive: token is missing the drive.readonly scope — re-run get-refresh-token.js with --drive');
            throw new Error(`Drive: ${msg}`);
        }
        return data;
    }
    return {
        name: 'rest',
        getFile: id => api(`files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`),
        async listChildren(folderId) {
            const out = [];
            let pageToken = '';
            do {
                const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
                const data = await api(`files?q=${q}&fields=${encodeURIComponent(`nextPageToken,files(${FILE_FIELDS})`)}` +
                    `&pageSize=1000&orderBy=name&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
                out.push(...(data.files || []));
                pageToken = data.nextPageToken || '';
            } while (pageToken);
            return out;
        },
        async fetchBytes(meta) {
            const resp = await fetch(`${DRIVE_API}/files/${encodeURIComponent(meta.id)}?alt=media&supportsAllDrives=true`, { headers: await authHeader(getToken) });
            if (!resp.ok) throw new Error(`Drive download failed for '${meta.name}' (HTTP ${resp.status})`);
            return Buffer.from(await resp.arrayBuffer());
        },
    };
}

const DRIVE_MCP_URL = 'https://drivemcp.googleapis.com/mcp/v1';

// The MCP File resource uses different names and has no image/video metadata.
function fromMcpFile(f) {
    return {
        id: f.id, name: f.title, mimeType: f.mimeType,
        size: f.fileSize ?? null, modifiedTime: f.modifiedTime || null, webViewLink: f.viewUrl || null,
    };
}

// Streamable HTTP replies are JSON or an SSE stream; take the JSON-RPC response.
async function readRpcResponse(resp) {
    const type = resp.headers?.get?.('content-type') || '';
    if (!type.includes('text/event-stream')) return resp.json();
    const text = await resp.text();
    const messages = text.split(/\r?\n\r?\n/)
        .map(ev => ev.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n'))
        .filter(Boolean).map(d => { try { return JSON.parse(d); } catch (_) { return null; } });
    return messages.find(m => m && ('result' in m || 'error' in m)) || {};
}

function createMcpTransport({ fetch, getToken, url = DRIVE_MCP_URL }) {
    let nextId = 1;
    async function callTool(name, args) {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { ...(await authHeader(getToken)), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
        });
        const data = await readRpcResponse(resp).catch(() => ({}));
        if (!resp.ok || data.error) {
            const msg = data?.error?.message || `HTTP ${resp.status}`;
            if (resp.status === 401 || resp.status === 403) throw new Error(`Drive MCP: access denied (${msg}). Check drivemcp.googleapis.com is enabled and the OAuth client is marked "Use this client for an AI-powered agent".`);
            throw new Error(`Drive MCP ${name}: ${msg}`);
        }
        const result = data.result || {};
        let payload = result.structuredContent;
        if (!payload) {
            const text = (result.content || []).find(c => c.type === 'text')?.text;
            try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = { _text: text }; }
        }
        if (result.isError) {
            const msg = payload?._text || payload?.error?.message || payload?.message || 'tool error';
            if (/not found/i.test(msg)) throw new Error(`Drive: not found or not shared with the Drive-authorized account (${msg})`);
            throw new Error(`Drive MCP ${name}: ${msg}`);
        }
        return payload;
    }
    return {
        name: 'mcp',
        getFile: async id => fromMcpFile(await callTool('get_file_metadata', { fileId: id, excludeContentSnippets: true })),
        async listChildren(folderId) {
            const out = [];
            let pageToken = '';
            do {
                const data = await callTool('search_files', {
                    query: `parentId = '${String(folderId).replace(/'/g, "\\'")}'`,
                    excludeContentSnippets: true, pageSize: 100, ...(pageToken ? { pageToken } : {}),
                });
                out.push(...(data.files || []).map(fromMcpFile));
                pageToken = data.nextPageToken || '';
            } while (pageToken);
            return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        },
        async fetchBytes(meta) {
            const data = await callTool('download_file_content', { fileId: meta.id });
            if (typeof data.content !== 'string') throw new Error(`Drive download failed for '${meta.name}' (no content)`);
            return Buffer.from(data.content, 'base64');
        },
    };
}

// "Promo_1080x1920.mp4" → { width: 1080, height: 1920 }; used when Drive gives no dimensions.
function dimsFromName(name) {
    const m = String(name || '').match(/(?:^|[^\d])(\d{2,5})\s*[x×]\s*(\d{2,5})(?!\d)/i);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

// ── Client ───────────────────────────────────────────────────────────────────
// deps: { fetch, getToken: async () => ({ token, error }), backend?: 'rest'|'mcp',
//         describeImage?: async (buffer) => ({ width, height }), mcpUrl? }
// With the MCP backend, image dimensions are measured by downloading the image
// (bytes are discarded; nothing is kept). Up to MAX_PROBES per listing.
const MAX_PROBES = 150;

function createDriveClient({ fetch, getToken, backend = 'rest', describeImage, mcpUrl } = {}) {
    const transport = backend === 'mcp' ? createMcpTransport({ fetch, getToken, url: mcpUrl }) : createRestTransport({ fetch, getToken });
    const needsDims = f => !f.imageMediaMetadata && !f.videoMediaMetadata;

    async function addDims(f, budget) {
        if (!needsDims(f)) return f;
        const type = mediaTypeOf(f.mimeType);
        if (type === 'image' && describeImage && (!budget || budget.left-- > 0)) {
            try {
                const d = await describeImage(await transport.fetchBytes(f));
                if (d?.width && d?.height) return { ...f, imageMediaMetadata: { width: d.width, height: d.height } };
            } catch (_) { /* fall through to name hint */ }
        }
        const hint = type ? dimsFromName(f.name) : null;
        if (hint) return { ...f, [type === 'image' ? 'imageMediaMetadata' : 'videoMediaMetadata']: hint, dims_from_name: true };
        return f;
    }

    async function getFile(id) {
        const f = await transport.getFile(id);
        if (f.mimeType === SHORTCUT_MIME && f.shortcutDetails?.targetId) {
            const target = await getFile(f.shortcutDetails.targetId);
            return { ...target, name: f.name || target.name };
        }
        return addDims(f);
    }

    const listChildren = folderId => transport.listChildren(folderId);

    // Media files under a folder (recursing into subfolders up to MAX_DEPTH),
    // each with a relative `folder` path. Non-media files are counted, not returned.
    async function listMedia(folderId, { recursive = true } = {}) {
        const files = [];
        let skipped = 0;
        const subfolders = [];
        const budget = { left: MAX_PROBES };
        async function walk(id, rel, depth) {
            for (let f of await listChildren(id)) {
                if (f.mimeType === SHORTCUT_MIME) {
                    // The MCP backend returns no shortcut target, so those are skipped.
                    if (!f.shortcutDetails) { skipped++; continue; }
                    f = { ...f, id: f.shortcutDetails.targetId, mimeType: f.shortcutDetails.targetMimeType };
                    if (f.mimeType !== FOLDER_MIME) { try { f = { ...(await getFile(f.id)), name: f.name }; } catch (_) { skipped++; continue; } }
                }
                if (f.mimeType === FOLDER_MIME) {
                    const childRel = rel ? `${rel}/${f.name}` : f.name;
                    subfolders.push(childRel);
                    if (recursive && depth < MAX_DEPTH) await walk(f.id, childRel, depth + 1);
                    continue;
                }
                const mediaType = mediaTypeOf(f.mimeType);
                if (!mediaType) { skipped++; continue; }
                if (files.length >= MAX_FILES) { skipped++; continue; }
                files.push(describeFile(await addDims(f, budget), rel));
            }
        }
        await walk(folderId, '', 0);
        return { files, subfolders, skipped_non_media: skipped, backend: transport.name };
    }

    async function findChildFolder(parentId, name) {
        const want = String(name || '').toLowerCase().trim();
        const folders = (await listChildren(parentId)).filter(f => f.mimeType === FOLDER_MIME ||
            (f.mimeType === SHORTCUT_MIME && f.shortcutDetails?.targetMimeType === FOLDER_MIME));
        const norm = f => ({ id: f.mimeType === SHORTCUT_MIME ? f.shortcutDetails.targetId : f.id, name: f.name });
        const exact = folders.filter(f => f.name.toLowerCase() === want);
        if (exact.length === 1) return { folder: norm(exact[0]) };
        const partial = folders.filter(f => f.name.toLowerCase().includes(want) || want.includes(f.name.toLowerCase()));
        if (partial.length === 1) return { folder: norm(partial[0]) };
        return { folder: null, candidates: (partial.length ? partial : folders).map(f => f.name) };
    }

    // known: a describeFile() result from listMedia, to skip the metadata call.
    async function download(id, { maxBytes, known } = {}) {
        const meta = known ? { id: known.id, name: known.name, mimeType: known.mime_type, size: known.size } : await transport.getFile(id);
        const mediaType = mediaTypeOf(meta.mimeType);
        if (!mediaType) throw new Error(`'${meta.name}' is ${meta.mimeType}, not an image or video`);
        if (maxBytes && Number(meta.size) > maxBytes) throw new Error(`'${meta.name}' is ${meta.size} bytes; limit is ${maxBytes}`);
        const buffer = await transport.fetchBytes(meta);
        if (maxBytes && buffer.length > maxBytes) throw new Error(`'${meta.name}' is ${buffer.length} bytes; limit is ${maxBytes}`);
        let file = describeFile(meta, '');
        if (mediaType === 'image' && file.width == null && describeImage) {
            try { const d = await describeImage(buffer); file = describeFile({ ...meta, imageMediaMetadata: { width: d.width, height: d.height } }, ''); } catch (_) { /* keep unknown dims */ }
        }
        return { buffer, name: meta.name, contentType: meta.mimeType, mediaType, file };
    }

    return { getFile, listChildren, listMedia, findChildFolder, download, backend: transport.name };
}

function describeFile(f, folder) {
    const mediaType = mediaTypeOf(f.mimeType);
    const md = mediaType === 'image' ? f.imageMediaMetadata : f.videoMediaMetadata;
    const width = md?.width ?? null, height = md?.height ?? null;
    const size = f.size != null ? Number(f.size) : null;
    return {
        id: f.id, name: f.name, folder: folder || '', type: mediaType, mime_type: f.mimeType,
        width, height, size,
        size_label: size == null ? null : size > 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.round(size / 1024)} KB`,
        ...(mediaType === 'video' && md?.durationMillis ? { duration_sec: Math.round(Number(md.durationMillis) / 100) / 10 } : {}),
        modified: f.modifiedTime || null,
        ...(f.dims_from_name ? { dims_source: 'filename' } : {}),
        concept: conceptKey(f.name),
        fit: placementFit({ width, height, mediaType, size }),
    };
}

// Group listed files by concept so each concept's sizes sit together.
function groupByConcept(files) {
    const groups = new Map();
    for (const f of files) {
        const key = (f.folder ? `${f.folder}/` : '') + (f.concept || f.name);
        if (!groups.has(key)) groups.set(key, { concept: key, aspects: [], files: [] });
        const g = groups.get(key);
        g.files.push(f);
        if (f.fit.aspect && !g.aspects.includes(f.fit.aspect)) g.aspects.push(f.fit.aspect);
    }
    return [...groups.values()].map(g => ({
        ...g,
        missing_meta: ['1:1', '4:5', '9:16'].filter(a => !g.aspects.includes(a) && !(a === '1:1' && g.aspects.includes('4:5')) && !(a === '4:5' && g.aspects.includes('1:1'))),
    }));
}

module.exports = {
    parseDriveLink, createDriveClient, placementFit, aspectLabel, googleFields, conceptKey,
    groupByConcept, describeFile, dimsFromName, GOOGLE_MAX_IMAGE_BYTES, FOLDER_MIME, DRIVE_MCP_URL,
};
