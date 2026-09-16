'use strict';
const sharp = require('sharp');
const { buildImageEnhancementCreative } = require('./meta-image-enhancements');
const PLACEMENTS = {
  instagram_feed: ['instagram', 'stream'], instagram_explore: ['instagram', 'explore'],
  instagram_stories: ['instagram', 'story'], instagram_reels: ['instagram', 'reels'],
  facebook_feed: ['facebook', 'feed'], facebook_stories: ['facebook', 'story'],
  facebook_reels: ['facebook', 'facebook_reels'], facebook_marketplace: ['facebook', 'marketplace'],
  facebook_right_column: ['facebook', 'right_hand_column'],
};
const MAX_BYTES = 20 * 1024 * 1024;
function validateVariants(variants) {
  if (!Array.isArray(variants) || !variants.length || variants.length > 6) throw new Error('Provide 1–6 placement variants.');
  const seen = new Set();
  return variants.map((v, i) => {
    for (const dim of [v.width, v.height]) if (!Number.isInteger(dim) || dim < 100 || dim > 4096) throw new Error('Dimensions must be integers between 100 and 4096.');
    if (!v.placements?.length) throw new Error('Every variant needs placements.');
    for (const placement of v.placements) {
      if (!PLACEMENTS[placement] || seen.has(placement)) throw new Error('Unknown or duplicate placement: ' + placement);
      seen.add(placement);
    }
    const fit = v.fit || 'contain';
    if (!['contain', 'cover'].includes(fit)) throw new Error('fit must be contain or cover.');
    const background = v.background || '#ffffff';
    if (!/^#[0-9a-f]{6}$/i.test(background)) throw new Error('background must be a six-digit hex color.');
    const padding = v.padding ?? 0;
    if (!Number.isInteger(padding) || padding < 0 || padding * 2 >= Math.min(v.width, v.height)) throw new Error('Padding must leave a positive image area.');
    return { ...v, label: `placement_resize_${i}`, fit, background, padding };
  });
}
async function resizePlacementImage(input, variant) {
  const meta = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
  if (!['jpeg', 'png', 'webp'].includes(meta.format) || (meta.pages || 1) > 1) throw new Error('Only non-animated JPEG, PNG and WebP sources are supported.');
  const { width, height, fit, background, padding } = variant;
  let pipeline = sharp(input, { limitInputPixels: 40_000_000 }).rotate().flatten({ background }).resize(width - 2 * padding, height - 2 * padding, { fit, background, position: 'centre' });
  if (padding) pipeline = pipeline.extend({ top: padding, bottom: padding, left: padding, right: padding, background });
  return pipeline.png().toBuffer();
}
async function fetchMetaImage(url, fetcher) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !/(^|\.)fbcdn\.net$/.test(u.hostname)) throw new Error('Image URL must be an HTTPS Meta CDN URL.');
  const response = await fetcher(u.href, { redirect: 'error' });
  if (!response.ok || !response.body || Number(response.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('Image download failed or exceeds 20 MB.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('Image download exceeds 20 MB.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function placementCreative(source, variants, hashes) {
  const creative = buildImageEnhancementCreative(source, { image_auto_crop: 'OPT_OUT' });
  const link = source.object_story_spec.link_data;
  const supported = new Set(['image_hash', 'link', 'message', 'name', 'description', 'caption', 'call_to_action', 'image_crops']);
  if (Object.keys(link).some(k => !supported.has(k)) || !link.image_hash || !link.link || !link.message || !link.name) throw new Error('Placement conversion requires image_hash, URL, primary text and headline, and no unsupported link fields.');
  const cta = link.call_to_action || { type: 'LEARN_MORE' };
  if (cta.value && Object.keys(cta.value).some(k => k !== 'link') || cta.value?.link && cta.value.link !== link.link) throw new Error('Specialized CTA destinations must be handled separately.');
  const identity = structuredClone(source.object_story_spec);
  delete identity.link_data;
  creative.object_story_spec = identity;
  delete creative.image_crops;
  const images = [{ hash: link.image_hash, adlabels: [{ name: 'placement_original' }] }];
  const rules = variants.map((v, i) => {
    images.push({ hash: hashes[i], adlabels: [{ name: v.label }] });
    const spec = { publisher_platforms: [] };
    for (const p of v.placements) {
      const [platform, position] = PLACEMENTS[p];
      if (!spec.publisher_platforms.includes(platform)) spec.publisher_platforms.push(platform);
      (spec[platform + '_positions'] ||= []).push(position);
    }
    return { priority: i + 1, image_label: { name: v.label }, customization_spec: spec };
  });
  rules.push({ priority: rules.length + 1, image_label: { name: 'placement_original' }, customization_spec: {} });
  // Identical images can be returned with the same hash; combine labels for Meta.
  const unique = [];
  for (const img of images) {
    const existing = unique.find(x => x.hash === img.hash);
    if (existing) existing.adlabels.push(...img.adlabels); else unique.push(img);
  }
  creative.asset_feed_spec = {
    optimization_type: 'PLACEMENT', ad_formats: ['SINGLE_IMAGE'], images: unique,
    bodies: [{ text: link.message }], titles: [{ text: link.name }],
    descriptions: [{ text: link.description || '' }],
    link_urls: [{ website_url: link.link, ...(link.caption ? { display_url: link.caption } : {}) }],
    call_to_action_types: [cta.type], asset_customization_rules: rules,
  };
  creative.name = `${source.name || source.id} - placement sizes`.slice(0, 255);
  return creative;
}
async function preparePlacementImages(args, deps) {
  const variants = validateVariants(args.variants);
  const source = await deps.get(args.creative_id, { fields: 'id,name,object_story_id,object_story_spec,asset_feed_spec,url_tags,degrees_of_freedom_spec,image_crops,authorization_category,applink_treatment,link_deep_link_url,product_set_id' });
  const plan = placementCreative(source, variants, variants.map(v => v.image_hash || `<new image: ${v.label}>`));
  const hash = source.object_story_spec.link_data.image_hash;
  const library = await deps.get(`${deps.accountId}/adimages`, { hashes: JSON.stringify([...new Set([hash, ...variants.map(v => v.image_hash).filter(Boolean)])]), fields: 'hash,url,width,height' });
  const original = library.data?.find(x => x.hash === hash);
  if (!original?.url) throw new Error('Source image not found in this account media library.');
  for (const v of variants) {
    if (!v.image_hash) continue;
    const image = library.data?.find(x => x.hash === v.image_hash);
    if (!image || image.width !== v.width || image.height !== v.height) throw new Error('Reused image must exist in this account and match requested dimensions.');
  }
  const result = { source_creative_id: source.id, source_image: { hash, width: original.width, height: original.height }, variants, live_ads_changed: false };
  if (!args.confirm) return { ...result, dry_run: true, creative: plan, note: 'contain preserves the full image with padding; cover crops. Confirm uploads resized images and creates an unattached creative. Preview before attaching.' };
  const input = variants.some(v => !v.image_hash) ? await fetchMetaImage(original.url, deps.fetch) : null;
  // Finish every local resize before the first remote write.
  const buffers = [];
  for (const variant of variants) buffers.push(variant.image_hash ? null : await resizePlacementImage(input, variant));
  result.uploaded_images = [];
  try {
    for (const [i, buffer] of buffers.entries()) {
      if (variants[i].image_hash) {
        const reused = library.data.find(x => x.hash === variants[i].image_hash);
        result.uploaded_images.push({ hash: reused.hash, url: reused.url ?? null, width: reused.width, height: reused.height, placements: variants[i].placements, reused: true });
        continue;
      }
      const upload = await deps.post(`${deps.accountId}/adimages`, { bytes: buffer.toString('base64'), name: `${source.id}-${variants[i].label}.png` });
      const image = Object.values(upload.images || {})[0];
      if (!image?.hash) throw new Error('Image upload returned no hash.');
      result.uploaded_images.push({ hash: image.hash, url: image.url ?? null, width: variants[i].width, height: variants[i].height, placements: variants[i].placements });
    }
    const created = await deps.post(`${deps.accountId}/adcreatives`, placementCreative(source, variants, result.uploaded_images.map(x => x.hash)));
    if (!created.id) throw new Error('Creative creation returned no ID.');
    result.creative_id = created.id;
    const readback = await deps.get(created.id, { fields: 'id,asset_feed_spec,degrees_of_freedom_spec' });
    result.creative = readback;
    const observed = readback.asset_feed_spec;
    result.verified = variants.every((v, i) => {
      const image = observed?.images?.find(x => x.hash === result.uploaded_images[i].hash);
      const rule = observed?.asset_customization_rules?.find(x => x.image_label?.name === v.label);
      return image?.adlabels?.some(x => x.name === v.label) && rule && v.placements.every(p => { const [platform, position] = PLACEMENTS[p]; return rule.customization_spec?.publisher_platforms?.includes(platform) && rule.customization_spec?.[platform + '_positions']?.includes(position); });
    }) && readback.degrees_of_freedom_spec?.creative_features_spec?.image_auto_crop?.enroll_status === 'OPT_OUT';
    result.note = 'Preview all requested placements before attaching. Platform overlays can still cover text; padding can reserve space.';
  } catch (error) {
    result.error = error.message;
    result.reconciliation_required = true;
    result.note = 'Partial or uncertain operation. Inspect returned image hashes and creative ID before retrying; do not repeat with a fresh key.';
  }
  return result;
}
module.exports = { PLACEMENTS, validateVariants, resizePlacementImage, fetchMetaImage, placementCreative, preparePlacementImages };
