/**
 * Pacing shaping. No network calls in here, which makes it easy to unit test.
 *
 * The arithmetic itself is NOT done here. get_full_pacing already computes
 * budget (schedule-aware), expected-vs-actual, remaining, projected month end,
 * and the per-day spend needed to land on budget — against spend through
 * yesterday, using the same timezone. Recomputing those numbers locally from a
 * second budget table is how the digest and the MCP end up disagreeing about
 * what a client's budget is.
 *
 * So this file's job is to reshape those numbers into one flat shape the
 * prompt and the fallback can both read, and to decide what counts as loud
 * enough to lead the digest.
 */

const TZ = 'America/New_York';

/** Returns { year, month, day, weekday, iso } for "now" in the given timezone. */
function localParts(date = new Date(), timeZone = TZ) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: parts.weekday,
    iso: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/**
 * How far off pace, in points. get_full_pacing gives pct_expected where 100 is
 * exactly on pace, so 118 means 18 points hot. Positive is overspending.
 */
function varianceFrom(pctExpected) {
  return pctExpected == null ? null : pctExpected - 100;
}

function statusFor(variancePercent, thresholds) {
  if (variancePercent == null) return 'unknown';
  const v = Math.abs(variancePercent);
  if (v >= thresholds.alertPercent) return 'alert';
  if (v >= thresholds.warnPercent) return 'warn';
  return 'ok';
}

/**
 * Flatten one get_full_pacing row (monthly or flight) into the digest shape.
 * Every number here comes straight off the row. Nothing is recalculated.
 */
function shapeRow(row, platform, thresholds) {
  if (!row) return { platform, missing: true };
  if (row.error) return { platform, error: row.error };

  const isFlight = row.flight_spend != null || row.flight != null;
  const spend = isFlight ? row.flight_spend : row.mtd_spend;
  const daily = row.daily_budget || null;

  // status "no_cap" means accounts.json has no budget for this account, so
  // there is nothing to pace against. Report the run rate, not a variance.
  if (row.status === 'no_cap' || !row.budget) {
    return {
      platform,
      capped: false,
      spend,
      spendKind: isFlight ? 'flight' : 'mtd',
      projected: row.projected_month_end ?? row.projected_flight_end ?? null,
      mcpStatus: row.status,
      status: 'ok',
    };
  }

  const variancePercent = varianceFrom(row.pct_expected);

  // Accounts with an nc_budget (Boulevard Carroll) come back with the total
  // plus an NC / other split. Carry the split through rather than flattening it.
  const breakdown = row.breakdown
    ? Object.fromEntries(
        Object.entries(row.breakdown).map(([k, b]) => [
          k,
          {
            budget: b.budget,
            spend: b.spend,
            pctExpected: b.pct_expected ?? null,
            variancePercent: varianceFrom(b.pct_expected),
            remaining: b.remaining ?? null,
            recommendedDaily: b.daily_budget?.needed_per_day ?? null,
            currentDaily: b.daily_budget?.current_daily_budget ?? null,
            recommendation: b.daily_budget?.recommendation ?? null,
            status: statusFor(varianceFrom(b.pct_expected), thresholds),
          },
        ])
      )
    : null;

  return {
    platform,
    breakdown,
    capped: true,
    flight: isFlight ? row.flight : null,
    budget: row.budget,
    spend,
    spendKind: isFlight ? 'flight' : 'mtd',
    pctBudget: row.pct_budget ?? null,
    pctExpected: row.pct_expected ?? null,
    variancePercent,
    remaining: row.remaining ?? null,
    daysRemaining: row.days_remaining ?? daily?.days_remaining ?? null,
    recommendedDaily: daily?.needed_per_day ?? null,
    currentDaily: daily?.current_daily_budget ?? null,
    recommendation: daily?.recommendation ?? null,
    dailyBudgetNote: daily?.note ?? null,
    projected: row.projected_month_end ?? row.projected_flight_end ?? null,
    exhausted: row.remaining != null && row.remaining <= 0,
    mcpStatus: row.status,
    status: statusFor(variancePercent, thresholds),
  };
}

const money = (n) =>
  n == null
    ? 'n/a'
    : `$${Number(n).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;

module.exports = { localParts, varianceFrom, statusFor, shapeRow, money };
