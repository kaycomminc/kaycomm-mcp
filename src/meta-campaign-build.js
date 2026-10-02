'use strict';

// Pure helpers for create_meta_campaign: page resolution, multi-location geo,
// dynamic creative (asset_feed_spec) and special-ad-category review.
//
// Provider calls are injected (metaGet / searchGeo / getAudience) so the dry
// run and the confirmed build share one code path and tests can mock Graph.

// ── Page ID ──────────────────────────────────────────────────────────────────

// explicit (tool arg) > accounts.json > the ad account's promote_pages edge.
// promote_pages is only trusted when it returns exactly one page.
async function resolveMetaPageId({ accountId, accountName, explicit, configured, metaGet }) {
    const warnings = [];
    const listPages = async () => (await metaGet(`${accountId}/promote_pages`, { fields: 'id,name', limit: '100' })).data || [];

    if (explicit) {
        if (configured && configured !== explicit) warnings.push(`page_id ${explicit} overrides accounts.json page_id ${configured} for this call.`);
        try {
            const pages = await listPages();
            if (pages.length && !pages.some(p => p.id === explicit)) {
                warnings.push(`page_id ${explicit} is not in ${accountName}'s promote_pages (${pages.map(p => `${p.name} ${p.id}`).join(', ')}). Meta may reject ads for it.`);
            }
        } catch (_) { /* informational only */ }
        return { page_id: explicit, source: 'argument', warnings };
    }
    if (configured) return { page_id: configured, source: 'accounts.json', warnings };

    let pages;
    try {
        pages = await listPages();
    } catch (e) {
        return { error: `No page_id configured for '${accountName}' and promote_pages lookup failed (${e.message}). Pass page_id or set it with manage_accounts.` };
    }
    const saveHint = id => `manage_accounts action=update platform=meta id=${accountId} page_id=${id}`;
    if (pages.length === 1) {
        const [page] = pages;
        warnings.push(`No page_id in accounts.json for '${accountName}' — using its only promotable page, ${page.name} (${page.id}). Save it: ${saveHint(page.id)}`);
        return { page_id: page.id, source: 'promote_pages', warnings };
    }
    if (!pages.length) {
        return { error: `No page_id configured for '${accountName}' and the ad account has no promote_pages. Pass page_id or set it with manage_accounts.` };
    }
    return {
        error: `No page_id configured for '${accountName}' and the ad account can promote ${pages.length} pages: ` +
            `${pages.map(p => `${p.name} (${p.id})`).join(', ')}. Pass page_id, or save one with ${saveHint('<id>')}.`,
        pages: pages.map(p => ({ id: p.id, name: p.name })),
    };
}

// ── Multi-location geo ───────────────────────────────────────────────────────

const US_STATES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
    DE: 'Delaware', DC: 'Washington, District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
    IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine',
    MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
    MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
    NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
    PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
    UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

// Meta search `type` → geo_locations key. Counties are medium_geo_area in Meta.
const GEO_TYPES = {
    city: 'cities', subcity: 'subcities', neighborhood: 'neighborhoods', region: 'regions', zip: 'zips',
    geo_market: 'geo_markets', medium_geo_area: 'medium_geo_areas', small_geo_area: 'small_geo_areas',
    country: 'countries',
};
const TYPE_HINTS = {
    city: ['city'], county: ['medium_geo_area'], region: ['region'], state: ['region'], zip: ['zip'],
    dma: ['geo_market'], neighborhood: ['neighborhood'], subcity: ['subcity'], country: ['country'],
};
const DEFAULT_SEARCH_TYPES = ['city', 'medium_geo_area', 'region', 'zip', 'geo_market', 'subcity', 'neighborhood'];
// When one name+region matches several types (e.g. a city and a subcity), prefer in this order.
const TYPE_PREFERENCE = ['city', 'medium_geo_area', 'region', 'zip', 'geo_market', 'subcity', 'neighborhood', 'small_geo_area'];
const CITY_RADIUS_MILES = { min: 10, max: 50 };

function parseGeoName(raw) {
    const name = String(raw).trim();
    const m = name.match(/^(.*?),\s*([^,]+)$/);
    if (!m) return { base: name, region: null };
    const tail = m[2].trim();
    return { base: m[1].trim(), region: US_STATES[tail.toUpperCase()] || tail };
}

function searchTypesFor(geo, base) {
    if (geo.type) return TYPE_HINTS[geo.type] || [geo.type];
    if (/^\d{5}$/.test(base)) return ['zip'];
    if (/\b(county|parish|borough)\b/i.test(base)) return ['medium_geo_area'];
    return DEFAULT_SEARCH_TYPES;
}

// Resolve [{name, radius?, type?}] to a geo_locations spec. Never guesses:
// an ambiguous or unmatched name is an error listing Meta's candidates.
async function resolveMetaGeos(geos, { searchGeo, defaultRadius = 25 }) {
    const geo_locations = {};
    const resolved = [];
    const errors = [];
    const warnings = [];
    for (const [i, geo] of geos.entries()) {
        const { base, region } = parseGeoName(geo.name);
        const types = searchTypesFor(geo, base);
        let results;
        try {
            results = await searchGeo(base, types);
        } catch (e) {
            errors.push(`geos[${i}] '${geo.name}': geo search failed (${e.message})`);
            continue;
        }
        const candidates = results.filter(r => types.includes(r.type));
        const lc = s => String(s || '').toLowerCase();
        let matches = candidates.filter(r => lc(r.name) === lc(base));
        if (region) matches = matches.filter(r => lc(r.region) === lc(region) || lc(r.country_name) === lc(region) || lc(r.country_code) === lc(region));
        const show = list => list.slice(0, 8).map(r => `${r.name}${r.region ? `, ${r.region}` : ''} [${r.type} ${r.key}]`).join('; ');
        if (!matches.length) {
            errors.push(`geos[${i}] '${geo.name}': no exact ${types.join('/')} match${candidates.length ? `. Meta suggests: ${show(candidates)}` : ''}`);
            continue;
        }
        const regions = new Set(matches.map(r => `${r.region}|${r.country_code}`));
        if (regions.size > 1) {
            errors.push(`geos[${i}] '${geo.name}': ambiguous — add a state/region (e.g. '${base}, CO'). Matches: ${show(matches)}`);
            continue;
        }
        const match = [...matches].sort((a, b) => TYPE_PREFERENCE.indexOf(a.type) - TYPE_PREFERENCE.indexOf(b.type))[0];
        const bucket = GEO_TYPES[match.type];
        if (!bucket) {
            errors.push(`geos[${i}] '${geo.name}': resolved to unsupported location type '${match.type}'`);
            continue;
        }
        const entry = { input: geo.name, key: match.key, name: match.name, type: match.type, region: match.region || null, country_code: match.country_code || null };
        if (match.type === 'city') {
            const radius = geo.radius ?? defaultRadius;
            if (radius < CITY_RADIUS_MILES.min || radius > CITY_RADIUS_MILES.max) {
                warnings.push(`geos[${i}] '${geo.name}': Meta accepts city radii of ${CITY_RADIUS_MILES.min}-${CITY_RADIUS_MILES.max} miles; ${radius} will likely be rejected.`);
            }
            entry.radius = radius;
            (geo_locations.cities ||= []).push({ key: match.key, radius, distance_unit: 'mile' });
        } else {
            if (geo.radius != null) warnings.push(`geos[${i}] '${geo.name}' is a ${match.type}; radius ${geo.radius} is ignored (only cities take a radius).`);
            if (bucket === 'countries') (geo_locations.countries ||= []).push(match.country_code || match.key);
            else (geo_locations[bucket] ||= []).push({ key: match.key });
        }
        resolved.push(entry);
    }
    return { geo_locations, resolved, errors, warnings };
}

// ── Ad copy + dynamic creative ───────────────────────────────────────────────

// Meta's recommended lengths — past these, copy is truncated in some placements.
// Warn only: copy is always sent byte-for-byte.
const COPY_LIMITS = { primary_text: 125, headline: 40, description: 30 };
const DCO_LIMITS = { images: 10, videos: 10, bodies: 5, titles: 5, descriptions: 5, call_to_action_types: 5 };
const AD_FORMATS = ['SINGLE_IMAGE', 'SINGLE_VIDEO', 'CAROUSEL', 'AUTOMATIC_FORMAT'];

const charLength = s => [...s].length;

function copyLengthWarnings(ad, where) {
    const warnings = [];
    const check = (text, kind, label) => {
        if (typeof text !== 'string') return;
        const len = charLength(text);
        if (len > COPY_LIMITS[kind]) warnings.push(`${where} ${label} is ${len} chars (Meta recommends ≤${COPY_LIMITS[kind]}; may truncate in some placements). Sent unchanged.`);
    };
    check(ad.primary_text, 'primary_text', 'primary_text');
    check(ad.headline, 'headline', 'headline');
    check(ad.description, 'description', 'description');
    const afs = ad.asset_feed_spec;
    if (afs) {
        (afs.bodies || []).forEach((t, i) => check(t, 'primary_text', `asset_feed_spec.bodies[${i}]`));
        (afs.titles || []).forEach((t, i) => check(t, 'headline', `asset_feed_spec.titles[${i}]`));
        (afs.descriptions || []).forEach((t, i) => check(t, 'description', `asset_feed_spec.descriptions[${i}]`));
    }
    return warnings;
}

// Dry-run + pre-build validation of one ad set's creatives.
function validateAdSetCreatives(adSet, i) {
    const errors = [];
    const warnings = [];
    const where = `ad_sets[${i}] '${adSet.name}'`;
    const ads = adSet.ads || [];

    if (adSet.is_dynamic_creative && !adSet.existing_adset_id) {
        if (ads.length !== 1) errors.push(`${where}: is_dynamic_creative requires exactly one ad (got ${ads.length}).`);
        ads.forEach((ad, j) => {
            if (!ad.asset_feed_spec) errors.push(`${where} ads[${j}] '${ad.name}': dynamic creative ad sets require asset_feed_spec on the ad.`);
        });
    }
    ads.forEach((ad, j) => {
        const adWhere = `${where} ads[${j}] '${ad.name}'`;
        warnings.push(...copyLengthWarnings(ad, adWhere));
        if (ad.placement_videos?.length) {
            // Lazy: meta-placement-videos depends on this module.
            const { validateVideoVariants } = require('./meta-placement-videos');
            const conflicts = ['asset_feed_spec', 'carousel_cards', 'object_story_id', 'creative_id'].filter(k => ad[k] != null && !(Array.isArray(ad[k]) && !ad[k].length));
            if (conflicts.length) errors.push(`${adWhere}: placement_videos can't be combined with ${conflicts.join(', ')}.`);
            if (adSet.is_dynamic_creative) errors.push(`${adWhere}: placement_videos can't be used in a dynamic creative ad set.`);
            if (!ad.video_id) errors.push(`${adWhere}: placement_videos needs video_id — the default video for placements not listed.`);
            if (!ad.url) errors.push(`${adWhere}: placement_videos needs url.`);
            errors.push(...validateVideoVariants(ad.placement_videos).errors.map(e => `${adWhere}: ${e}`));
        }
        const afs = ad.asset_feed_spec;
        if (!afs) return;
        const conflicts = ['image_hash', 'video_id', 'carousel_cards', 'object_story_id', 'creative_id', 'primary_text', 'headline', 'description']
            .filter(k => ad[k] != null && !(Array.isArray(ad[k]) && !ad[k].length));
        if (conflicts.length) errors.push(`${adWhere}: asset_feed_spec can't be combined with ${conflicts.join(', ')} — put all assets and copy inside asset_feed_spec.`);
        if (!(afs.images?.length || afs.videos?.length)) errors.push(`${adWhere}: asset_feed_spec needs at least one image or video.`);
        if (!afs.link_urls?.length && !ad.url) errors.push(`${adWhere}: asset_feed_spec needs link_urls (or set url on the ad).`);
        if (!afs.bodies?.length) warnings.push(`${adWhere}: asset_feed_spec has no bodies (primary text).`);
        if (!afs.titles?.length) warnings.push(`${adWhere}: asset_feed_spec has no titles (headlines).`);
        for (const [field, max] of Object.entries(DCO_LIMITS)) {
            if ((afs[field]?.length || 0) > max) errors.push(`${adWhere}: asset_feed_spec.${field} has ${afs[field].length} items; Meta allows ${max}.`);
        }
        if ((afs.link_urls?.length || 0) > 1) warnings.push(`${adWhere}: dynamic creative normally takes one link URL; Meta may reject ${afs.link_urls.length}.`);
        if (!adSet.is_dynamic_creative) {
            warnings.push(`${adWhere}: asset_feed_spec in an ad set without is_dynamic_creative is sent as a flexible-format creative (optimization_type DEGREES_OF_FREEDOM). Verify the preview in Ads Manager.`);
        }
    });
    return { errors, warnings };
}

// Tool shape → Graph asset_feed_spec. Text is mapped into {text} wrappers
// untouched: no trim, no normalization, no truncation.
function buildAssetFeedSpec(ad, { dynamicCreative }) {
    const afs = ad.asset_feed_spec;
    const images = afs.images || [];
    const videos = afs.videos || [];
    const spec = {};
    if (images.length) spec.images = images.map(hash => ({ hash }));
    if (videos.length) spec.videos = videos.map(video_id => ({ video_id }));
    if (afs.bodies?.length) spec.bodies = afs.bodies.map(text => ({ text }));
    if (afs.titles?.length) spec.titles = afs.titles.map(text => ({ text }));
    if (afs.descriptions?.length) spec.descriptions = afs.descriptions.map(text => ({ text }));
    spec.link_urls = (afs.link_urls?.length ? afs.link_urls : [ad.url]).map(website_url => ({ website_url }));
    spec.call_to_action_types = afs.call_to_action_types?.length ? afs.call_to_action_types : [ad.cta || 'LEARN_MORE'];
    spec.ad_formats = afs.ad_formats?.length ? afs.ad_formats
        : images.length && videos.length ? ['AUTOMATIC_FORMAT'] : videos.length ? ['SINGLE_VIDEO'] : ['SINGLE_IMAGE'];
    if (!dynamicCreative) spec.optimization_type = 'DEGREES_OF_FREEDOM';
    return spec;
}

// ── Special ad categories ────────────────────────────────────────────────────

const RESTRICTED_CATEGORIES = new Set(['EMPLOYMENT', 'HOUSING', 'CREDIT']);
const SAC_MIN_RADIUS_MILES = 15;
const KM_PER_MILE = 1.609344;

// Flags targeting Meta rejects or strips for EMPLOYMENT / HOUSING / CREDIT.
// Reports only — the build still sends what was requested.
async function reviewSpecialAdCategoryTargeting({ categories, targeting = {}, spec = {}, getAudience }) {
    const restricted = (categories || []).filter(c => RESTRICTED_CATEGORIES.has(c));
    if (!restricted.length) return null;
    const issues = [];
    const add = (field, message) => issues.push({ field, message });
    const label = restricted.join('/');

    const ageMin = spec.age_min ?? targeting.age_min;
    const ageMax = spec.age_max ?? targeting.age_max;
    if ((ageMin != null && ageMin !== 18) || (ageMax != null && ageMax !== 65)) {
        add('age', `${label} ads must target ages 18-65+; requested ${ageMin ?? 18}-${ageMax ?? 65} will be rejected or reset.`);
    }
    const genders = spec.genders || targeting.genders;
    if (Array.isArray(genders) && genders.length && !(genders.includes(1) && genders.includes(2))) {
        add('genders', `${label} ads can't target by gender; genders ${JSON.stringify(genders)} will be rejected or removed.`);
    }
    const geo = spec.geo_locations || {};
    if (geo.zips?.length) {
        add('geo_locations.zips', `${label} ads can't target ZIP codes (${geo.zips.map(z => z.key || z).join(', ')}). Use cities with a ≥${SAC_MIN_RADIUS_MILES}-mile radius, counties or regions.`);
    }
    for (const loc of [...(geo.cities || []), ...(geo.custom_locations || [])]) {
        if (loc.radius == null) continue;
        const miles = loc.distance_unit === 'kilometer' ? loc.radius / KM_PER_MILE : loc.radius;
        if (miles < SAC_MIN_RADIUS_MILES) {
            add('geo_locations.radius', `${label} ads need a radius of at least ${SAC_MIN_RADIUS_MILES} miles; ${loc.key || loc.address_string || `${loc.latitude},${loc.longitude}`} is ${loc.radius} ${loc.distance_unit || 'mile'}s and will be expanded or rejected.`);
        }
    }
    const exclusionKinds = Object.keys(spec.exclusions || {}).filter(k => k !== 'custom_audiences');
    if (exclusionKinds.length) {
        add('exclusions', `${label} ads can't use detailed-targeting exclusions (${exclusionKinds.join(', ')}); they will be removed.`);
    }
    for (const id of (spec.custom_audiences || []).map(a => a.id || a)) {
        if (!getAudience) continue;
        try {
            const aud = await getAudience(id);
            if (aud?.subtype === 'LOOKALIKE') add('custom_audiences', `${label} ads can't use lookalike audiences; ${aud.name || id} (${id}) will be rejected.`);
        } catch (e) {
            add('custom_audiences', `Couldn't check whether audience ${id} is a lookalike (${e.message}); ${label} ads can't use lookalikes.`);
        }
    }

    // Meta doesn't expose per-option eligibility for these categories, so every
    // requested detailed-targeting option is reported as expected to drop.
    const dropped = [];
    for (const group of spec.flexible_spec || []) {
        for (const [kind, items] of Object.entries(group)) {
            for (const item of items || []) dropped.push({ kind, id: item.id, name: item.name || null });
        }
    }
    if (dropped.length) {
        add('flexible_spec', `${label} ads restrict detailed targeting; Meta removes ineligible options when the ad set is saved. Expect these to be dropped: ${dropped.map(d => `${d.name || d.id} (${d.kind})`).join(', ')}.`);
    }
    return { categories: restricted, issues, dropped_detailed_targeting: dropped };
}

module.exports = {
    resolveMetaPageId, resolveMetaGeos, parseGeoName, US_STATES,
    COPY_LIMITS, AD_FORMATS, copyLengthWarnings, validateAdSetCreatives, buildAssetFeedSpec,
    reviewSpecialAdCategoryTargeting, RESTRICTED_CATEGORIES,
};
