'use strict';

// Pure helpers for get_meta_billing: turn Meta's account, transaction and daily
// spend payloads into "what was charged, for which dates, and does a mystery
// card charge line up with any of it". No network access here; server.js does
// the fetching so these stay testable.
//
// Why the "unbilled tail" matters: Meta charges at a billing threshold, then
// sweeps whatever is left on the account's monthly bill date. Spend from the
// last day or two of a flight can therefore hit the card weeks after the ads
// stopped, and the receipt goes only to whoever is on the billing notices.

const ACCOUNT_FIELDS = 'id,name,account_status,disable_reason,currency,timezone_name,amount_spent,balance,' +
  'spend_cap,funding_source_details,business{id,name}';

const TRANSACTION_FIELDS = 'id,time,amount,status,charge_type,billing_reason,billing_start_time,billing_end_time,' +
  'payment_option,product_type';

const ACCOUNT_STATUS = { 1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED', 7: 'PENDING_RISK_REVIEW', 8: 'PENDING_SETTLEMENT',
  9: 'IN_GRACE_PERIOD', 100: 'PENDING_CLOSURE', 101: 'CLOSED', 201: 'ANY_ACTIVE', 202: 'ANY_CLOSED' };

const round2 = n => Math.round(n * 100) / 100;

// Account-level money fields (amount_spent, balance, spend_cap) come back as
// strings in the currency's minor unit.
function minorToMajor(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? round2(n / 100) : null;
}

// Transaction amounts have shipped both as a CurrencyAmount object and as a
// bare major-unit string depending on API version.
function transactionAmount(amount) {
  if (amount === undefined || amount === null) return null;
  if (typeof amount === 'object') {
    if (amount.amount_in_hundredths !== undefined) return round2(Number(amount.amount_in_hundredths) / 100);
    if (amount.amount !== undefined) return round2(Number(amount.amount));
    return null;
  }
  const n = Number(amount);
  return Number.isFinite(n) ? round2(n) : null;
}

// Unix seconds -> YYYY-MM-DD in the ad account's own timezone, which is the
// timezone Meta uses for its billing periods and for insights dates.
function unixToDate(seconds, timeZone) {
  if (seconds === undefined || seconds === null || seconds === '') return null;
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(n * 1000));
  } catch (_) {
    return new Date(n * 1000).toISOString().slice(0, 10);
  }
}

function dateToUnix(date) { return Math.floor(Date.parse(date + 'T00:00:00Z') / 1000); }

function normalizeAccount(raw = {}) {
  return {
    id: raw.id,
    name: raw.name,
    status: ACCOUNT_STATUS[raw.account_status] || (raw.account_status !== undefined ? String(raw.account_status) : null),
    disable_reason: raw.disable_reason || null,
    business: raw.business?.name || null,
    currency: raw.currency || null,
    timezone: raw.timezone_name || null,
    payment_method: raw.funding_source_details?.display_string || null,
    lifetime_spend: minorToMajor(raw.amount_spent),
    unbilled_balance: minorToMajor(raw.balance),
    spend_cap: minorToMajor(raw.spend_cap) || null,
  };
}

function normalizeTransaction(tx, timeZone) {
  const amount = typeof tx.amount === 'object' && tx.amount ? tx.amount : null;
  return {
    id: tx.id,
    charged_on: unixToDate(tx.time, timeZone),
    amount: transactionAmount(tx.amount),
    currency: amount?.currency || null,
    status: tx.status || null,
    charge_type: tx.charge_type || null,
    billing_reason: tx.billing_reason || null,
    payment_option: tx.payment_option || null,
    covers_from: unixToDate(tx.billing_start_time, timeZone),
    covers_to: unixToDate(tx.billing_end_time, timeZone),
  };
}

// dailyRows: insights rows with time_increment=1 ({date_start, spend}).
function normalizeDailySpend(dailyRows = []) {
  return dailyRows
    .map(r => ({ date: r.date_start, spend: round2(parseFloat(r.spend || 0)) }))
    .filter(r => r.spend > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Contiguous runs of spend days whose total is within `tolerance` of amount.
// Used when no transaction matches: a sweep charge usually equals the spend
// between the last billed day and the day the ads stopped.
function spendWindowsMatching(daily, amount, tolerance) {
  const out = [];
  for (let i = 0; i < daily.length; i++) {
    let sum = 0;
    for (let j = i; j < daily.length; j++) {
      sum = round2(sum + daily[j].spend);
      if (Math.abs(sum - amount) <= tolerance) out.push({ from: daily[i].date, to: daily[j].date, spend: sum });
      if (sum > amount + tolerance) break;
    }
  }
  return out;
}

function analyzeBilling({ account, transactions = [], daily = [], amount, tolerance = 0.01 }) {
  const txs = transactions.slice().sort((a, b) => (a.charged_on || '').localeCompare(b.charged_on || ''));
  const totalSpend = round2(daily.reduce((s, d) => s + d.spend, 0));
  const totalCharged = round2(txs.reduce((s, t) => s + (t.amount || 0), 0));

  const billedThrough = txs.map(t => t.covers_to).filter(Boolean).sort().pop() || null;
  const lastSpendDate = daily.length ? daily[daily.length - 1].date : null;
  const spendAfterBilled = billedThrough
    ? round2(daily.filter(d => d.date > billedThrough).reduce((s, d) => s + d.spend, 0))
    : null;

  const analysis = {
    total_spend_in_range: totalSpend,
    total_charged_in_range: totalCharged,
    last_spend_date: lastSpendDate,
    billed_through: billedThrough,
    spend_after_billed_through: spendAfterBilled,
  };

  if (amount !== undefined && amount !== null) {
    const matches = txs.filter(t => t.amount !== null && Math.abs(t.amount - amount) <= tolerance);
    const windows = spendWindowsMatching(daily, amount, tolerance);
    let verdict;
    if (matches.length) {
      verdict = `Matches ${matches.length} Meta charge(s) on this account (${matches.map(m => m.charged_on).join(', ')}).`;
    } else if (windows.length) {
      verdict = `No transaction returned for $${amount}, but spend on ${windows.map(w => `${w.from}..${w.to}`).join(', ')} totals exactly that — likely a delayed sweep of unbilled spend.`;
    } else if (spendAfterBilled !== null && Math.abs(spendAfterBilled - amount) <= Math.max(tolerance, 1)) {
      verdict = `Spend after the last billed day (${billedThrough}) is $${spendAfterBilled}, consistent with a delayed sweep of the unbilled tail.`;
    } else {
      verdict = `No charge or spend window on this account equals $${amount} in the requested range. Check other ad accounts on the same card (${account?.payment_method || 'card unknown'}) before treating it as fraud.`;
    }
    analysis.amount_check = { amount, tolerance, matching_transactions: matches, matching_spend_windows: windows, verdict };
  }
  return analysis;
}

module.exports = {
  ACCOUNT_FIELDS, TRANSACTION_FIELDS,
  minorToMajor, transactionAmount, unixToDate, dateToUnix,
  normalizeAccount, normalizeTransaction, normalizeDailySpend, spendWindowsMatching, analyzeBilling,
};
