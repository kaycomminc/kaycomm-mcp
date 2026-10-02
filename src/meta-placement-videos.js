'use strict';
// Placement-customized video creatives: one video per group of placements,
// selected by Meta through asset_customization_rules. Text is copied
// byte-for-byte from the source; over-length copy only produces warnings.
const { PLACEMENTS: ALL_PLACEMENTS } = require('./meta-placement-images');
const { copyLengthWarnings } = require('./meta-campaign-build');

const VIDEO_PLACEMENT_KEYS = ['facebook_feed', 'instagram_feed', 'instagram_explore', 'facebook_marketplace',
  'facebook_stories', 'instagram_stories', 'facebook_reels', 'instagram_reels'];
const PLACEMENTS = Object.fromEntries(VIDEO_PLACEMENT_KEYS.map(k => [k, ALL_PLACEMENTS[k]]));
const VERTICAL = new Set(['facebook_stories', 'instagram_stories', 'facebook_reels', 'instagram_reels']);
const DEFAULT_LABEL = 'placement_video_default';
const VIDEO_FIELDS = 'id,title,status,length,format{filter,width,height},thumbnails{uri,width,height,is_preferred}';
const COMMON_RATIOS = [['9:16', 9 / 16], ['4:5', 4 / 5], ['1:1', 1], ['2:3', 2 / 3], ['16:9', 16 / 9], ['1.91:1', 1.91]];

function aspectRatio(width, height) {
  if (!width || !height) return null;
  const ratio = width / height;
  const named = COMMON_RATIOS.find(([, r]) => Math.abs(ratio - r) / r < 0.01);
  if (named) return named[0];
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  const g = gcd(width, height);
  return `${width / g}:${height / g}`;
}

// Graph exposes video dimensions only through the encoding list; "native" is
// the uploaded size. Fall back to the largest encoding, then the thumbnail.
function videoDimensions(video) {
  const formats = Array.isArray(video?.format) ? video.format : [];
  const native = formats.find(f => f.filter === 'native') || [...formats].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  const thumb = video?.thumbnails?.data?.find(t => t.is_preferred) || video?.thumbnails?.data?.[0];
  const width = native?.width || thumb?.width || null;
  const height = native?.height || thumb?.height || null;
  return { width, height, aspect_ratio: aspectRatio(width, height) };
}

function customizationSpec(placements) {
  const spec = { publisher_platforms: [] };
  for (const p of placements) {
    const [platform, position] = PLACEMENTS[p];
    if (!spec.publisher_platforms.includes(platform)) spec.publisher_platforms.push(platform);
    (spec[platform + '_positions'] ||= []).push(position);
  }
  return spec;
}

// Returns labelled variants plus every problem found, so a dry run can report
// all of them at once instead of stopping at the first.
function validateVideoVariants(variants) {
  const errors = [];
  if (!Array.isArray(variants) || !variants.length || variants.length > 8) return { variants: [], errors: ['Provide 1–8 placement video variants.'] };
  const owner = new Map();
  const labelled = variants.map((v, i) => {
    if (!/^[0-9]+$/.test(String(v?.video_id || ''))) errors.push(`variants[${i}]: video_id must be a numeric Meta video ID.`);
    if (!Array.isArray(v?.placements) || !v.placements.length) errors.push(`variants[${i}]: placements must list at least one placement.`);
    for (const p of v?.placements || []) {
      if (!PLACEMENTS[p]) { errors.push(`variants[${i}]: unknown placement '${p}'. Use one of: ${VIDEO_PLACEMENT_KEYS.join(', ')}.`); continue; }
      if (owner.has(p)) errors.push(`Placement '${p}' is assigned twice (variants[${owner.get(p)}] and variants[${i}]). Each placement can use only one video.`);
      else owner.set(p, i);
    }
    return { ...v, label: `placement_video_${i}` };
  });
  return { variants: labelled, errors, uncovered: VIDEO_PLACEMENT_KEYS.filter(p => !owner.has(p)) };
}

// Only plain unpublished single-video creatives can be converted faithfully.
function sourceVideoCopy(source) {
  if (source.object_story_id || source.asset_feed_spec || source.product_set_id) {
    throw new Error('Unsupported creative: existing-post, asset-feed (dynamic/placement) and catalog creatives must keep their own workflow. Use a plain single-video creative as the source.');
  }
  const video = source.object_story_spec?.video_data;
  if (!video?.video_id) throw new Error('Source creative is not a single-video creative (object_story_spec.video_data.video_id missing). Use prepare_meta_placement_images for image creatives.');
  const supported = new Set(['video_id', 'title', 'message', 'link_description', 'image_url', 'image_hash', 'call_to_action']);
  const unsupported = Object.keys(video).filter(k => !supported.has(k));
  if (unsupported.length) throw new Error(`Source video_data has fields this conversion can't carry over (${unsupported.join(', ')}); convert it manually.`);
  const cta = video.call_to_action;
  const link = cta?.value?.link;
  if (!cta?.type || !link) throw new Error('Source video creative needs a CTA with a destination link.');
  const extra = Object.keys(cta.value).filter(k => k !== 'link');
  if (extra.length) throw new Error(`Specialized CTA destinations (${extra.join(', ')}) must be handled separately.`);
  return {
    video_id: String(video.video_id), image_hash: video.image_hash || null,
    // Copied verbatim — no trim, no normalization.
    body: video.message, title: video.title, description: video.link_description, link, cta: cta.type,
  };
}

// Shared by prepare_meta_placement_videos and create_meta_campaign.
// defaultVideo: { video_id, thumbnail_hash?, thumbnail_url? } for uncovered placements.
// variants: labelled entries with { video_id, placements, label, thumbnail_hash?, thumbnail_url? }.
// copy: { body, title, description, link, cta } — any string may be '' or undefined.
function buildPlacementVideoFeedSpec({ defaultVideo, variants, copy }) {
  const videos = [];
  const add = (entry, label) => {
    const existing = videos.find(v => v.video_id === String(entry.video_id));
    if (existing) {
      existing.adlabels.push({ name: label });
      // First explicit thumbnail wins; a later one only fills a gap.
      if (!existing.thumbnail_hash && !existing.thumbnail_url) {
        if (entry.thumbnail_hash) existing.thumbnail_hash = entry.thumbnail_hash;
        else if (entry.thumbnail_url) existing.thumbnail_url = entry.thumbnail_url;
      }
      return;
    }
    const video = { video_id: String(entry.video_id), adlabels: [{ name: label }] };
    if (entry.thumbnail_hash) video.thumbnail_hash = entry.thumbnail_hash;
    else if (entry.thumbnail_url) video.thumbnail_url = entry.thumbnail_url;
    videos.push(video);
  };
  for (const v of variants) add(v, v.label);
  add(defaultVideo, DEFAULT_LABEL);
  const rules = variants.map((v, i) => ({ priority: i + 1, video_label: { name: v.label }, customization_spec: customizationSpec(v.placements) }));
  // Empty spec = every placement no earlier rule claimed.
  rules.push({ priority: rules.length + 1, video_label: { name: DEFAULT_LABEL }, customization_spec: {} });
  const spec = { optimization_type: 'PLACEMENT', ad_formats: ['SINGLE_VIDEO'], videos };
  if (copy.body != null) spec.bodies = [{ text: copy.body }];
  if (copy.title != null) spec.titles = [{ text: copy.title }];
  if (copy.description != null) spec.descriptions = [{ text: copy.description }];
  spec.link_urls = [{ website_url: copy.link }];
  spec.call_to_action_types = [copy.cta || 'LEARN_MORE'];
  spec.asset_customization_rules = rules;
  return spec;
}

function placementVideoCreative(source, variants, thumbs) {
  const copy = sourceVideoCopy(source);
  const identity = structuredClone(source.object_story_spec);
  delete identity.video_data;
  // Graph returns the Instagram identity top-level; Meta needs it in the spec.
  if (source.instagram_user_id && !identity.instagram_user_id) identity.instagram_user_id = source.instagram_user_id;
  const creative = { name: `${source.name || source.id} - placement videos`.slice(0, 255), object_story_spec: identity };
  if (source.url_tags != null) creative.url_tags = source.url_tags;
  const features = source.degrees_of_freedom_spec?.creative_features_spec;
  if (features) {
    const kept = structuredClone(features);
    // Legacy bundle comes back on readback but is rejected on creation. The
    // advantage_plus_creative opt-out is kept so enhancements stay off.
    delete kept.standard_enhancements;
    if (Object.keys(kept).length) creative.degrees_of_freedom_spec = { creative_features_spec: kept };
  }
  creative.asset_feed_spec = buildPlacementVideoFeedSpec({
    defaultVideo: { video_id: copy.video_id, ...thumbs.default },
    variants: variants.map((v, i) => ({ ...v, ...thumbs.variants[i] })),
    copy,
  });
  creative.contextual_multi_ads = { enroll_status: 'OPT_OUT' };
  return creative;
}

// Looks a video up in the ad account library first, then directly by ID
// (videos in the Business Manager library or another ad account of the same
// business are readable by ID but don't appear under act_X/advideos).
async function inspectVideos(ids, { accountId, get, getAll }, { sourceVideoId } = {}) {
  const warnings = []; const errors = [];
  let accountIds = null;
  try { accountIds = new Set((await getAll(`${accountId}/advideos`, { fields: 'id', limit: 500 })).map(v => String(v.id))); }
  catch (e) { warnings.push(`Couldn't list this ad account's video library (${e.message}); videos were checked by direct lookup only.`); }
  const videos = {};
  for (const id of [...new Set(ids.map(String))]) {
    const inAccount = accountIds?.has(id) ?? null;
    let video;
    try { video = await get(id, { fields: VIDEO_FIELDS }); }
    catch (e) {
      videos[id] = { video_id: id, found: false, library: null };
      errors.push(inAccount
        ? `Video ${id} is listed in this ad account's library but couldn't be read (${e.message}).`
        : `Video ${id} was not found in this ad account's library, and a direct lookup also failed (${e.message}). It may be a typo, belong to a Business Manager library this token's business can't access, or have been deleted. Check the ID in Ads Manager > Media Library, or re-upload with upload_meta_media.`);
      continue;
    }
    const status = video.status?.video_status || null;
    const preferred = video.thumbnails?.data?.find(t => t.is_preferred) || video.thumbnails?.data?.[0];
    videos[id] = { video_id: id, found: true, library: inAccount === false ? 'business_or_shared' : inAccount ? 'ad_account' : 'unknown',
      title: video.title ?? null, status, length: video.length ?? null, ...videoDimensions(video), auto_thumbnail_url: preferred?.uri || null };
    if (inAccount === false) {
      warnings.push(`Video ${id} isn't in this ad account's video library (list_meta_media won't show it), but it is readable by ID — it was most likely uploaded to the Business Manager media library or another ad account in the same business. ` +
        (id === sourceVideoId ? 'The source creative already uses it, so Meta has accepted it in this account before.' : 'Meta usually accepts shared business videos; if creative creation fails with a permissions error, re-upload it to this ad account.'));
    }
    if (status !== 'ready') {
      const phases = ['uploading_phase', 'processing_phase', 'publishing_phase'].map(p => video.status?.[p]?.status && `${p.replace('_phase', '')}: ${video.status[p].status}`).filter(Boolean).join(', ');
      errors.push(status === 'processing' || status === 'upload_complete' || !status
        ? `Video ${id} is still processing (status: ${status || 'unknown'}${phases ? `; ${phases}` : ''}). Wait until it is ready, then run the dry run again.`
        : `Video ${id} is not usable (status: ${status}${phases ? `; ${phases}` : ''}).`);
    }
  }
  // Plain objects order numeric keys numerically; keep request order for display.
  return { videos, list: [...new Set(ids.map(String))].map(id => videos[id]), warnings, errors };
}

function aspectWarnings(variants, videos) {
  const warnings = [];
  for (const v of variants) {
    const info = videos[String(v.video_id)];
    if (!info?.width || !info?.height) continue;
    const r = info.width / info.height;
    const vertical = v.placements.filter(p => VERTICAL.has(p));
    const feed = v.placements.filter(p => !VERTICAL.has(p));
    if (vertical.length && Math.abs(r - 9 / 16) > 0.02) warnings.push(`Video ${v.video_id} is ${info.aspect_ratio} (${info.width}x${info.height}) but is assigned to ${vertical.join(', ')}, which are 9:16 placements.`);
    if (feed.length && (r < 0.79 || r > 1.01)) warnings.push(`Video ${v.video_id} is ${info.aspect_ratio} (${info.width}x${info.height}) but is assigned to ${feed.join(', ')}; feed-style placements display 4:5 or 1:1 and will crop or letterbox it.`);
  }
  return warnings;
}

async function preparePlacementVideos(args, deps) {
  const { variants, errors: variantErrors, uncovered } = validateVideoVariants(args.variants);
  const source = await deps.get(args.creative_id, { fields: 'id,name,object_story_id,object_story_spec,instagram_user_id,asset_feed_spec,url_tags,degrees_of_freedom_spec,product_set_id' });
  const copy = sourceVideoCopy(source);
  const warnings = copyLengthWarnings({ primary_text: copy.body, headline: copy.title, description: copy.description }, 'Source creative');
  if (source.degrees_of_freedom_spec?.creative_features_spec?.standard_enhancements) warnings.push('Source has the legacy standard_enhancements bundle, which Meta returns on readback but rejects on creation; it is not copied. Individual feature settings are kept.');
  const inspected = await inspectVideos([copy.video_id, ...variants.map(v => v.video_id)], deps, { sourceVideoId: copy.video_id });
  warnings.push(...inspected.warnings, ...aspectWarnings(variants, inspected.videos));
  const errors = [...variantErrors, ...inspected.errors];

  // Explicit thumbnails must already be in this account.
  const hashes = [...new Set([copy.image_hash, ...variants.map(v => v.image_hash)].filter(Boolean))];
  if (hashes.length) {
    const library = await deps.get(`${deps.accountId}/adimages`, { hashes: JSON.stringify(hashes), fields: 'hash,url,width,height' });
    for (const v of variants) if (v.image_hash && !library.data?.some(x => x.hash === v.image_hash)) errors.push(`Thumbnail image_hash ${v.image_hash} (variant for video ${v.video_id}) is not in this ad account's image library.`);
    if (copy.image_hash && !library.data?.some(x => x.hash === copy.image_hash)) {
      warnings.push(`The source creative's thumbnail ${copy.image_hash} isn't in this account's image library; the fallback video will use its auto-generated thumbnail instead.`);
      copy.image_hash = null;
    }
  }

  // Thumbnail plan: explicit image_hash > source thumbnail (source video only) > auto-generated.
  const thumbFor = (videoId, explicit) => explicit ? { thumbnail_hash: explicit, source: 'provided' }
    : videoId === copy.video_id && copy.image_hash ? { thumbnail_hash: copy.image_hash, source: 'source_creative' }
    : { auto: true, source: 'auto_generated', url: inspected.videos[videoId]?.auto_thumbnail_url || null };
  const plan = { default: thumbFor(copy.video_id), variants: variants.map(v => thumbFor(String(v.video_id), v.image_hash)) };
  const thumbnails = [{ for: 'default', video_id: copy.video_id, ...plan.default }, ...variants.map((v, i) => ({ for: v.label, video_id: String(v.video_id), ...plan.variants[i] }))]
    .map(({ auto, url, ...t }) => ({ ...t, ...(auto ? { will_upload_from: url } : {}) }));

  const placementMap = Object.fromEntries(VIDEO_PLACEMENT_KEYS.map(p => [p, variants.find(v => v.placements?.includes(p))?.video_id ?? `${copy.video_id} (default)`]));
  const result = {
    source_creative_id: source.id, source_video_id: copy.video_id,
    variants: variants.map(v => ({ video_id: String(v.video_id), placements: v.placements, label: v.label, ...(v.image_hash ? { image_hash: v.image_hash } : {}) })),
    placement_map: placementMap, uncovered_placements_use_default: uncovered,
    videos: inspected.list, thumbnails, live_ads_changed: false,
  };
  if (errors.length) return { ...result, ...(warnings.length ? { warnings } : {}), error: `Validation failed — nothing was ${args.confirm ? 'created' : 'planned'}. Fix validation_errors and retry.`, validation_errors: errors };

  if (!args.confirm) {
    const preview = (t, videoId) => ({ thumbnail_hash: t.thumbnail_hash || `<auto thumbnail of ${videoId}>` });
    const creative = placementVideoCreative(source, variants, { default: preview(plan.default, copy.video_id), variants: plan.variants.map((t, i) => preview(t, variants[i].video_id)) });
    return { ...result, dry_run: true, creative, ...(warnings.length ? { warnings } : {}),
      note: 'Dry run — nothing uploaded or created. confirm=true uploads any auto-generated thumbnails, then creates an unattached creative. Preview it with preview_meta_ad, then attach with update_meta_object (updates: {creative: {creative_id}}).' };
  }

  result.uploaded_thumbnails = [];
  if (warnings.length) result.warnings = warnings;
  try {
    const resolved = new Map();
    const resolve = async (videoId, t) => {
      if (!t.auto) return { thumbnail_hash: t.thumbnail_hash };
      if (!resolved.has(videoId)) {
        const hash = await deps.uploadThumbnail(videoId);
        if (!hash) throw new Error(`Couldn't create a thumbnail for video ${videoId}; pass image_hash for that variant.`);
        resolved.set(videoId, hash);
        result.uploaded_thumbnails.push({ video_id: videoId, hash });
      }
      return { thumbnail_hash: resolved.get(videoId) };
    };
    const thumbs = { default: await resolve(copy.video_id, plan.default), variants: [] };
    for (const [i, v] of variants.entries()) thumbs.variants.push(await resolve(String(v.video_id), plan.variants[i]));
    const body = placementVideoCreative(source, variants, thumbs);
    const created = await deps.post(`${deps.accountId}/adcreatives`, body);
    if (!created.id) throw new Error('Creative creation returned no ID.');
    result.creative_id = created.id;
    const readback = await deps.get(created.id, { fields: 'id,status,asset_feed_spec,url_tags,contextual_multi_ads' });
    result.creative = readback;
    const observed = readback.asset_feed_spec;
    // Meta stores a per-creative copy of each video under a new ID, so match by label.
    const byLabel = name => observed?.videos?.find(x => x.adlabels?.some(l => l.name === name));
    result.video_id_map = [...variants, { video_id: copy.video_id, label: DEFAULT_LABEL }].map(v => ({ label: v.label, requested: String(v.video_id), stored: byLabel(v.label)?.video_id ?? null }));
    result.verified = variants.every(v => {
      const rule = observed?.asset_customization_rules?.find(x => x.video_label?.name === v.label);
      return byLabel(v.label) && rule && v.placements.every(p => { const [platform, position] = PLACEMENTS[p]; return rule.customization_spec?.publisher_platforms?.includes(platform) && rule.customization_spec?.[platform + '_positions']?.includes(position); });
    }) && !!byLabel(DEFAULT_LABEL) && observed?.bodies?.[0]?.text === copy.body && observed?.titles?.[0]?.text === copy.title
      && (readback.url_tags ?? null) === (source.url_tags ?? null);
    result.creative_status = readback.status ?? null;
    if (!result.verified) (result.warnings ||= []).push(`Creative ${created.id} was created, but its readback doesn't match the request (labels, placement rules, copy or url_tags). Inspect it before attaching.`);
    if (readback.status && readback.status !== 'ACTIVE') (result.warnings ||= []).push(`Meta is still processing creative ${created.id} (status: ${readback.status}). Wait until it is ACTIVE before attaching.`);
    result.note = 'Unattached creative created. Preview every placement with preview_meta_ad, then attach with update_meta_object (level=ad, updates: {creative: {creative_id}}).';
  } catch (error) {
    result.error = error.message;
    result.reconciliation_required = true;
    result.note = 'Partial or uncertain operation. Inspect uploaded_thumbnails and any creative_id before retrying; reuse the same idempotency_key only after reconciling.';
  }
  return result;
}

module.exports = { PLACEMENTS, VIDEO_PLACEMENT_KEYS, DEFAULT_LABEL, aspectRatio, videoDimensions, customizationSpec,
  validateVideoVariants, sourceVideoCopy, buildPlacementVideoFeedSpec, placementVideoCreative, inspectVideos, aspectWarnings, preparePlacementVideos };
