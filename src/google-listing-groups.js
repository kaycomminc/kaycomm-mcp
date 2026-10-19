'use strict';

// Standard Shopping listing groups (product partitions) — read the tree and
// plan the mutate operations that rebuild it.
//
// A Shopping ad group's product tree is a set of ad_group_criterion rows of
// type LISTING_GROUP. The root is either a single UNIT (bid on "All products")
// or a SUBDIVISION whose children split inventory by one dimension, always
// including an "everything else" UNIT (the dimension key with no value).
//
// Google requires a tree to be valid after every mutate request, so a change
// is planned as ONE atomic request: remove the old root (which removes its
// subtree) and create the replacement tree using temporary negative criterion
// IDs. This module only builds those operations; server.js runs them.
//
// Scope: one level deep. The root may be split by a single dimension. Deeper
// trees, or a root already split by a different dimension, are refused rather
// than flattened, so nothing someone built by hand is silently lost.
//
// Bids on units only apply under Manual CPC. Under automated bidding
// (Maximize Clicks, Target ROAS) Google ignores unit bids, but exclusions
// (negative units) still take effect.

const DIMENSIONS = {
  item_id:        { caseKey: 'productItemId' },
  product_type_l1:{ caseKey: 'productType', extra: { level: 'LEVEL1' } },
  product_type_l2:{ caseKey: 'productType', extra: { level: 'LEVEL2' } },
  brand:          { caseKey: 'productBrand' },
  custom_label_0: { caseKey: 'productCustomAttribute', extra: { index: 'INDEX0' } },
  custom_label_1: { caseKey: 'productCustomAttribute', extra: { index: 'INDEX1' } },
  custom_label_2: { caseKey: 'productCustomAttribute', extra: { index: 'INDEX2' } },
  custom_label_3: { caseKey: 'productCustomAttribute', extra: { index: 'INDEX3' } },
  custom_label_4: { caseKey: 'productCustomAttribute', extra: { index: 'INDEX4' } },
};

const LISTING_GROUP_QUERY_FIELDS = `
    ad_group_criterion.resource_name,
    ad_group_criterion.criterion_id,
    ad_group_criterion.negative,
    ad_group_criterion.cpc_bid_micros,
    ad_group_criterion.listing_group.type,
    ad_group_criterion.listing_group.parent_ad_group_criterion,
    ad_group_criterion.listing_group.case_value.product_item_id.value,
    ad_group_criterion.listing_group.case_value.product_type.level,
    ad_group_criterion.listing_group.case_value.product_type.value,
    ad_group_criterion.listing_group.case_value.product_brand.value,
    ad_group_criterion.listing_group.case_value.product_custom_attribute.index,
    ad_group_criterion.listing_group.case_value.product_custom_attribute.value,
    ad_group.resource_name,
    ad_group.id,
    ad_group.name,
    ad_group.cpc_bid_micros`;

const micros = d => Math.round(Number(d) * 1_000_000);
const dollars = m => (m === undefined || m === null || m === '' ? null : Number(m) / 1_000_000);

// Map a REST caseValue back to { dimension, value }. value null = "everything else".
function readCaseValue(cv) {
  if (!cv || typeof cv !== 'object') return { dimension: null, value: null };
  for (const [name, def] of Object.entries(DIMENSIONS)) {
    const node = cv[def.caseKey];
    if (!node) continue;
    if (def.extra?.level && node.level !== def.extra.level) continue;
    if (def.extra?.index && node.index !== def.extra.index) continue;
    return { dimension: name, value: node.value ?? null };
  }
  return { dimension: 'other', value: null };
}

function caseValueFor(dimension, value) {
  const def = DIMENSIONS[dimension];
  if (!def) throw new Error(`Unsupported dimension '${dimension}'`);
  const node = { ...(def.extra || {}) };
  if (value !== null && value !== undefined) node.value = String(value);
  return { [def.caseKey]: node };
}

// rows: googleAds:search results from LISTING_GROUP_QUERY_FIELDS for ONE ad group.
function parseTree(rows) {
  const nodes = rows.map(r => {
    const c = r.adGroupCriterion || {};
    const lg = c.listingGroup || {};
    const { dimension, value } = readCaseValue(lg.caseValue);
    return {
      resource_name: c.resourceName,
      criterion_id: String(c.criterionId ?? ''),
      parent: lg.parentAdGroupCriterion || null,
      type: lg.type,
      negative: c.negative === true,
      cpc_bid: dollars(c.cpcBidMicros),
      dimension,
      value,
    };
  });
  const root = nodes.find(n => !n.parent) || null;
  const children = root ? nodes.filter(n => n.parent === root.resource_name) : [];
  const deeper = nodes.some(n => n.parent && n.parent !== root?.resource_name);
  return { nodes, root, children, deeper };
}

// Human-readable shape for the view action and dry-run output.
function describeTree(tree) {
  if (!tree.root) return { structure: 'empty', nodes: [] };
  if (tree.root.type === 'UNIT') {
    return {
      structure: 'single_unit',
      nodes: [{ value: 'All products', excluded: tree.root.negative, cpc_bid: tree.root.cpc_bid }],
    };
  }
  const dims = [...new Set(tree.children.map(c => c.dimension))];
  return {
    structure: tree.deeper ? 'multi_level' : 'one_level',
    split_by: dims.length === 1 ? dims[0] : dims,
    nodes: tree.children.map(c => ({
      value: c.value === null ? 'Everything else' : c.value,
      type: c.type,
      excluded: c.negative,
      cpc_bid: c.cpc_bid,
    })),
  };
}

function unitBidFor(tree, adGroupCpcBid) {
  if (!tree.root) return adGroupCpcBid ?? null;
  if (tree.root.type === 'UNIT') return tree.root.cpc_bid ?? adGroupCpcBid ?? null;
  const other = tree.children.find(c => c.value === null);
  return other?.cpc_bid ?? adGroupCpcBid ?? null;
}

function unitOp(adGroupRn, parentRn, dimension, value, { exclude, cpcBid }) {
  const create = {
    adGroup: adGroupRn,
    status: 'ENABLED',
    listingGroup: { type: 'UNIT', parentAdGroupCriterion: parentRn, caseValue: caseValueFor(dimension, value) },
  };
  if (exclude) create.negative = true;
  else if (cpcBid !== null && cpcBid !== undefined) create.cpcBidMicros = String(micros(cpcBid));
  return { adGroupCriterionOperation: { create } };
}

/**
 * Plan a one-level split of the ad group's tree by `dimension`.
 *
 * nodes: [{ value, exclude?, cpc_bid? }] — values already resolved (title
 * lookups happen in the caller). Existing children of a same-dimension split
 * are kept unless a node with the same value overrides them.
 *
 * @returns {{ ops, planned, warnings } | { error }}
 */
function planSplit({ tree, adGroupRn, adGroupCpcBid, dimension, nodes, othersCpcBid }) {
  if (!DIMENSIONS[dimension]) return { error: `Unsupported dimension '${dimension}'. Use one of: ${Object.keys(DIMENSIONS).join(', ')}` };
  if (!tree.root) return { error: 'This ad group has no product tree yet. Create it in Google Ads first.' };
  if (tree.deeper) return { error: 'This product tree is more than one level deep. Edit it in the Google Ads UI so nothing is lost.' };
  if (tree.root.type === 'SUBDIVISION') {
    const dims = new Set(tree.children.map(c => c.dimension));
    if (dims.size !== 1 || !dims.has(dimension)) {
      return { error: `The tree is already split by ${[...dims].join(', ')}. Use action=reset first to split by ${dimension}.` };
    }
  }
  if (!nodes?.length) return { error: 'nodes is required: at least one value to exclude or bid on.' };

  const warnings = [];
  const defaultBid = othersCpcBid ?? unitBidFor(tree, adGroupCpcBid);

  // Merge: existing same-dimension children first, then requested overrides.
  const merged = new Map();
  if (tree.root.type === 'SUBDIVISION') {
    for (const c of tree.children) {
      if (c.value === null) continue;
      merged.set(c.value.toLowerCase(), { value: c.value, exclude: c.negative, cpc_bid: c.cpc_bid, source: 'existing' });
    }
  }
  for (const n of nodes) {
    const value = String(n.value ?? '').trim();
    if (!value) return { error: 'Every node needs a non-empty value.' };
    if (!n.exclude && (n.cpc_bid === undefined || n.cpc_bid === null)) {
      return { error: `Node '${value}' needs exclude=true or a cpc_bid.` };
    }
    if (!n.exclude && !(Number(n.cpc_bid) > 0)) return { error: `cpc_bid for '${value}' must be greater than 0.` };
    const key = value.toLowerCase();
    if (merged.get(key)?.source === 'request') warnings.push(`'${value}' was listed twice; the last entry wins.`);
    merged.set(key, { value, exclude: n.exclude === true, cpc_bid: n.exclude ? null : Number(n.cpc_bid), source: 'request' });
  }

  const cid = adGroupRn.split('/')[1];
  const adGroupId = adGroupRn.split('/').pop();
  const tempRoot = `customers/${cid}/adGroupCriteria/${adGroupId}~-1`;

  const ops = [
    { adGroupCriterionOperation: { remove: tree.root.resource_name } },
    { adGroupCriterionOperation: { create: {
      resourceName: tempRoot, adGroup: adGroupRn, status: 'ENABLED', listingGroup: { type: 'SUBDIVISION' },
    } } },
  ];
  for (const n of merged.values()) {
    ops.push(unitOp(adGroupRn, tempRoot, dimension, n.value, { exclude: n.exclude, cpcBid: n.cpc_bid ?? defaultBid }));
  }
  // "Everything else" keeps the old catch-all bid (or others_cpc_bid).
  ops.push(unitOp(adGroupRn, tempRoot, dimension, null, { exclude: false, cpcBid: defaultBid }));

  const planned = [...merged.values()].map(n => ({
    value: n.value, excluded: n.exclude, cpc_bid: n.exclude ? null : (n.cpc_bid ?? defaultBid), kept_from_existing: n.source === 'existing',
  }));
  planned.push({ value: 'Everything else', excluded: false, cpc_bid: defaultBid });
  return { ops, planned, warnings };
}

// Collapse the tree back to a single "All products" unit.
function planReset({ tree, adGroupRn, adGroupCpcBid, othersCpcBid }) {
  if (!tree.root) return { error: 'This ad group has no product tree yet.' };
  if (tree.root.type === 'UNIT' && !tree.root.negative && othersCpcBid === undefined) {
    return { error: 'The tree is already a single "All products" unit.' };
  }
  const bid = othersCpcBid ?? unitBidFor(tree, adGroupCpcBid);
  const create = { adGroup: adGroupRn, status: 'ENABLED', listingGroup: { type: 'UNIT' } };
  if (bid !== null && bid !== undefined) create.cpcBidMicros = String(micros(bid));
  return {
    ops: [
      { adGroupCriterionOperation: { remove: tree.root.resource_name } },
      { adGroupCriterionOperation: { create } },
    ],
    planned: [{ value: 'All products', excluded: false, cpc_bid: bid }],
    warnings: [],
  };
}

// Resolve title substrings to item IDs from shopping_performance_view rows
// ({ segments: { productItemId, productTitle } }). Only products that have
// served in the lookback window can be found this way.
function resolveTitles(rows, patterns) {
  const items = new Map();
  for (const r of rows) {
    const id = r.segments?.productItemId;
    const title = r.segments?.productTitle;
    if (id && title && !items.has(id)) items.set(id, title);
  }
  return patterns.map(p => {
    const needle = String(p).toLowerCase();
    const matches = [...items.entries()].filter(([, t]) => t.toLowerCase().includes(needle))
      .map(([item_id, title]) => ({ item_id, title }));
    return { pattern: p, matches };
  });
}

module.exports = {
  DIMENSIONS,
  LISTING_GROUP_QUERY_FIELDS,
  readCaseValue,
  caseValueFor,
  parseTree,
  describeTree,
  planSplit,
  planReset,
  resolveTitles,
};
