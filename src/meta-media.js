'use strict';
const sharp = require('sharp');

// Media intake for upload_meta_media / upload_meta_media_chunk: cloud share
// links, chunked base64 staging, download validation and image dimensions.

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;   // Meta adimages limit
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const CHUNK_TTL_MS = 30 * 60 * 1000;

// Google Drive / Dropbox share links → direct-download URLs. Returns null for
// any other URL so callers keep their existing behavior.
function resolveShareLink(raw) {
    let u;
    try { u = new URL(raw); } catch (_) { return null; }
    const host = u.hostname.toLowerCase();
    if (host === 'drive.google.com' || host === 'docs.google.com') {
        const id = u.pathname.match(/\/file\/d\/([A-Za-z0-9_-]+)/)?.[1] || u.searchParams.get('id');
        if (!id) return null;
        // drive.usercontent + confirm=t skips the "can't scan for viruses" interstitial on large files.
        return { provider: 'google_drive', file_id: id, url: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t` };
    }
    if (host === 'dropbox.com' || host.endsWith('.dropbox.com')) {
        if (host === 'dl.dropboxusercontent.com') return { provider: 'dropbox', url: u.toString() };
        u.searchParams.delete('raw');
        u.searchParams.set('dl', '1');   // keeps rlkey on /scl/fi/ links
        return { provider: 'dropbox', url: u.toString() };
    }
    return null;
}

function filenameFromDisposition(header) {
    if (!header) return null;
    const star = header.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
    if (star) { try { return decodeURIComponent(star[1].trim()); } catch (_) { /* fall through */ } }
    return header.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1]?.trim() || null;
}

// Download and validate that the body is really media (share links return an
// HTML page when the file isn't public or Drive shows an interstitial).
async function downloadMedia(url, { fetch, maxBytes = MAX_DOWNLOAD_BYTES }) {
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`Download failed (HTTP ${resp.status})`);
    const contentType = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const mediaType = contentType.startsWith('image/') ? 'image' : contentType.startsWith('video/') ? 'video' : null;
    if (!mediaType) {
        const hint = contentType === 'text/html'
            ? ' — got a web page, not a file. Make sure the link is shared as "Anyone with the link" and points to a single file, not a folder.'
            : '';
        throw new Error(`Downloaded content-type '${contentType || 'unknown'}' is not an image or video${hint}`);
    }
    const declared = Number(resp.headers.get('content-length'));
    if (declared && declared > maxBytes) throw new Error(`File is ${declared} bytes; limit is ${maxBytes}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`File is ${buffer.length} bytes; limit is ${maxBytes}`);
    return { buffer, contentType, mediaType, filename: filenameFromDisposition(resp.headers.get('content-disposition')) };
}

async function describeImage(buffer) {
    const m = await sharp(buffer, { limitInputPixels: 100_000_000 }).metadata();
    return { width: m.width, height: m.height, format: m.format };
}

function extensionFor(contentType) {
    const sub = (contentType || '').split('/')[1] || 'bin';
    return { jpeg: 'jpg', 'svg+xml': 'svg', quicktime: 'mov' }[sub] || sub;
}

// ── Chunked base64 uploads ───────────────────────────────────────────────────
// Chunks are base64 *text* slices, concatenated before decoding, so callers
// may split anywhere. Held in memory; incomplete uploads expire 30 min after
// the first chunk.

function createChunkStore({ ttlMs = CHUNK_TTL_MS, maxBytes = MAX_IMAGE_BYTES, now = Date.now } = {}) {
    const uploads = new Map();

    function sweep() {
        const t = now();
        for (const [id, u] of uploads) if (t - u.created > ttlMs) uploads.delete(id);
    }
    function status(u) {
        const missing = [];
        for (let i = 0; i < u.total; i++) if (!u.chunks.has(i)) missing.push(i);
        return { upload_id: u.id, name: u.name, total_chunks: u.total, received: u.chunks.size, missing,
            complete: !missing.length, expires_at: new Date(u.created + ttlMs).toISOString() };
    }

    return {
        put({ upload_id, account_id, chunk_index, total_chunks, data, name }) {
            sweep();
            if (!/^[A-Za-z0-9_-]{1,64}$/.test(upload_id)) throw new Error('upload_id must be 1-64 letters, digits, _ or -');
            if (!Number.isInteger(total_chunks) || total_chunks < 1 || total_chunks > 1000) throw new Error('total_chunks must be an integer 1-1000');
            if (!Number.isInteger(chunk_index) || chunk_index < 0 || chunk_index >= total_chunks) throw new Error(`chunk_index must be 0-${total_chunks - 1}`);
            let text = String(data);
            if (chunk_index === 0) text = text.replace(/^data:[^;,]+;base64,/, '');
            text = text.replace(/\s+/g, '');
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('data must be base64 text');

            let u = uploads.get(upload_id);
            if (!u) {
                u = { id: upload_id, account_id, total: total_chunks, name: name || null, chunks: new Map(), bytes: 0, created: now() };
                uploads.set(upload_id, u);
            }
            if (u.account_id !== account_id) throw new Error(`upload_id '${upload_id}' belongs to a different account`);
            if (u.total !== total_chunks) throw new Error(`upload_id '${upload_id}' was started with total_chunks=${u.total}`);
            if (name && u.name && name !== u.name) throw new Error(`upload_id '${upload_id}' was started with name '${u.name}'`);
            if (name && !u.name) u.name = name;
            const prev = u.chunks.get(chunk_index);
            if (prev !== undefined && prev !== text) throw new Error(`chunk ${chunk_index} was already received with different data`);
            if (prev === undefined) {
                const bytes = u.bytes + Math.floor(text.length * 3 / 4);
                if (bytes > maxBytes) { uploads.delete(upload_id); throw new Error(`Upload exceeds ${maxBytes} bytes; discarded`); }
                u.chunks.set(chunk_index, text);
                u.bytes = bytes;
            }
            return status(u);
        },
        status(upload_id, account_id) {
            sweep();
            const u = uploads.get(upload_id);
            if (!u || u.account_id !== account_id) return null;
            return status(u);
        },
        assemble(upload_id, account_id) {
            sweep();
            const u = uploads.get(upload_id);
            if (!u || u.account_id !== account_id) throw new Error(`No staged upload '${upload_id}' for this account (uploads expire 30 min after the first chunk)`);
            const s = status(u);
            if (!s.complete) throw new Error(`Upload '${upload_id}' is missing chunks: ${s.missing.join(', ')}`);
            let text = '';
            for (let i = 0; i < u.total; i++) text += u.chunks.get(i);
            return { buffer: Buffer.from(text, 'base64'), name: u.name };
        },
        discard(upload_id) { uploads.delete(upload_id); },
        sweep,
        get size() { return uploads.size; },
    };
}

module.exports = { resolveShareLink, downloadMedia, describeImage, extensionFor, createChunkStore, filenameFromDisposition, MAX_IMAGE_BYTES, CHUNK_TTL_MS };
