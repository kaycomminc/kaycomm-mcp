const test = require('node:test');
const assert = require('node:assert/strict');
const CS = require('../src/google-campaign-settings');

test('planRemoveNegatives: exact text only, optional match type', () => {
  const rows = [
    { resource_name: 'r/can', text: 'can', match_type: 'PHRASE' },
    { resource_name: 'r/canned', text: 'canned', match_type: 'PHRASE' },
    { resource_name: 'r/can-e', text: 'can', match_type: 'EXACT' },
  ];
  const all = CS.planRemoveNegatives(rows, ['Can', 'nope'], null);
  assert.deepEqual(all.ops.map(o => o.campaignCriterionOperation.remove), ['r/can', 'r/can-e']);
  assert.deepEqual(all.not_found, ['nope']);
  const phrase = CS.planRemoveNegatives(rows, ['can'], 'phrase');
  assert.deepEqual(phrase.ops.map(o => o.campaignCriterionOperation.remove), ['r/can']);
});

test('planUnlinkAssets: by id and by exact text', () => {
  const rows = [
    { resource_name: 'ca/1', asset_id: '1', field_type: 'CALLOUT', text: 'Delivery Available' },
    { resource_name: 'ca/2', asset_id: '2', field_type: 'CALLOUT', text: 'Delivery' },
  ];
  const p = CS.planUnlinkAssets(rows, { assetIds: ['1'], texts: ['delivery', 'zzz'] });
  assert.deepEqual(p.ops.map(o => o.campaignAssetOperation.remove), ['ca/1', 'ca/2']);
  assert.deepEqual(p.not_found, ['"zzz"']);
});

test('planAdSchedule: weekdays 11-18, skips duplicates, replace', () => {
  const p = CS.planAdSchedule({ campaignResource: 'c/1', existing: [], days: ['WEEKDAYS'], start: '11:00', end: '18:00' });
  assert.equal(p.ops.length, 5);
  assert.equal(p.ops[0].campaignCriterionOperation.create.adSchedule.startHour, 11);
  const existing = [{ resource_name: 'x/1', day_of_week: 'MONDAY', start_hour: 11, start_minute: 'ZERO', end_hour: 18, end_minute: 'ZERO' }];
  const q = CS.planAdSchedule({ campaignResource: 'c/1', existing, days: ['WEEKDAYS'], start: '11:00', end: '18:00' });
  assert.equal(q.ops.length, 4);
  assert.deepEqual(q.skipped, ['MONDAY 11:00-18:00']);
  const r = CS.planAdSchedule({ campaignResource: 'c/1', existing, days: ['MONDAY'], start: '09:00', end: '17:30', replaceExisting: true });
  assert.equal(r.ops.length, 2);
  assert.throws(() => CS.planAdSchedule({ campaignResource: 'c', existing: [], days: ['MONDAY'], start: '18:00', end: '11:00' }));
  assert.throws(() => CS.parseTime('11:10'));
});
