const test = require('node:test');
const assert = require('node:assert/strict');
const {
  minorToMajor, transactionAmount, unixToDate, normalizeAccount, normalizeTransaction,
  normalizeDailySpend, spendWindowsMatching, analyzeBilling,
} = require('../src/meta-billing');

const TZ = 'America/Denver';
const unix = iso => Math.floor(Date.parse(iso) / 1000);

test('money fields: account minor units and both transaction amount shapes', () => {
  assert.equal(minorToMajor('69140'), 691.4);
  assert.equal(minorToMajor(undefined), null);
  assert.equal(transactionAmount({ amount: '317.50', amount_in_hundredths: '31750', currency: 'USD' }), 317.5);
  assert.equal(transactionAmount({ amount: '900.00' }), 900);
  assert.equal(transactionAmount('691.40'), 691.4);
  assert.equal(transactionAmount(null), null);
});

test('dates are reported in the ad account timezone', () => {
  // 03:00 UTC on Aug 22 is still Aug 21 in Denver.
  assert.equal(unixToDate(unix('2026-08-22T03:00:00Z'), TZ), '2026-08-21');
  assert.equal(unixToDate(0, TZ), null);
});

test('account normalization surfaces card, status and unbilled balance', () => {
  const a = normalizeAccount({
    id: 'act_1', name: 'Parade of Homes Denver', account_status: 1, currency: 'USD', timezone_name: TZ,
    amount_spent: '1730000', balance: '0', funding_source_details: { display_string: 'Visa ····8324' },
    business: { name: 'HBA Denver' },
  });
  assert.equal(a.status, 'ACTIVE');
  assert.equal(a.payment_method, 'Visa ····8324');
  assert.equal(a.lifetime_spend, 17300);
  assert.equal(a.unbilled_balance, 0);
  assert.equal(a.business, 'HBA Denver');
});

const txs = [
  { id: 't1', time: unix('2026-08-21T13:49:00Z'), amount: { amount: '900.00', currency: 'USD' },
    billing_start_time: unix('2026-08-17T06:00:00Z'), billing_end_time: unix('2026-08-21T13:42:00Z'), status: 'completed' },
  { id: 't2', time: unix('2026-08-23T09:43:00Z'), amount: { amount: '317.50', currency: 'USD' },
    billing_start_time: unix('2026-08-19T06:00:00Z'), billing_end_time: unix('2026-08-22T05:59:00Z'), status: 'completed' },
].map(t => normalizeTransaction(t, TZ));

const daily = normalizeDailySpend([
  { date_start: '2026-08-20', spend: '410.00' },
  { date_start: '2026-08-21', spend: '317.50' },
  { date_start: '2026-08-22', spend: '402.15' },
  { date_start: '2026-08-23', spend: '289.25' },
  { date_start: '2026-08-24', spend: '0' },
]);

test('transactions carry the spend dates they cover', () => {
  assert.equal(txs[1].charged_on, '2026-08-23');
  assert.equal(txs[1].covers_from, '2026-08-19');
  assert.equal(txs[1].covers_to, '2026-08-21');
  assert.equal(txs[1].currency, 'USD');
});

test('zero-spend days are dropped and days sorted', () => {
  assert.deepEqual(daily.map(d => d.date), ['2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23']);
});

test('spend windows find a contiguous run equal to the charge', () => {
  assert.deepEqual(spendWindowsMatching(daily, 691.4, 0.01), [{ from: '2026-08-22', to: '2026-08-23', spend: 691.4 }]);
});

test('unbilled tail: no transaction for the amount, but the post-billing days sum to it', () => {
  const r = analyzeBilling({ account: { payment_method: 'Visa ····8324' }, transactions: txs, daily, amount: 691.4 });
  assert.equal(r.billed_through, '2026-08-21');
  assert.equal(r.spend_after_billed_through, 691.4);
  assert.equal(r.amount_check.matching_transactions.length, 0);
  assert.match(r.amount_check.verdict, /delayed sweep/);
});

test('a charge that exists as a transaction is matched directly', () => {
  const sweep = normalizeTransaction({ id: 't3', time: unix('2026-09-23T15:00:00Z'), amount: { amount: '691.40' } }, TZ);
  const r = analyzeBilling({ account: {}, transactions: [...txs, sweep], daily, amount: 691.4 });
  assert.equal(r.amount_check.matching_transactions[0].id, 't3');
  assert.match(r.amount_check.verdict, /2026-09-23/);
});

test('no match points at other accounts on the same card before fraud', () => {
  const r = analyzeBilling({ account: { payment_method: 'Visa ····8324' }, transactions: txs, daily, amount: 12.34 });
  assert.match(r.amount_check.verdict, /Visa ····8324/);
});
