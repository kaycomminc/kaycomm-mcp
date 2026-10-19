const test = require('node:test');
const assert = require('node:assert/strict');
const LG = require('../src/google-listing-groups');

const AG = 'customers/123/adGroups/555';
const crit = (id, extra) => ({ adGroupCriterion: { resourceName: `customers/123/adGroupCriteria/555~${id}`, criterionId: id, ...extra } });

const singleUnitRows = [crit('1', { cpcBidMicros: '2500000', listingGroup: { type: 'UNIT' } })];
const splitRows = [
  crit('1', { listingGroup: { type: 'SUBDIVISION' } }),
  crit('2', { negative: true, listingGroup: { type: 'UNIT', parentAdGroupCriterion: 'customers/123/adGroupCriteria/555~1', caseValue: { productItemId: { value: 'sku-1' } } } }),
  crit('3', { cpcBidMicros: '3000000', listingGroup: { type: 'UNIT', parentAdGroupCriterion: 'customers/123/adGroupCriteria/555~1', caseValue: { productItemId: {} } } }),
];

test('parseTree / describeTree: single unit and one-level split', () => {
  const one = LG.describeTree(LG.parseTree(singleUnitRows));
  assert.equal(one.structure, 'single_unit');
  assert.equal(one.nodes[0].cpc_bid, 2.5);

  const split = LG.describeTree(LG.parseTree(splitRows));
  assert.equal(split.structure, 'one_level');
  assert.equal(split.split_by, 'item_id');
  assert.deepEqual(split.nodes.map(n => [n.value, n.excluded]), [['sku-1', true], ['Everything else', false]]);
});

test('planSplit from a single unit removes the root first and keeps the catch-all bid', () => {
  const tree = LG.parseTree(singleUnitRows);
  const plan = LG.planSplit({ tree, adGroupRn: AG, dimension: 'item_id', nodes: [{ value: 'sku-9', exclude: true }] });
  assert.ok(!plan.error, plan.error);
  const [remove, root, ...units] = plan.ops.map(o => o.adGroupCriterionOperation);
  assert.equal(remove.remove, 'customers/123/adGroupCriteria/555~1');
  assert.equal(root.create.listingGroup.type, 'SUBDIVISION');
  assert.equal(root.create.resourceName, 'customers/123/adGroupCriteria/555~-1');
  assert.equal(units.length, 2);
  const excluded = units[0].create;
  assert.equal(excluded.negative, true);
  assert.equal(excluded.cpcBidMicros, undefined, 'negative units carry no bid');
  assert.deepEqual(excluded.listingGroup.caseValue, { productItemId: { value: 'sku-9' } });
  assert.equal(excluded.listingGroup.parentAdGroupCriterion, root.create.resourceName);
  const other = units[1].create;
  assert.deepEqual(other.listingGroup.caseValue, { productItemId: {} }, 'everything-else has no value');
  assert.equal(other.cpcBidMicros, '2500000');
});

test('planSplit merges existing same-dimension children and lets requests override', () => {
  const tree = LG.parseTree(splitRows);
  const plan = LG.planSplit({ tree, adGroupRn: AG, dimension: 'item_id', nodes: [{ value: 'SKU-1', cpc_bid: 1.25 }, { value: 'sku-2', exclude: true }] });
  assert.ok(!plan.error, plan.error);
  const values = plan.planned.map(n => [n.value, n.excluded, n.cpc_bid]);
  assert.deepEqual(values, [['SKU-1', false, 1.25], ['sku-2', true, null], ['Everything else', false, 3]]);
});

test('planSplit refuses a different dimension, deeper trees, and nodes without an effect', () => {
  const tree = LG.parseTree(splitRows);
  assert.match(LG.planSplit({ tree, adGroupRn: AG, dimension: 'brand', nodes: [{ value: 'x', exclude: true }] }).error, /already split by item_id/);
  const deep = LG.parseTree([...splitRows, crit('4', { listingGroup: { type: 'UNIT', parentAdGroupCriterion: 'customers/123/adGroupCriteria/555~3' } })]);
  assert.match(LG.planSplit({ tree: deep, adGroupRn: AG, dimension: 'item_id', nodes: [{ value: 'x', exclude: true }] }).error, /more than one level/);
  assert.match(LG.planSplit({ tree: LG.parseTree(singleUnitRows), adGroupRn: AG, dimension: 'item_id', nodes: [{ value: 'x' }] }).error, /exclude=true or a cpc_bid/);
});

test('product type and custom label case values carry level / index', () => {
  assert.deepEqual(LG.caseValueFor('product_type_l1', 'Desks'), { productType: { level: 'LEVEL1', value: 'Desks' } });
  assert.deepEqual(LG.caseValueFor('custom_label_2', null), { productCustomAttribute: { index: 'INDEX2' } });
  assert.deepEqual(LG.readCaseValue({ productType: { level: 'LEVEL1', value: 'Desks' } }), { dimension: 'product_type_l1', value: 'Desks' });
});

test('planReset collapses to one All products unit', () => {
  const plan = LG.planReset({ tree: LG.parseTree(splitRows), adGroupRn: AG });
  assert.equal(plan.ops.length, 2);
  assert.equal(plan.ops[1].adGroupCriterionOperation.create.listingGroup.type, 'UNIT');
  assert.equal(plan.ops[1].adGroupCriterionOperation.create.cpcBidMicros, '3000000');
});

test('resolveTitles matches case-insensitively and reports misses', () => {
  const rows = [
    { segments: { productItemId: 'a1', productTitle: 'Astoria Slat Bench' } },
    { segments: { productItemId: 'a1', productTitle: 'Astoria Slat Bench' } },
    { segments: { productItemId: 'b2', productTitle: 'Milano Curved Custom Bench' } },
  ];
  const [bench, none] = LG.resolveTitles(rows, ['bench', 'locker']);
  assert.deepEqual(bench.matches.map(m => m.item_id), ['a1', 'b2']);
  assert.equal(none.matches.length, 0);
});
