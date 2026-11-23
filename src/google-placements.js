/**
 * Placement exclusions / inclusions (YouTube channels, videos, websites, apps).
 * Planners are pure (rows in, operations out) so they can be tested without the API.
 *
 *  exclude → negative criterion at account (customer_negative_criterion),
 *            campaign (campaign_criterion) or ad group (ad_group_criterion) level
 *  include → positive placement criterion on an ad group (ad_group_criterion)
 */

const TYPES = ["YOUTUBE_CHANNEL", "YOUTUBE_VIDEO", "WEBSITE", "MOBILE_APP"];
const API_TYPE = { YOUTUBE_CHANNEL: "YOUTUBE_CHANNEL", YOUTUBE_VIDEO: "YOUTUBE_VIDEO", WEBSITE: "PLACEMENT", MOBILE_APP: "MOBILE_APPLICATION" };

const CHANNEL_ID = /^UC[\w-]{22}$/;
const VIDEO_ID = /^[\w-]{11}$/;

// Turn user input (ID, URL, domain, app ID) into { type, value, key }.
// An explicit `forceType` wins; otherwise the type is inferred.
function parsePlacement(raw, forceType) {
    const input = String(raw ?? "").trim();
    if (!input) throw new Error("Empty placement.");
    const type = forceType ? String(forceType).toUpperCase() : null;
    if (type && !TYPES.includes(type)) throw new Error(`Unknown placement_type '${forceType}'. Valid: ${TYPES.join(", ")}.`);

    const ytChannelUrl = /(?:^|\/\/)(?:www\.|m\.)?youtube\.com\/channel\/([\w-]+)/i.exec(input);
    const ytVideoUrl = /(?:^|\/\/)(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/i.exec(input);
    const ytHandle = /(?:^|\/\/)(?:www\.|m\.)?youtube\.com\/@/i.test(input);
    if (ytHandle) throw new Error(`'${input}' is a YouTube @handle URL — the API needs the channel ID (UC…, from youtube.com/channel/UC…). get_placements returns it.`);

    let t = type, value = input;
    if (!t) {
        if (ytChannelUrl) { t = "YOUTUBE_CHANNEL"; value = ytChannelUrl[1]; }
        else if (ytVideoUrl) { t = "YOUTUBE_VIDEO"; value = ytVideoUrl[1]; }
        else if (CHANNEL_ID.test(input)) t = "YOUTUBE_CHANNEL";
        else if (/^mobileapp::/i.test(input)) t = "MOBILE_APP";
        else if (/^[\w-]{11}$/.test(input) && !/[.]/.test(input)) t = "YOUTUBE_VIDEO";
        else t = "WEBSITE";
    } else {
        if (t === "YOUTUBE_CHANNEL" && ytChannelUrl) value = ytChannelUrl[1];
        if (t === "YOUTUBE_VIDEO" && ytVideoUrl) value = ytVideoUrl[1];
    }

    if (t === "YOUTUBE_CHANNEL" && !CHANNEL_ID.test(value)) throw new Error(`'${input}' is not a valid YouTube channel ID (expected UC + 22 chars).`);
    if (t === "YOUTUBE_VIDEO" && !VIDEO_ID.test(value)) throw new Error(`'${input}' is not a valid YouTube video ID (11 chars).`);
    if (t === "WEBSITE") {
        value = value.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "").toLowerCase();
        if (!value || /\s/.test(value) || !value.includes(".")) throw new Error(`'${input}' is not a valid website/domain.`);
    }
    if (t === "MOBILE_APP" && !/^mobileapp::\d-[\w.]+$/i.test(value)) throw new Error(`'${input}' is not a valid app ID (expected mobileapp::1-com.example.app for Android or mobileapp::2-123456789 for iOS).`);
    return { type: t, value, key: `${t}:${value.toLowerCase()}` };
}

// The criterion body shared by all three resource types.
function criterionBody(p) {
    switch (p.type) {
        case "YOUTUBE_CHANNEL": return { youtubeChannel: { channelId: p.value } };
        case "YOUTUBE_VIDEO":   return { youtubeVideo: { videoId: p.value } };
        case "MOBILE_APP":      return { mobileApplication: { appId: p.value } };
        default:                return { placement: { url: p.value } };
    }
}

const SCOPES = {
    account:  { op: "customerNegativeCriterionOperation" },
    campaign: { op: "campaignCriterionOperation",  parent: "campaign" },
    ad_group: { op: "adGroupCriterionOperation",   parent: "adGroup" },
};

// existing: [{ resource_name, key }] — placements already on this scope+polarity.
function planAdd({ scope, parentResource, placements, existing, negative, cpcBidMicros }) {
    const have = new Set(existing.map(e => e.key));
    const ops = [], adding = [], skipped = [];
    const seen = new Set();
    for (const p of placements) {
        if (have.has(p.key) || seen.has(p.key)) { skipped.push(p.value); continue; }
        seen.add(p.key);
        const s = SCOPES[scope];
        const create = { ...criterionBody(p) };
        if (s.parent) create[s.parent] = parentResource;
        if (scope !== "account") create.negative = negative;
        if (!negative && cpcBidMicros) create.cpcBidMicros = String(cpcBidMicros);
        ops.push({ [s.op]: { create } });
        adding.push(`${p.type}: ${p.value}`);
    }
    return { ops, adding, skipped_already_present: skipped };
}

function planRemove({ scope, placements, existing }) {
    const byKey = new Map(existing.map(e => [e.key, e]));
    const ops = [], removing = [], not_found = [];
    for (const p of placements) {
        const hit = byKey.get(p.key);
        if (!hit) { not_found.push(p.value); continue; }
        ops.push({ [SCOPES[scope].op]: { remove: hit.resource_name } });
        removing.push(`${p.type}: ${p.value}`);
    }
    return { ops, removing, not_found };
}

// ── GAQL + row mapping ──────────────────────────────────────────────────────
const TYPE_FILTER = "('PLACEMENT','YOUTUBE_CHANNEL','YOUTUBE_VIDEO','MOBILE_APPLICATION')";
const FIELDS = (r) => `${r}.resource_name, ${r}.type, ${r}.placement.url, ${r}.youtube_channel.channel_id, ${r}.youtube_video.video_id, ${r}.mobile_application.app_id, ${r}.mobile_application.name`;

function placementQuery(scope, { campaignId, adGroupId } = {}) {
    if (scope === "account") {
        return `SELECT ${FIELDS("customer_negative_criterion")}
                FROM customer_negative_criterion
                WHERE customer_negative_criterion.type IN ${TYPE_FILTER}`;
    }
    if (scope === "campaign") {
        return `SELECT campaign.name, campaign_criterion.negative, ${FIELDS("campaign_criterion")}
                FROM campaign_criterion
                WHERE campaign_criterion.type IN ${TYPE_FILTER} AND campaign_criterion.status != 'REMOVED'
                  ${campaignId ? `AND campaign.id = ${Number(campaignId)}` : ""}`;
    }
    return `SELECT campaign.name, ad_group.name, ad_group_criterion.negative, ${FIELDS("ad_group_criterion")}
            FROM ad_group_criterion
            WHERE ad_group_criterion.type IN ${TYPE_FILTER} AND ad_group_criterion.status != 'REMOVED'
              ${adGroupId ? `AND ad_group.id = ${Number(adGroupId)}` : ""}
              ${campaignId ? `AND campaign.id = ${Number(campaignId)}` : ""}`;
}

function mapRow(scope, r) {
    const c = r[{ account: "customerNegativeCriterion", campaign: "campaignCriterion", ad_group: "adGroupCriterion" }[scope]] || {};
    let p;
    if (c.youtubeChannel?.channelId)      p = { type: "YOUTUBE_CHANNEL", value: c.youtubeChannel.channelId };
    else if (c.youtubeVideo?.videoId)     p = { type: "YOUTUBE_VIDEO",   value: c.youtubeVideo.videoId };
    else if (c.mobileApplication?.appId)  p = { type: "MOBILE_APP",      value: c.mobileApplication.appId };
    else if (c.placement?.url)            p = { type: "WEBSITE",         value: String(c.placement.url).toLowerCase() };
    else return null;
    return {
        resource_name: c.resourceName,
        ...p,
        key: `${p.type}:${p.value.toLowerCase()}`,
        negative: scope === "account" ? true : c.negative === true,
        campaign: r.campaign?.name,
        ad_group: r.adGroup?.name,
    };
}

module.exports = { TYPES, API_TYPE, parsePlacement, criterionBody, planAdd, planRemove, placementQuery, mapRow };
