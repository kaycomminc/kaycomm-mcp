'use strict';

// Ad set reads for manage_meta: full targeting passthrough, audience name
// resolution, server-side Graph filtering, and the plan for duplicating a
// campaign under a new objective.

const ADSET_LIST_FIELDS = 'id,name,status,effective_status,start_time,end_time,daily_budget,lifetime_budget,' +
  'optimization_goal,campaign_id,campaign{id,name},targeting';

const ADSET_DETAIL_FIELDS = 'id,name,status,effective_status,targeting,optimization_goal,billing_event,' +
  'bid_strategy,bid_amount,bid_constraints,promoted_object,daily_budget,lifetime_budget,budget_remaining,' +
  'start_time,end_time,destination_type,attribution_spec,is_dynamic_creative,' +
  'campaign_id,campaign{id,name,objective,bid_strategy,daily_budget,lifetime_budget}';

// Status buckets → Graph effective_status values. Meta never flips status when
// a schedule ends, so COMPLETED is ACTIVE/PAUSED + a past end_time, applied
// after the fetch.
const STATUS_BUCKETS = {
  ACTIVE:    ['ACTIVE', 'IN_PROCESS', 'WITH_ISSUES'],
  PAUSED:    ['PAUSED', 'CAMPAIGN_PAUSED'],
  COMPLETED: ['ACTIVE', 'IN_PROCESS', 'WITH_ISSUES', 'PAUSED', 'CAMPAIGN_PAUSED'],
  ARCHIVED:  ['ARCHIVED'],
};
const DEFAULT_STATUSES = ['ACTIVE', 'PAUSED'];

const ended = (end, now = Date.now()) => !!end && new Date(end).getTime() <= now;

function normalizeStatusFilter(input) {
  if (input == null || input === '') return [...DEFAULT_STATUSES];
  const list = (Array.isArray(input) ? input : String(input).split(','))
    .map(s => String(s).trim().toUpperCase()).filter(Boolean);
  if (list.includes('ALL')) return Object.keys(STATUS_BUCKETS);
  const bad = list.filter(s => !STATUS_BUCKETS[s]);
  if (bad.length) throw new Error(`Unknown status_filter value(s): ${bad.join(', ')}. Use ACTIVE, PAUSED, COMPLETED, ARCHIVED or ALL.`);
  return [...new Set(list)];
}

// Graph `filtering` array for /act_x/adsets.
function buildAdsetFiltering({ nameContains, campaignIds, statuses }) {
  const f = [];
  const eff = [...new Set(statuses.flatMap(s => STATUS_BUCKETS[s]))];
  f.push({ field: 'effective_status', operator: 'IN', value: eff });
  if (campaignIds?.length) f.push({ field: 'campaign.id', operator: 'IN', value: campaignIds.map(String) });
  if (nameContains) f.push({ field: 'name', operator: 'CONTAIN', value: nameContains });
  return f;
}

function adsetBucket(row, now = Date.now()) {
  if (row.effective_status === 'ARCHIVED') return 'ARCHIVED';
  if (ended(row.end_time, now)) return 'COMPLETED';
  if (STATUS_BUCKETS.PAUSED.includes(row.effective_status)) return 'PAUSED';
  return 'ACTIVE';
}

// Every custom-audience id referenced by a targeting spec (top level,
// exclusions, and flexible_spec groups).
function collectAudienceIds(targeting = {}) {
  const ids = new Set();
  const add = list => (list || []).forEach(a => a?.id && ids.add(String(a.id)));
  add(targeting.custom_audiences);
  add(targeting.excluded_custom_audiences);
  add(targeting.exclusions?.custom_audiences);
  (targeting.flexible_spec || []).forEach(g => add(g.custom_audiences));
  return [...ids];
}

// One Graph read per 50 ids (`?ids=a,b,c`), never one per audience. A batch
// that fails (e.g. an audience shared from another business) falls back to
// per-batch warnings; names embedded in the targeting spec still apply.
async function resolveAudienceNames(ids, metaGet, warnings = []) {
  const map = new Map();
  const unique = [...new Set(ids.map(String))];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    try {
      const data = await metaGet('', { ids: chunk.join(','), fields: 'id,name,subtype' });
      for (const id of chunk) {
        const a = data?.[id];
        if (a) map.set(id, { id, name: a.name ?? null, subtype: a.subtype ?? null });
      }
    } catch (e) {
      warnings.push(`Audience name lookup failed for ${chunk.length} audience(s): ${e.message}`);
    }
  }
  return map;
}

function namedAudiences(list, audienceMap) {
  if (!list?.length) return null;
  return list.map(a => {
    const hit = audienceMap?.get(String(a.id));
    const out = { id: String(a.id), name: hit?.name ?? a.name ?? null };
    if (hit?.subtype) out.subtype = hit.subtype;
    return out;
  });
}

function audienceSummary(t = {}, audienceMap) {
  return {
    custom_audiences: namedAudiences(t.custom_audiences, audienceMap),
    excluded_custom_audiences: namedAudiences(
      [...(t.excluded_custom_audiences || []), ...(t.exclusions?.custom_audiences || [])], audienceMap),
  };
}

const money = v => (v ? parseFloat(v) / 100 : null);

function shapeAdset(s, { audienceMap = null, includeRaw = false, delivery } = {}) {
  const t = s.targeting || {};
  const interests = (t.flexible_spec || []).flatMap(fs => (fs.interests || []).map(i => ({ id: i.id, name: i.name })));
  const behaviors = (t.flexible_spec || []).flatMap(fs => (fs.behaviors || []).map(b => ({ id: b.id, name: b.name })));
  const aud = audienceSummary(t, audienceMap);
  const out = {
    id: s.id, name: s.name, status: s.status,
    effective_status: s.effective_status || null,
    delivery: delivery ? delivery(s.effective_status, ended(s.end_time)) : null,
    start_time: s.start_time || null,
    end_time: s.end_time || null,
    campaign: s.campaign?.name || s.campaign_id,
    campaign_id: s.campaign?.id || s.campaign_id || null,
    optimization_goal: s.optimization_goal || null,
    daily_budget: money(s.daily_budget),
    lifetime_budget: money(s.lifetime_budget),
    targeting: {
      age_min: t.age_min || null,
      age_max: t.age_max || null,
      geo_locations: t.geo_locations || null,
      interests: interests.length ? interests : null,
      behaviors: behaviors.length ? behaviors : null,
      custom_audiences: aud.custom_audiences,
      excluded_custom_audiences: aud.excluded_custom_audiences,
      publisher_platforms: t.publisher_platforms || null,
      facebook_positions: t.facebook_positions || null,
      instagram_positions: t.instagram_positions || null,
      audience_network_positions: t.audience_network_positions || null,
      messenger_positions: t.messenger_positions || null,
    },
    level: 'adset',
  };
  if (includeRaw) out.targeting_raw = s.targeting || null;
  return out;
}

function shapeAdsetDetail(s, { audienceMap = null, delivery } = {}) {
  const aud = audienceSummary(s.targeting || {}, audienceMap);
  const c = s.campaign || {};
  return {
    id: s.id, name: s.name, status: s.status,
    effective_status: s.effective_status || null,
    delivery: delivery ? delivery(s.effective_status, ended(s.end_time)) : null,
    campaign: { id: c.id || s.campaign_id || null, name: c.name || null, objective: c.objective || null },
    optimization_goal: s.optimization_goal || null,
    billing_event: s.billing_event || null,
    bid_strategy: s.bid_strategy || null,
    campaign_bid_strategy: c.bid_strategy || null,
    bid_amount: money(s.bid_amount),
    bid_constraints: s.bid_constraints || null,
    promoted_object: s.promoted_object || null,
    destination_type: s.destination_type || null,
    attribution_spec: s.attribution_spec || null,
    is_dynamic_creative: !!s.is_dynamic_creative,
    daily_budget: money(s.daily_budget),
    lifetime_budget: money(s.lifetime_budget),
    budget_remaining: money(s.budget_remaining),
    campaign_budget: (c.daily_budget || c.lifetime_budget)
      ? { daily_budget: money(c.daily_budget), lifetime_budget: money(c.lifetime_budget) } : null,
    start_time: s.start_time || null,
    end_time: s.end_time || null,
    custom_audiences: aud.custom_audiences,
    excluded_custom_audiences: aud.excluded_custom_audiences,
    targeting_raw: s.targeting || null,
  };
}

// ── create_meta_campaign dry-run display ─────────────────────────────────────

// Placement line from the final merged spec (after targeting_raw + defaults).
function placementSummary(spec = {}) {
  const platforms = spec.publisher_platforms;
  if (!platforms?.length) return 'Advantage+ (auto)';
  const posKey = { facebook: 'facebook_positions', instagram: 'instagram_positions',
    audience_network: 'audience_network_positions', messenger: 'messenger_positions', threads: 'threads_positions' };
  const parts = platforms.map(p => {
    const pos = spec[posKey[p]];
    return pos?.length ? `${p} (${pos.join(', ')})` : `${p} (all positions)`;
  });
  const devices = spec.device_platforms?.length ? `; devices: ${spec.device_platforms.join(', ')}` : '';
  return `Manual: ${parts.join(', ')}${devices}`;
}

function audienceLine(spec = {}) {
  const lines = [];
  const inc = spec.custom_audiences || [];
  const exc = [...(spec.excluded_custom_audiences || []), ...(spec.exclusions?.custom_audiences || [])];
  const label = a => a.name ? `${a.name} (${a.id})` : String(a.id);
  if (inc.length) lines.push(`audiences: ${inc.map(label).join(', ')}`);
  if (exc.length) lines.push(`excluded audiences: ${exc.map(label).join(', ')}`);
  return lines;
}

function existingCreativePreview(ad) {
  return { name: ad.name, creative: `existing creative ${ad.creative_id}`, creative_id: String(ad.creative_id) };
}

// ── duplicate_meta_campaign with an objective override ───────────────────────
// Meta refuses objective changes once a campaign has ad sets, so the copy is a
// fresh campaign; ad sets are re-created from their read spec (not /copies)
// so optimization_goal can change, and ads are /copies'd into them.

const SOURCE_CAMPAIGN_FIELDS = 'name,objective,status,special_ad_categories,special_ad_category_country,' +
  'bid_strategy,daily_budget,lifetime_budget,start_time,stop_time';
const SOURCE_ADSET_FIELDS = 'id,name,status,targeting,optimization_goal,billing_event,bid_strategy,bid_amount,' +
  'daily_budget,lifetime_budget,start_time,end_time,promoted_object,destination_type,attribution_spec,' +
  'is_dynamic_creative,daily_min_spend_target,daily_spend_cap';

// Promoted objects that only make sense for conversion/lead/app objectives.
const PROMOTED_OBJECT_OBJECTIVES = new Set(['OUTCOME_SALES', 'OUTCOME_LEADS', 'OUTCOME_APP_PROMOTION', 'OUTCOME_ENGAGEMENT']);

function planObjectiveDuplicate(tree, { objective, optimization_goal, billing_event, new_name, status,
  start_time, stop_time, daily_budget, lifetime_budget } = {}) {
  if (!objective) throw new Error('objective is required for an objective override');
  const src = tree.campaign || {};
  const warnings = [];
  const resolvedStatus = status === 'INHERITED_FROM_SOURCE' ? (src.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED') : (status || 'PAUSED');
  const cbo = !!(src.daily_budget || src.lifetime_budget || daily_budget != null || lifetime_budget != null);
  const objectiveChanged = objective !== src.objective;

  const campaignBody = {
    name: new_name || `Copy of ${src.name}`,
    objective,
    status: resolvedStatus,
    special_ad_categories: src.special_ad_categories || [],
  };
  if (src.special_ad_category_country?.length) campaignBody.special_ad_category_country = src.special_ad_category_country;
  if (start_time || src.start_time) campaignBody.start_time = start_time || src.start_time;
  if (stop_time || src.stop_time) campaignBody.stop_time = stop_time || src.stop_time;
  if (cbo) {
    let bs = src.bid_strategy || 'LOWEST_COST_WITHOUT_CAP';
    if (objectiveChanged && bs !== 'LOWEST_COST_WITHOUT_CAP') {
      warnings.push(`Campaign bid_strategy ${bs} reset to LOWEST_COST_WITHOUT_CAP: caps/targets do not carry across objectives.`);
      bs = 'LOWEST_COST_WITHOUT_CAP';
    }
    campaignBody.bid_strategy = bs;
    if (lifetime_budget != null) campaignBody.lifetime_budget = Math.round(lifetime_budget * 100);
    else if (daily_budget != null) campaignBody.daily_budget = Math.round(daily_budget * 100);
    else if (src.lifetime_budget) campaignBody.lifetime_budget = Number(src.lifetime_budget);
    else campaignBody.daily_budget = Number(src.daily_budget);
  } else {
    campaignBody.is_adset_budget_sharing_enabled = false;
  }

  const adsets = (tree.adsets || []).map(s => {
    const goal = optimization_goal || s.optimization_goal;
    const goalChanged = goal !== s.optimization_goal;
    const dropped = [];
    const body = {
      name: s.name,
      status: resolvedStatus,
      optimization_goal: goal,
      billing_event: billing_event || (goalChanged ? 'IMPRESSIONS' : (s.billing_event || 'IMPRESSIONS')),
      targeting: s.targeting,
    };
    if (!cbo) {
      if (s.daily_budget) body.daily_budget = Number(s.daily_budget);
      if (s.lifetime_budget) body.lifetime_budget = Number(s.lifetime_budget);
    }
    for (const k of ['start_time', 'end_time', 'daily_min_spend_target', 'daily_spend_cap']) if (s[k]) body[k] = s[k];
    if (s.is_dynamic_creative) body.is_dynamic_creative = true;

    const changed = objectiveChanged || goalChanged;
    if (s.bid_strategy) {
      if (changed && s.bid_strategy !== 'LOWEST_COST_WITHOUT_CAP') dropped.push(`bid_strategy ${s.bid_strategy}${s.bid_amount ? ` (bid_amount ${s.bid_amount})` : ''} → LOWEST_COST_WITHOUT_CAP`);
      else if (!cbo || s.bid_strategy !== 'LOWEST_COST_WITHOUT_CAP') {
        body.bid_strategy = s.bid_strategy;
        if (s.bid_amount) body.bid_amount = Number(s.bid_amount);
      }
    }
    if (!cbo && !body.bid_strategy) body.bid_strategy = 'LOWEST_COST_WITHOUT_CAP';
    if (s.promoted_object) {
      if (!changed || (PROMOTED_OBJECT_OBJECTIVES.has(objective) && goal === s.optimization_goal)) body.promoted_object = s.promoted_object;
      else dropped.push('promoted_object');
    }
    if (s.destination_type) {
      if (!changed) body.destination_type = s.destination_type;
      else dropped.push(`destination_type ${s.destination_type}`);
    }
    if (s.attribution_spec) {
      if (!changed) body.attribution_spec = s.attribution_spec;
      else dropped.push('attribution_spec');
    }
    return {
      source_id: s.id, name: s.name,
      optimization_goal: { from: s.optimization_goal || null, to: goal },
      body, dropped,
      ads: (s.ads || []).map(a => ({ id: a.id, name: a.name })),
    };
  });

  return { campaign: { from_objective: src.objective || null, body: campaignBody }, cbo, adsets, warnings };
}

module.exports = {
  ADSET_LIST_FIELDS, ADSET_DETAIL_FIELDS, STATUS_BUCKETS, DEFAULT_STATUSES,
  SOURCE_CAMPAIGN_FIELDS, SOURCE_ADSET_FIELDS,
  normalizeStatusFilter, buildAdsetFiltering, adsetBucket, collectAudienceIds, resolveAudienceNames,
  namedAudiences, shapeAdset, shapeAdsetDetail, placementSummary, audienceLine, existingCreativePreview,
  planObjectiveDuplicate,
};
