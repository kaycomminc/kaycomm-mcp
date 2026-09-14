'use strict';

// Preflight checks for identifiers supplied to write-capable tools.
//
// This module deliberately has no dependency on server.js or on credentials.
// The provider functions are injected so a caller can use the same checks for
// a dry-run and for a confirmed operation, and tests can use deterministic
// mocks.  It returns a result object instead of throwing: existing handlers
// can merge `{ error, code }` into their normal tool result without leaking a
// provider response.

const META_TOOLS = new Set([
  'manage_meta', 'pause_campaign', 'enable_campaign', 'update_budget',
  'duplicate_meta_campaign', 'upload_meta_media', 'create_meta_campaign',
  'create_meta_subscription', 'update_meta_subscription',
  'delete_meta_subscription', 'create_meta_audience',
  'manage_meta_audience_users', 'manage_meta_ad_rules', 'update_meta_object',
  'manage_meta_leads',
]);

const GOOGLE_TOOLS = new Set([
  'pause_campaign', 'enable_campaign', 'pause_ad_group', 'enable_ad_group',
  'pause_keyword', 'enable_keyword', 'update_budget', 'create_ad_group',
  'populate_ad_group', 'set_bidding_strategy', 'create_campaign',
  'create_pmax_campaign', 'create_video_campaign', 'update_ad_copy',
  'update_ad_url', 'update_geo_targeting', 'add_ad_extension',
  'add_negative_keywords', 'manage_negative_lists',
]);

const META_ACTIONS = {
  // Actions in these tools are account-scoped by name and do not carry a raw
  // object identifier.  They are listed here to make the write boundary
  // explicit; no membership call is needed for them.
  manage_meta: new Set(['pause', 'resume', 'archive', 'set_daily_budget', 'duplicate']),
  manage_meta_ad_rules: new Set(['read', 'update', 'delete', 'preview', 'execute', 'history']),
  manage_meta_leads: new Set(['create_form']),
};

const WRITE_ACTIONS = {
  manage_meta_ad_rules: new Set(['create', 'update', 'delete', 'execute']),
  manage_meta_leads: new Set(['create_form']),
  manage_negative_lists: new Set(['create', 'add_keywords', 'attach']),
};

function resultError(code, message, extra = {}) {
  // Keep messages actionable but never include IDs, API payloads, or provider
  // error text.  The field name and account label are safe to expose.
  return { ok: false, error: message, code, ...extra };
}

function success(match, accountId, platform) {
  const [id, info] = match;
  return { ok: true, platform, account_id: accountId || id, account: info?.name, match };
}

function normalizeId(value) {
  return String(value || '').replace(/^act_/, '');
}

function isSameAccount(actual, expected) {
  if (actual === undefined || actual === null || actual === '') return false;
  return normalizeId(actual) === normalizeId(expected);
}

function accountMatch(store, search, deps, confirmed) {
  if (!store || typeof deps.resolveAccount !== 'function') {
    return { error: 'Ownership checks are not configured for this platform', code: 'TARGET_ACCOUNT_MISMATCH' };
  }
  let resolved;
  try {
    resolved = deps.resolveAccount(store, search, { confirmed: confirmed === true });
  } catch (_) {
    return resultError('TARGET_ACCOUNT_MISMATCH', 'The selected account could not be resolved');
  }
  if (!resolved?.match) {
    return resultError('TARGET_ACCOUNT_MISMATCH', resolved?.error || 'The selected account could not be resolved');
  }
  return resolved;
}

function firstData(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.data)) return value.data;
  if (value.data && typeof value.data === 'object') return value.data;
  return value;
}

function rowsFrom(value) {
  const data = firstData(value);
  return Array.isArray(data) ? data : [];
}

function safeLookupMessage(label) {
  return `Unable to verify ${label} belongs to the selected account. Recheck the identifier and account, then retry.`;
}

// `account_id` is an officially exposed field on these Graph object types.
// Pixels, ad-rule records, and subscriptions use account-scoped edges below;
// asking for an invented universal account_id field on those endpoints can
// turn a valid target into a false rejection.
const DIRECT_ACCOUNT_ID_EDGES = new Set(['campaigns', 'adsets', 'ads', 'customaudiences', 'adcreatives']);

async function verifyMetaId(accountId, id, edge, label, deps) {
  if (id === undefined || id === null || id === '') return null;
  const target = String(id);
  let directError = null;

  // Prefer the one-object lookup only for types where account_id is an
  // established field; pixels, rules, and subscriptions use their edges.
  if (DIRECT_ACCOUNT_ID_EDGES.has(edge) && typeof deps.metaGet === 'function') {
    try {
      const value = firstData(await deps.metaGet(target, { fields: 'id,account_id' }));
      if (value && value.account_id !== undefined) {
        if (value.id === undefined || String(value.id) !== target) {
          return resultError('TARGET_ACCOUNT_MISMATCH', `${label} lookup did not return the requested object.`);
        }
        if (!isSameAccount(value.account_id, accountId)) {
          return resultError('TARGET_ACCOUNT_MISMATCH', `${label} does not belong to the selected account.`);
        }
        return null;
      }
      // A direct lookup which returned an object without account_id is not
      // enough evidence; use the explicit account edge below.
    } catch (_) {
      directError = true;
    }
  }

  if (typeof deps.metaGetAll !== 'function' || !edge) {
    return resultError('TARGET_ACCOUNT_MISMATCH', safeLookupMessage(label));
  }

  try {
    const rows = rowsFrom(await deps.metaGetAll(`${accountId}/${edge}`, {
      fields: DIRECT_ACCOUNT_ID_EDGES.has(edge) ? 'id,account_id' : 'id', limit: 500,
    }));
    const found = rows.find(row => String(row?.id ?? row) === target);
    if (found) {
      if (found.id !== undefined && String(found.id) !== target) {
        return resultError('TARGET_ACCOUNT_MISMATCH', `${label} lookup did not return the requested object.`);
      }
      if (found.account_id !== undefined && !isSameAccount(found.account_id, accountId)) {
        return resultError('TARGET_ACCOUNT_MISMATCH', `${label} does not belong to the selected account.`);
      }
      return null;
    }
    return resultError('TARGET_ACCOUNT_MISMATCH', `${label} was not found in the selected account.`);
  } catch (_) {
    // Never pass provider errors (which may contain URLs or request data) to
    // the caller.  `directError` is intentionally unused beyond documenting
    // that both checks are fail-closed.
    void directError;
    return resultError('TARGET_ACCOUNT_MISMATCH', safeLookupMessage(label));
  }
}

function googleCid(accountId) {
  return String(accountId || '').replace(/^customers\//, '').replace(/\/$/, '');
}

function isGoogleResourceForCid(value, cid, kind) {
  if (typeof value !== 'string' || !value.trim()) return true;
  const v = value.trim();
  // Existing Google resource constants and URLs/IDs accepted by video inputs
  // are not account resources and must not be mistaken for cross-account IDs.
  // Geo-target and asset type constants are handled by other inputs; they are
  // not valid substitutes for these account-qualified resource fields.
  if (/^(https?:\/\/|youtu\.be\/|[A-Za-z0-9_-]{6,})$/.test(v) && kind === 'video') return true;
  const escaped = String(cid).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const kinds = {
    ad: 'ads', ad_group: 'adGroups', asset: 'assets', campaign: 'campaigns',
    campaign_criterion: 'campaignCriteria',
  };
  const resourceKind = kinds[kind] || '(?:ads|adGroups|assets|campaigns|campaignCriteria|campaignBudgets|assetGroups)';
  return new RegExp(`^customers/${escaped}/${resourceKind}/-?\\d+$`).test(v);
}

function invalidGoogleResource(field, kind) {
  return resultError('TARGET_ACCOUNT_MISMATCH', `${field} must be a resource belonging to the selected Google Ads account (${kind}).`);
}

function collect(value, field, out) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) value.forEach((v, i) => collect(v, `${field}[${i}]`, out));
  else out.push([field, value]);
}

function googleCheck(name, args, accountId) {
  const cid = googleCid(accountId);
  const checks = [];
  if (name === 'populate_ad_group' && args.ad_group_resource)
    checks.push(['ad_group_resource', args.ad_group_resource, 'ad_group']);
  if ((name === 'update_ad_copy' || name === 'update_ad_url') && args.ad_resource_name)
    checks.push(['ad_resource_name', args.ad_resource_name, 'ad']);
  if (name === 'update_geo_targeting') {
    for (const [field, value] of (args.remove || []).entries()) {
      if (typeof value === 'string' && value.startsWith('customers/')) checks.push([`remove[${field}]`, value, 'campaign_criterion']);
    }
  }
  if (name === 'create_pmax_campaign') {
    collect(args.business_name_asset, 'business_name_asset', checks);
    collect(args.logo_asset, 'logo_asset', checks);
    collect(args.marketing_images, 'marketing_images', checks);
    collect(args.square_marketing_images, 'square_marketing_images', checks);
    collect(args.logo_assets, 'logo_assets', checks);
    collect(args.youtube_videos, 'youtube_videos', checks);
    checks.forEach(item => { item[2] = 'asset'; });
  }
  // Video campaign accepts asset resource names as well as URLs/IDs. Only
  // account-shaped Google resources are checked; ordinary video IDs remain
  // valid and are resolved by the server's existing provider logic.
  if (name === 'create_video_campaign') {
    for (const [i, adSet] of (args.ad_groups || []).entries()) {
      collect(adSet.youtube_video, `ad_groups[${i}].youtube_video`, checks);
      for (const [j, video] of (adSet.youtube_videos || []).entries()) {
        if (typeof video === 'string') collect(video, `ad_groups[${i}].youtube_videos[${j}]`, checks);
        else if (video && typeof video === 'object') collect(video.url, `ad_groups[${i}].youtube_videos[${j}].url`, checks);
      }
    }
    checks.forEach(item => { item[2] = 'video'; });
  }
  for (const [field, value, kind] of checks) {
    // Video inputs intentionally also accept ordinary YouTube IDs/URLs. All
    // other resource-shaped inputs must be account-qualified; constants and
    // negative temporary resource IDs are accepted by the helper above.
    if (typeof value === 'string' && (kind !== 'video' || value.startsWith('customers/')) && !isGoogleResourceForCid(value, cid, kind))
      return invalidGoogleResource(field, kind);
  }
  return null;
}

function addMetaCheck(checks, id, edge, label) {
  if (id !== undefined && id !== null && id !== '') checks.push([id, edge, label]);
}

const UNSAFE_UPDATE_KEYS = new Set(['access_token', 'account_id', 'batch', 'method', 'relative_url']);

function invalidMetaUpdateShape(toolName, args) {
  if (toolName !== 'update_meta_object') return null;
  const updates = args.updates;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates))
    return resultError('INVALID_ARGUMENT', 'updates must be an object.');

  let unsafeKey = null;
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (UNSAFE_UPDATE_KEYS.has(key)) { unsafeKey = key; return; }
      walk(child);
      if (unsafeKey) return;
    }
  };
  walk(updates);
  if (unsafeKey) return resultError('INVALID_ARGUMENT', `updates.${unsafeKey} is not an allowed Meta object field.`);

  // These fields can carry IDs to a second object. Require their structured
  // forms so the checks below cannot be bypassed with encoded JSON/URLs.
  for (const field of ['creative', 'targeting', 'promoted_object']) {
    if (updates[field] !== undefined && (!updates[field] || typeof updates[field] !== 'object' || Array.isArray(updates[field])))
      return resultError('INVALID_ARGUMENT', `updates.${field} must be an object when supplied.`);
  }
  if (updates.targeting) {
    for (const field of ['custom_audiences', 'excluded_custom_audiences', 'excluded_audiences']) {
      if (updates.targeting[field] !== undefined && !Array.isArray(updates.targeting[field]))
        return resultError('INVALID_ARGUMENT', `updates.targeting.${field} must be an array when supplied.`);
      for (const entry of updates.targeting[field] || []) {
        const id = entry && typeof entry === 'object' ? entry.id : entry;
        if (typeof id !== 'string' && typeof id !== 'number')
          return resultError('INVALID_ARGUMENT', `updates.targeting.${field} entries must contain an ID.`);
      }
    }
  }
  for (const field of ['campaign_id', 'adset_id']) {
    if (updates[field] !== undefined && typeof updates[field] !== 'string' && typeof updates[field] !== 'number')
      return resultError('INVALID_ARGUMENT', `updates.${field} must be an ID.`);
  }
  for (const [parent, field] of [['creative', 'creative_id'], ['promoted_object', 'pixel_id']]) {
    const value = updates[parent]?.[field];
    if (value !== undefined && typeof value !== 'string' && typeof value !== 'number')
      return resultError('INVALID_ARGUMENT', `updates.${parent}.${field} must be an ID.`);
  }
  return null;
}

function metaChecks(name, args) {
  const checks = [];
  if (name === 'update_meta_object') {
    addMetaCheck(checks, args.object_id, { campaign: 'campaigns', adset: 'adsets', ad: 'ads' }[args.level], `${args.level || 'Meta object'} ID`);
    // The server passes updates through to Meta.  The documented reusable ad
    // creative shape is { creative: { creative_id } }; guard that concrete
    // cross-account reference while leaving other provider-specific fields
    // untouched.
    addMetaCheck(checks, args.updates?.creative?.creative_id, 'adcreatives', 'Creative ID');
    addMetaCheck(checks, args.updates?.campaign_id, 'campaigns', 'Campaign ID');
    addMetaCheck(checks, args.updates?.adset_id, 'adsets', 'Ad set ID');
    for (const audience of args.updates?.targeting?.custom_audiences || []) addMetaCheck(checks, typeof audience === 'object' ? audience.id : audience, 'customaudiences', 'Custom audience ID');
    for (const audience of args.updates?.targeting?.excluded_custom_audiences || args.updates?.targeting?.excluded_audiences || []) addMetaCheck(checks, typeof audience === 'object' ? audience.id : audience, 'customaudiences', 'Excluded custom audience ID');
    addMetaCheck(checks, args.updates?.promoted_object?.pixel_id, 'adspixels', 'Pixel ID');
  } else if (name === 'create_meta_campaign') {
    addMetaCheck(checks, args.existing_campaign_id, 'campaigns', 'Campaign ID');
    // The server also accepts existing:<id> shorthand in campaign_name and
    // ad-set name. Treat those as raw IDs, not as display names.
    if (!args.existing_campaign_id && typeof args.campaign_name === 'string' && args.campaign_name.startsWith('existing:'))
      addMetaCheck(checks, args.campaign_name.slice('existing:'.length), 'campaigns', 'Campaign ID');
    for (const [i, adSet] of (args.ad_sets || []).entries()) {
      addMetaCheck(checks, adSet.existing_adset_id, 'adsets', `Ad set ID in ad_sets[${i}]`);
      if (!adSet.existing_adset_id && typeof adSet.name === 'string' && adSet.name.startsWith('existing:'))
        addMetaCheck(checks, adSet.name.slice('existing:'.length), 'adsets', `Ad set ID in ad_sets[${i}]`);
      const targeting = adSet.targeting || {};
      for (const audience of targeting.custom_audiences || []) addMetaCheck(checks, typeof audience === 'object' ? audience.id : audience, 'customaudiences', 'Custom audience ID');
      for (const audience of targeting.excluded_audiences || []) addMetaCheck(checks, typeof audience === 'object' ? audience.id : audience, 'customaudiences', 'Excluded custom audience ID');
      addMetaCheck(checks, targeting?.promoted_object?.pixel_id, 'adspixels', 'Pixel ID');
      addMetaCheck(checks, adSet.promoted_object?.pixel_id, 'adspixels', 'Pixel ID');
      for (const ad of adSet.ads || []) addMetaCheck(checks, ad.creative_id, 'adcreatives', 'Creative ID');
    }
  } else if (name === 'create_meta_audience') {
    addMetaCheck(checks, args.seed_audience_id, 'customaudiences', 'Seed audience ID');
    addMetaCheck(checks, args.campaign_id, 'campaigns', 'Campaign ID');
  } else if (name === 'manage_meta_audience_users') {
    addMetaCheck(checks, args.audience_id, 'customaudiences', 'Audience ID');
  } else if (name === 'manage_meta_ad_rules') {
    if (args.action && args.action !== 'create' && args.action !== 'list') addMetaCheck(checks, args.rule_id, 'adrules_library', 'Ad rule ID');
  } else if (name === 'update_meta_subscription' || name === 'delete_meta_subscription') {
    addMetaCheck(checks, args.subscription_id, 'subscriptions', 'Subscription ID');
  }
  return checks;
}

function shouldCheck(name, args) {
  if (name === 'update_meta_object') return true; // explicit preview protection
  // `preview` posts to Meta and carries a rule_id, so preflight it just like
  // update/delete/execute. Pure reads (read/history/list) stay untouched.
  if (name === 'manage_meta_ad_rules') return new Set(['update', 'delete', 'preview', 'execute']).has(args.action);
  if (name === 'manage_meta_leads') return args.action === 'create_form';
  if (name === 'manage_negative_lists') return WRITE_ACTIONS.manage_negative_lists.has(args.action || 'list');
  if (name === 'manage_meta') return META_ACTIONS.manage_meta.has(args.action);
  if (META_TOOLS.has(name) || GOOGLE_TOOLS.has(name)) return true;
  return false;
}

/**
 * Validate that account-scoped raw identifiers belong to the selected account.
 *
 * @returns {Promise<{ok:boolean, code?:string, error?:string, account_id?:string}>}
 */
async function validateOwnership(name, args = {}, deps = {}) {
  if (!shouldCheck(name, args)) return { ok: true, skipped: true };
  const sharedPlatform = (name === 'pause_campaign' || name === 'enable_campaign' || name === 'update_budget')
    ? args.platform === 'meta' : null;
  const isMeta = sharedPlatform !== null
    ? sharedPlatform
    : (META_TOOLS.has(name) && !GOOGLE_TOOLS.has(name));
  const store = isMeta ? deps.metaAccounts : deps.googleAccounts;
  const resolved = accountMatch(store, args.account_name, deps, args.confirm === true);
  if (resolved?.ok === false) return resolved;
  if (!resolved?.match) return resultError('TARGET_ACCOUNT_MISMATCH', resolved?.error || 'The selected account could not be resolved');
  const [accountId] = resolved.match;

  const invalidUpdate = invalidMetaUpdateShape(name, args);
  if (invalidUpdate) return invalidUpdate;

  if (!isMeta) {
    const invalid = googleCheck(name, args, accountId);
    return invalid || success(resolved.match, accountId, 'google');
  }

  for (const [id, edge, label] of metaChecks(name, args)) {
    const invalid = await verifyMetaId(accountId, id, edge, label, deps);
    if (invalid) return invalid;
  }
  return success(resolved.match, accountId, 'meta');
}

module.exports = {
  validateOwnership,
  verifyMetaId,
  isGoogleResourceForCid,
  META_TOOLS,
  GOOGLE_TOOLS,
};
