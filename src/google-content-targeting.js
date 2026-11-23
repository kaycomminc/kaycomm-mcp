/**
 * Content exclusions / targeting: topics and content labels.
 * Pure planners (rows in, operations out), same shape as google-placements.js.
 *
 *  topics         campaign / ad group level. exclude (negative) or include (ad group, positive)
 *  content_labels exclusions only, at account (customer_negative_criterion), campaign or ad group level
 */

// Common content labels. The list is advisory: the dry run validates every
// label against Google, so a label missing here is warned about, not blocked.
const KNOWN_CONTENT_LABELS = [
    "JUVENILE", "GAME", "PROFANITY", "TRAGEDY", "SEXUALLY_SUGGESTIVE", "BELOW_THE_FOLD", "PARKED_DOMAIN",
    "EMBEDDED_VIDEO", "LIVE_STREAMING_VIDEO", "SOCIAL_ISSUES", "VIDEO", "VIDEO_NOT_YET_RATED",
    "VIDEO_RATING_DV_Y", "VIDEO_RATING_DV_G", "VIDEO_RATING_DV_PG", "VIDEO_RATING_DV_T", "VIDEO_RATING_DV_MA",
];

function parseContentLabel(raw) {
    const v = String(raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
    if (!/^[A-Z][A-Z0-9_]+$/.test(v)) throw new Error(`'${raw}' is not a valid content label (e.g. ${KNOWN_CONTENT_LABELS.slice(0, 4).join(", ")}).`);
    return { kind: "CONTENT_LABEL", value: v, key: `CONTENT_LABEL:${v}`, known: KNOWN_CONTENT_LABELS.includes(v) };
}

// constants: [{ id, path: ["Games", "Computer & Video Games"] }]. Accepts a numeric ID, an
// exact path ("/Games/Roleplaying Games"), or a unique name/substring ("Roleplaying Games").
const pathStr = c => "/" + (c.path || []).join("/");
function resolveTopic(raw, constants) {
    const input = String(raw ?? "").trim();
    if (!input) throw new Error("Empty topic.");
    let hits;
    if (/^\d+$/.test(input)) {
        hits = constants.filter(c => String(c.id) === input);
    } else {
        const q = input.toLowerCase().replace(/^\/+/, "");
        const exact = constants.filter(c => pathStr(c).slice(1).toLowerCase() === q);
        const leaf = constants.filter(c => (c.path || []).at(-1)?.toLowerCase() === q);
        const sub = constants.filter(c => pathStr(c).toLowerCase().includes(q));
        hits = exact.length ? exact : leaf.length ? leaf : sub;
    }
    if (!hits.length) throw new Error(`No topic matching '${input}'. Use action=search_topics to browse.`);
    if (hits.length > 1) {
        const list = hits.slice(0, 8).map(c => `${c.id} ${pathStr(c)}`).join("; ");
        throw new Error(`'${input}' matches ${hits.length} topics (${list}${hits.length > 8 ? "; …" : ""}). Use the numeric ID or full path.`);
    }
    const c = hits[0];
    return { kind: "TOPIC", value: String(c.id), label: pathStr(c), key: `TOPIC:${c.id}` };
}

function searchTopics(constants, query, limit = 50) {
    const q = String(query || "").toLowerCase();
    return constants.filter(c => !q || pathStr(c).toLowerCase().includes(q)).slice(0, limit).map(c => ({ id: String(c.id), path: pathStr(c) }));
}

const SCOPES = {
    account:  { op: "customerNegativeCriterionOperation" },
    campaign: { op: "campaignCriterionOperation", parent: "campaign" },
    ad_group: { op: "adGroupCriterionOperation",  parent: "adGroup" },
};

const body = t => t.kind === "TOPIC" ? { topic: { topicConstant: `topicConstants/${t.value}` } } : { contentLabel: { type: t.value } };
const describe = t => t.kind === "TOPIC" ? `TOPIC: ${t.label || t.value}` : `CONTENT_LABEL: ${t.value}`;

function planAdd({ scope, parentResource, targets, existing, negative }) {
    const have = new Set(existing.map(e => e.key));
    const seen = new Set();
    const ops = [], adding = [], skipped = [];
    for (const t of targets) {
        if (have.has(t.key) || seen.has(t.key)) { skipped.push(describe(t)); continue; }
        seen.add(t.key);
        const s = SCOPES[scope];
        const create = { ...body(t) };
        if (s.parent) create[s.parent] = parentResource;
        if (scope !== "account") create.negative = negative;
        ops.push({ [s.op]: { create } });
        adding.push(describe(t));
    }
    return { ops, adding, skipped_already_present: skipped };
}

function planRemove({ scope, targets, existing }) {
    const byKey = new Map(existing.map(e => [e.key, e]));
    const ops = [], removing = [], not_found = [];
    for (const t of targets) {
        const hit = byKey.get(t.key);
        if (!hit) { not_found.push(describe(t)); continue; }
        ops.push({ [SCOPES[scope].op]: { remove: hit.resource_name } });
        removing.push(describe(t));
    }
    return { ops, removing, not_found };
}

const TYPE_FILTER = "('TOPIC','CONTENT_LABEL')";
const FIELDS = r => `${r}.resource_name, ${r}.type, ${r}.topic.topic_constant, ${r}.topic.path, ${r}.content_label.type`;

function contentQuery(scope, { campaignId, adGroupId } = {}) {
    if (scope === "account") {
        return `SELECT customer_negative_criterion.resource_name, customer_negative_criterion.type, customer_negative_criterion.content_label.type
                FROM customer_negative_criterion
                WHERE customer_negative_criterion.type = 'CONTENT_LABEL'`;
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
    let t;
    if (c.topic?.topicConstant) {
        const id = String(c.topic.topicConstant).split("/").pop();
        t = { kind: "TOPIC", value: id, label: c.topic.path ? "/" + c.topic.path.join("/") : id, key: `TOPIC:${id}` };
    } else if (c.contentLabel?.type) {
        t = { kind: "CONTENT_LABEL", value: c.contentLabel.type, key: `CONTENT_LABEL:${c.contentLabel.type}` };
    } else return null;
    return {
        resource_name: c.resourceName, ...t,
        negative: scope === "account" ? true : c.negative === true,
        campaign: r.campaign?.name, ad_group: r.adGroup?.name,
    };
}

module.exports = { KNOWN_CONTENT_LABELS, parseContentLabel, resolveTopic, searchTopics, planAdd, planRemove, contentQuery, mapRow, describe };
