'use strict';

// Meta freezes url_tags on a creative once it is attached to an ad: POSTing to
// the creative returns "Please specify name, status or associated adlabels for
// updating the creative" (code 100, subcode 1815573). Retagging an existing ad
// therefore means rebuilding its creative with the new tracking and repointing
// the ad at the copy — which is what Ads Manager does silently behind its
// "URL parameters" field.

// Creation-safe fields copied from the source creative. Everything Meta only
// returns on read (id, effective_object_story_id, thumbnail_url, ...) is left
// behind rather than replayed into the create call.
const CLONE_FIELDS = [
  'object_story_spec', 'asset_feed_spec', 'degrees_of_freedom_spec', 'image_crops',
  'authorization_category', 'applink_treatment', 'link_deep_link_url', 'contextual_multi_ads',
];

// Returned inside asset_feed_spec on read, rejected on create.
const READ_ONLY_ASSET_FEED_KEYS = ['additional_data'];

const CREATIVE_READ_FIELDS = 'id,name,object_story_id,object_story_spec,asset_feed_spec,url_tags,' +
  'degrees_of_freedom_spec,image_crops,authorization_category,applink_treatment,link_deep_link_url,' +
  'contextual_multi_ads,product_set_id';

function validateUrlTags(urlTags) {
  if (typeof urlTags !== 'string' || !urlTags.trim()) throw new Error('url_tags must be a non-empty query string.');
  const value = urlTags.trim();
  if (/^[?#&]/.test(value)) throw new Error('url_tags must not start with ?, # or &.');
  if (/[\s#]/.test(value)) throw new Error('url_tags must not contain whitespace or #.');
  const keys = [];
  for (const pair of value.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0 || eq === pair.length - 1) throw new Error(`url_tags must be key=value pairs joined by &; got '${pair}'.`);
    keys.push(pair.slice(0, eq));
  }
  const repeated = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
  if (repeated.length) throw new Error(`url_tags repeats parameter(s): ${repeated.join(', ')}.`);
  return value;
}

// Every place a creative can carry a click destination. Used to spot inline
// tracking that would collide with url_tags once Meta appends them.
function destinationUrls(creative) {
  const urls = [];
  const push = (url, path) => { if (typeof url === 'string' && url) urls.push({ url, path }); };
  for (const [kind, data] of Object.entries(creative.object_story_spec || {})) {
    if (!data || typeof data !== 'object') continue;
    push(data.link, `object_story_spec.${kind}.link`);
    push(data.call_to_action?.value?.link, `object_story_spec.${kind}.call_to_action.value.link`);
    (data.child_attachments || []).forEach((child, i) => push(child?.link, `object_story_spec.${kind}.child_attachments[${i}].link`));
  }
  (creative.asset_feed_spec?.link_urls || []).forEach((entry, i) => {
    push(entry?.website_url, `asset_feed_spec.link_urls[${i}].website_url`);
    push(entry?.deeplink_url, `asset_feed_spec.link_urls[${i}].deeplink_url`);
  });
  return urls;
}

// Meta appends url_tags to the destination rather than merging, so a parameter
// baked into the URL and repeated in url_tags ships twice in one click URL.
function paramConflicts(creative, urlTags) {
  const incoming = new Set(urlTags.split('&').map(pair => pair.slice(0, pair.indexOf('='))));
  const conflicts = [];
  for (const { url, path } of destinationUrls(creative)) {
    const mark = url.indexOf('?');
    if (mark === -1) continue;
    const existing = url.slice(mark + 1).split('&')
      .map(pair => pair.split('=')[0])
      .filter(Boolean)
      .map(key => { try { return decodeURIComponent(key); } catch (_) { return key; } });
    const duplicate_params = [...new Set(existing.filter(key => incoming.has(key)))];
    if (duplicate_params.length) conflicts.push({ path, url, duplicate_params });
  }
  return conflicts;
}

// Ad labels and asset-customization labels read back with both a name and an
// ID. Creation matches them by name; replaying the IDs is unnecessary and ties
// the copy to objects the new creative does not own yet.
function stripLabelIds(value) {
  if (Array.isArray(value)) { value.forEach(stripLabelIds); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'adlabels' && Array.isArray(child)) {
      value[key] = child.map(label => (label && typeof label === 'object' && label.name) ? { name: label.name } : label);
      continue;
    }
    if (key.endsWith('_label') && child && typeof child === 'object' && !Array.isArray(child) && child.name) {
      value[key] = { name: child.name };
      continue;
    }
    stripLabelIds(child);
  }
}

function retagName(source) {
  const base = String(source.name || source.id || 'creative').replace(/ - url tags$/, '');
  return `${base} - url tags`.slice(0, 255);
}

function buildRetaggedCreative(source, urlTags) {
  const tags = validateUrlTags(urlTags);
  if (source.object_story_id) {
    throw new Error('Unsupported creative: this ad promotes an existing Page post. Rebuilding it would create a new post and drop the original\'s likes, comments and shares. Change the post\'s URL or rebuild the ad deliberately instead.');
  }
  if (source.product_set_id) {
    throw new Error('Unsupported creative: catalog and dynamic-product creatives carry catalog state that this rebuild does not reproduce. Retag them in their catalog workflow.');
  }
  if (!source.object_story_spec && !source.asset_feed_spec) {
    throw new Error('Unsupported creative: no object_story_spec or asset_feed_spec to rebuild from.');
  }

  const creative = {};
  for (const field of CLONE_FIELDS) if (source[field] != null) creative[field] = structuredClone(source[field]);
  if (creative.asset_feed_spec) for (const key of READ_ONLY_ASSET_FEED_KEYS) delete creative.asset_feed_spec[key];

  const features = creative.degrees_of_freedom_spec?.creative_features_spec;
  if (features) {
    // Meta returns this legacy bundle on older creatives but rejects it on
    // creation; the individual feature settings alongside it are the migration.
    if (features.standard_enhancements && Object.keys(features).length === 1) {
      throw new Error('Legacy enhancement bundle has no individual feature settings; explicit migration is required.');
    }
    delete features.standard_enhancements;
  }

  stripLabelIds(creative);
  creative.url_tags = tags;
  creative.name = retagName(source);
  return creative;
}

function verifyRetag(readback, expectedTags, expectedCreativeId) {
  const observed = readback?.url_tags ?? null;
  return {
    verified: observed === expectedTags && String(readback?.id ?? '') === String(expectedCreativeId),
    expected: expectedTags,
    observed,
    note: 'Tracking is verified on the creative, not in a click. Preview the ad and confirm the landing URL before relying on the new tagging.',
  };
}

module.exports = {
  buildRetaggedCreative, validateUrlTags, destinationUrls, paramConflicts, verifyRetag,
  CREATIVE_READ_FIELDS,
};
