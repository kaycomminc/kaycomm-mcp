/**
 * Google Ads campaign cleanup helpers: remove negatives, unlink assets, ad
 * schedules, and a read-only settings audit. Planners are pure (rows in, ops
 * out); the audit takes the server's googleSearch so it can be tested.
 */

const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
const DAY_GROUPS = {
    WEEKDAYS: DAYS.slice(0, 5),
    WEEKENDS: DAYS.slice(5),
    ALL: DAYS,
};
const MINUTE_ENUM = { 0: "ZERO", 15: "FIFTEEN", 30: "THIRTY", 45: "FORTY_FIVE" };
const MINUTE_NUM = { ZERO: 0, FIFTEEN: 15, THIRTY: 30, FORTY_FIVE: 45 };

const LANGUAGES = { "languageConstants/1000": "English", "languageConstants/1003": "Spanish" };

const norm = s => String(s || "").trim().toLowerCase();

// ── remove_negative_keywords ────────────────────────────────────────────────
// rows: campaign negative keyword criteria [{resource_name, text, match_type}].
// Exact text match only (case-insensitive) — never substring.
function planRemoveNegatives(rows, keywords, matchType) {
    const mt = matchType ? String(matchType).toUpperCase() : null;
    const ops = [];
    const removing = [];
    const not_found = [];
    for (const kw of keywords) {
        const text = norm(kw.replace(/^["']|["']$/g, ""));
        const hits = rows.filter(r => norm(r.text) === text && (!mt || r.match_type === mt));
        if (!hits.length) { not_found.push(kw); continue; }
        for (const h of hits) {
            ops.push({ campaignCriterionOperation: { remove: h.resource_name } });
            removing.push(`${h.text} (${h.match_type})`);
        }
    }
    return { ops, removing, not_found };
}

// ── remove_ad_extension (unlink only; the asset is never deleted) ───────────
// rows: campaign_asset links [{resource_name, asset_id, field_type, text}].
function planUnlinkAssets(rows, { assetIds = [], texts = [] }) {
    const ids = new Set(assetIds.map(String));
    const wanted = texts.map(norm);
    const picked = new Map();
    const not_found = [];
    for (const id of ids) {
        const hit = rows.filter(r => r.asset_id === id);
        if (!hit.length) not_found.push(`asset ${id}`);
        hit.forEach(h => picked.set(h.resource_name, h));
    }
    for (const t of wanted) {
        const hit = rows.filter(r => norm(r.text) === t);
        if (!hit.length) not_found.push(`"${t}"`);
        hit.forEach(h => picked.set(h.resource_name, h));
    }
    const links = [...picked.values()];
    return {
        ops: links.map(l => ({ campaignAssetOperation: { remove: l.resource_name } })),
        unlinking: links.map(l => `${l.field_type}: ${l.text || l.asset_id} (asset ${l.asset_id})`),
        not_found,
    };
}

// ── update_ad_schedule ──────────────────────────────────────────────────────
function parseTime(str) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || "").trim());
    if (!m) throw new Error(`Bad time '${str}' — use HH:MM (24h), e.g. 11:00 or 18:00.`);
    const hour = Number(m[1]), minute = Number(m[2]);
    if (!(minute in MINUTE_ENUM)) throw new Error(`Minutes must be 00, 15, 30 or 45 (got ${m[2]}).`);
    if (hour > 24 || (hour === 24 && minute !== 0)) throw new Error(`Hour out of range in '${str}'.`);
    return { hour, minute };
}

function expandDays(days) {
    const out = new Set();
    for (const d of days || []) {
        const key = String(d).toUpperCase();
        if (DAY_GROUPS[key]) DAY_GROUPS[key].forEach(x => out.add(x));
        else if (DAYS.includes(key)) out.add(key);
        else throw new Error(`Unknown day '${d}' — use MONDAY..SUNDAY, WEEKDAYS, WEEKENDS or ALL.`);
    }
    return DAYS.filter(d => out.has(d));
}

const fmtSlot = s => `${s.day_of_week} ${String(s.start_hour).padStart(2, "0")}:${String(MINUTE_NUM[s.start_minute] ?? 0).padStart(2, "0")}-${String(s.end_hour).padStart(2, "0")}:${String(MINUTE_NUM[s.end_minute] ?? 0).padStart(2, "0")}`;

// existing: [{resource_name, day_of_week, start_hour, start_minute, end_hour, end_minute, bid_modifier}]
function planAdSchedule({ campaignResource, existing, days, start, end, replaceExisting, removeDays }) {
    const ops = [], adding = [], removing = [], skipped = [];
    const removeSet = new Set(expandDays(removeDays));
    for (const e of existing) {
        if (replaceExisting || removeSet.has(e.day_of_week)) {
            ops.push({ campaignCriterionOperation: { remove: e.resource_name } });
            removing.push(fmtSlot(e));
        }
    }
    const addDays = expandDays(days);
    if (addDays.length) {
        const s = parseTime(start), e = parseTime(end);
        if (s.hour * 60 + s.minute >= e.hour * 60 + e.minute) throw new Error("start_time must be before end_time.");
        const kept = existing.filter(x => !(replaceExisting || removeSet.has(x.day_of_week)));
        for (const d of addDays) {
            const slot = { day_of_week: d, start_hour: s.hour, start_minute: MINUTE_ENUM[s.minute], end_hour: e.hour, end_minute: MINUTE_ENUM[e.minute] };
            if (kept.some(k => fmtSlot(k) === fmtSlot(slot))) { skipped.push(fmtSlot(slot)); continue; }
            ops.push({ campaignCriterionOperation: { create: {
                campaign: campaignResource,
                adSchedule: { dayOfWeek: d, startHour: s.hour, startMinute: slot.start_minute, endHour: e.hour, endMinute: slot.end_minute },
            } } });
            adding.push(fmtSlot(slot));
        }
    }
    return { ops, adding, removing, skipped };
}

function mapScheduleRows(rows) {
    return rows.map(r => {
        const a = r.campaignCriterion.adSchedule || {};
        return {
            resource_name: r.campaignCriterion.resourceName,
            day_of_week: a.dayOfWeek, start_hour: a.startHour, start_minute: a.startMinute || "ZERO",
            end_hour: a.endHour, end_minute: a.endMinute || "ZERO",
            bid_modifier: r.campaignCriterion.bidModifier ?? null,
        };
    });
}

// ── audit_campaign_settings (read-only) ─────────────────────────────────────
// deps: { googleSearch, fetchConversionGoals, getCampaignGeoTargets }
async function auditCampaignSettings(deps, token, cid, mcc, { campaignFilter, includeAccount = true }) {
    const { googleSearch } = deps;
    const filter = norm(campaignFilter);
    const campRows = await googleSearch(token, cid, mcc, `
        SELECT campaign.id, campaign.name, campaign.status, campaign.resource_name,
               campaign.network_settings.target_google_search, campaign.network_settings.target_search_network,
               campaign.network_settings.target_content_network, campaign.network_settings.target_partner_search_network,
               campaign.geo_target_type_setting.positive_geo_target_type,
               campaign.geo_target_type_setting.negative_geo_target_type,
               campaign.end_date_time, campaign.start_date_time, campaign.bidding_strategy_type,
               campaign.ai_max_setting.enable_ai_max, campaign.asset_automation_settings,
               campaign.advertising_channel_type
        FROM campaign WHERE campaign.status != 'REMOVED'`);
    const camps = campRows.map(r => r.campaign).filter(c => !filter || norm(c.name).includes(filter));
    const idList = camps.map(c => c.id).join(", ");
    const out = { campaigns: [] };
    if (!camps.length) return { ...out, message: `No campaign matching '${campaignFilter}'` };

    const [langs, shared, sched, rot, kw, goals] = await Promise.all([
        googleSearch(token, cid, mcc, `SELECT campaign.id, campaign_criterion.language.language_constant FROM campaign_criterion WHERE campaign.id IN (${idList}) AND campaign_criterion.type = 'LANGUAGE'`),
        googleSearch(token, cid, mcc, `SELECT campaign.id, shared_set.name, shared_set.type, campaign_shared_set.status FROM campaign_shared_set WHERE campaign.id IN (${idList})`),
        googleSearch(token, cid, mcc, `SELECT campaign.id, campaign_criterion.resource_name, campaign_criterion.bid_modifier, campaign_criterion.ad_schedule.day_of_week, campaign_criterion.ad_schedule.start_hour, campaign_criterion.ad_schedule.start_minute, campaign_criterion.ad_schedule.end_hour, campaign_criterion.ad_schedule.end_minute FROM campaign_criterion WHERE campaign.id IN (${idList}) AND campaign_criterion.type = 'AD_SCHEDULE'`),
        googleSearch(token, cid, mcc, `SELECT campaign.id, ad_group.ad_rotation_mode FROM ad_group WHERE campaign.id IN (${idList}) AND ad_group.status != 'REMOVED'`),
        googleSearch(token, cid, mcc, `SELECT campaign.id, ad_group_criterion.keyword.text FROM ad_group_criterion WHERE campaign.id IN (${idList}) AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED' AND ad_group_criterion.keyword.match_type = 'BROAD'`),
        deps.fetchConversionGoals(token, cid, mcc, campaignFilter || ""),
    ]);
    const by = (rows, f = r => r) => rows.reduce((m, r) => ((m[r.campaign.id] ||= []).push(f(r)), m), {});
    const langBy = by(langs, r => LANGUAGES[r.campaignCriterion.language.languageConstant] || r.campaignCriterion.language.languageConstant);
    const sharedBy = by(shared, r => `${r.sharedSet.name} (${r.campaignSharedSet.status})`);
    const schedBy = by(sched, r => r);
    const rotBy = by(rot, r => r.adGroup.adRotationMode || "UNSET");
    const kwBy = by(kw, r => r.adGroupCriterion.keyword.text);
    const goalBy = Object.fromEntries((goals.campaigns || []).map(g => [g.campaign, g]));

    for (const c of camps) {
        const geo = await deps.getCampaignGeoTargets(token, cid, mcc, c.resourceName || c.resource_name || `customers/${cid}/campaigns/${c.id}`);
        const net = c.networkSettings || {};
        out.campaigns.push({
            campaign: c.name, status: c.status, channel: c.advertisingChannelType, bidding: c.biddingStrategyType,
            start: c.startDateTime || null, end_date: c.endDateTime || null,
            networks: {
                google_search: !!net.targetGoogleSearch, search_partners: !!net.targetSearchNetwork || !!net.targetPartnerSearchNetwork,
                display: !!net.targetContentNetwork,
            },
            geo_target_type: geo.geo_target_type,
            locations: geo.targets.map(t => `${t.negative ? "EXCLUDE " : ""}${t.name}`),
            languages: langBy[c.id] || [],
            ad_rotation: [...new Set(rotBy[c.id] || [])],
            ai_max: c.aiMaxSetting?.enableAiMax === true,
            asset_automation: c.assetAutomationSettings || [],
            broad_match_keywords: kwBy[c.id] || [],
            conversion_goal: goalBy[c.name]?.goal_source || null,
            shared_negative_lists: sharedBy[c.id] || [],
            ad_schedule: mapScheduleRows(schedBy[c.id] || []).map(fmtSlot),
        });
    }

    if (includeAccount) {
        const [cust, subs, acctAssets] = await Promise.all([
            googleSearch(token, cid, mcc, `SELECT customer.time_zone, customer.auto_tagging_enabled, customer.descriptive_name FROM customer`),
            googleSearch(token, cid, mcc, `SELECT recommendation_subscription.type, recommendation_subscription.status FROM recommendation_subscription`),
            googleSearch(token, cid, mcc, `SELECT customer_asset.field_type, customer_asset.status, asset.id, asset.type, asset.source, asset.callout_asset.callout_text, asset.sitelink_asset.link_text, asset.structured_snippet_asset.values FROM customer_asset WHERE customer_asset.status != 'REMOVED'`),
        ]);
        const c = cust[0]?.customer || {};
        out.account = {
            time_zone: c.timeZone, auto_tagging: c.autoTaggingEnabled === true,
            auto_apply_recommendations: subs.map(r => `${r.recommendationSubscription.type}: ${r.recommendationSubscription.status}`),
            auto_apply_note: subs.length ? undefined : "No recommendation subscriptions returned — none auto-applied.",
            account_level_assets: acctAssets.map(r => ({
                type: r.customerAsset.fieldType, status: r.customerAsset.status, source: r.asset.source,
                text: r.asset.calloutAsset?.calloutText || r.asset.sitelinkAsset?.linkText || (r.asset.structuredSnippetAsset?.values || []).join(", ") || r.asset.id,
            })),
            automatically_created_assets_note: "Account-level 'automatically created assets' is not readable via the Google Ads API; check Account settings in the UI. Campaign-level text automation is in each campaign's asset_automation.",
        };
    }
    return out;
}

module.exports = {
    DAYS, planRemoveNegatives, planUnlinkAssets, planAdSchedule, parseTime, expandDays,
    mapScheduleRows, fmtSlot, auditCampaignSettings,
};
