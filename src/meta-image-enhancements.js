'use strict';
const FEATURES = new Set(['image_uncrop', 'image_auto_crop', 'image_touchups', 'image_brightness_and_contrast']);
function buildImageEnhancementCreative(source, enhancements) {
  if (!enhancements || !Object.keys(enhancements).length) throw new Error('Select at least one enhancement.');
  for (const [key, value] of Object.entries(enhancements)) {
    if (!FEATURES.has(key) || !['OPT_IN', 'OPT_OUT'].includes(value)) throw new Error('Unsupported image enhancement or enrollment status.');
  }
  const link = source.object_story_spec?.link_data;
  if (source.object_story_id || source.asset_feed_spec || source.product_set_id || !link || link.child_attachments || (!link.image_hash && !link.picture)) {
    throw new Error('Unsupported creative: only unpublished single-image link creatives are supported; existing-post, placement-asset, catalog, carousel and video creatives must retain their specialized workflow.');
  }
  const creative = {};
  for (const field of ['object_story_spec', 'url_tags', 'degrees_of_freedom_spec', 'image_crops', 'authorization_category', 'applink_treatment', 'link_deep_link_url']) {
    if (source[field] != null) creative[field] = structuredClone(source[field]);
  }
  creative.name = `${source.name || source.id} - image enhancements`.slice(0, 255);
  creative.degrees_of_freedom_spec ||= {};
  const features = creative.degrees_of_freedom_spec.creative_features_spec ||= {};
  // Meta returns this legacy bundle on older creatives but rejects it on creation.
  // Retain the individual feature settings exposed alongside it.
  if (features.standard_enhancements && Object.keys(features).length === 1) throw new Error('Legacy enhancement bundle has no individual feature settings; explicit migration is required.');
  delete features.standard_enhancements;
  for (const [key, enroll_status] of Object.entries(enhancements)) features[key] = { ...features[key], enroll_status };
  return creative;
}
function verifyImageEnhancements(creative, requested) {
  const features = creative.degrees_of_freedom_spec?.creative_features_spec || {};
  const settings = Object.fromEntries(Object.entries(requested).map(([key, value]) => [key, { requested: value, observed: features[key]?.enroll_status ?? null }]));
  return { verified: Object.values(settings).every(x => x.requested === x.observed), settings, note: 'Enrollment verification is not visual verification. Preview each placement before attaching.' };
}
module.exports = { buildImageEnhancementCreative, verifyImageEnhancements };
