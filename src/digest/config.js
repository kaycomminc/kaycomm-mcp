/**
 * Morning pacing digest configuration.
 *
 * Budgets, flight dates and budget schedules deliberately do NOT live here.
 * They live in accounts.json, which is what get_full_pacing already reads.
 * Duplicating them here would give the digest a second, silently diverging
 * source of truth for the exact numbers a budget decision rests on.
 *
 * What lives here is only what accounts.json has no opinion about: which
 * accounts appear in the digest, what to call them, and per-account reporting
 * quirks (ecommerce, campaign filters, notes).
 *
 * `name` must match the account name in accounts.json exactly. That is the
 * only key get_full_pacing rows carry — they do not include account ids.
 */

const ACCOUNTS = [
  {
    key: 'eye_associates',
    name: 'Eye Associates of NF',
    label: 'Eye Associates NF',
    platforms: ['google'],
    active: true,
    note: 'Media cap only. The $500 management fee is separate and not part of pacing.',
  },
  {
    key: 'nsw',
    name: 'Nationwide Southwest',
    label: 'Nationwide Southwest',
    platforms: ['google', 'meta'],
    active: true,
  },
  {
    key: 'spartan',
    name: 'Spartan Exteriors',
    label: 'Spartan Exteriors',
    // The deployed accounts.json still tracks a Spartan Meta account
    // (act_866700669704203, budget 1000, currently $0 spent with no enabled
    // daily budgets). The handoff notes said Meta is OFF. Google only here
    // until that is reconciled — the digest flags the omission either way.
    platforms: ['google'],
    active: true,
    note: 'Meta excluded from the digest. Google account 8184463966.',
  },
  {
    key: 'summit',
    name: 'Summit Express',
    label: 'Summit Express',
    platforms: ['google', 'meta'],
    active: true,
    ecommerce: true,
    note: 'Ecommerce. Report conversion value and ROAS alongside spend.',
  },
  {
    key: 'ctsc',
    name: 'Childrens Therapy Services of Colorado',
    label: 'CTSC',
    platforms: ['google'],
    active: true,
    note: '$250/week or $1,000/month Google. No Meta account.',
  },
  {
    key: 'alderwood',
    name: 'Alderwood Psychological',
    label: 'Alderwood Psychological',
    platforms: ['google'],
    active: true,
  },
  {
    key: 'blvd_carroll',
    name: 'Boulevard Carroll',
    label: 'BLVD Carroll',
    platforms: ['google'],
    active: true,
    // The "GEO NC" split is already handled server side: this account has an
    // nc_budget, so get_full_pacing returns a breakdown.nc / breakdown.other
    // block alongside the account total. The digest reports the breakdown.
    note: 'Reported as a total plus the NC / other budget split.',
  },
  {
    key: 'enzoic',
    name: 'Enzoic',
    label: 'Enzoic',
    platforms: ['google'],
    active: true,
  },
  {
    key: 'otb',
    name: 'Outside The Breadbox',
    label: 'Outside The Breadbox',
    platforms: ['google'],
    active: true,
  },
  {
    key: 'woca',
    name: 'Woca Woodcare',
    label: 'Woca Woodcare',
    platforms: ['google'],
    active: true,
  },
  {
    key: 'famu',
    name: 'FAMU Online',
    label: 'FAMU Online',
    platforms: ['meta'],
    active: true,
    flight: true,
    note: 'Meta only. Flight account (2026-07-01 to 2026-09-30), not a monthly budget.',
  },
  {
    key: 'dpoh',
    name: 'Denver Parade of Homes',
    label: 'Denver Parade of Homes',
    platforms: ['google', 'meta'],
    active: true,
    flight: true,
    note:
      'Flight account (2026-07-23 to 2026-08-26), not a monthly budget. ' +
      'Budget and the step schedule live in accounts.json; get_full_pacing ' +
      'returns flight pacing for it directly.',
  },
  // Off. Left here so turning it back on is a one word change.
  {
    key: 'warrior_advocates',
    name: 'Warrior Advocates',
    label: 'Warrior Advocates',
    platforms: ['google', 'meta'],
    active: false,
    note: 'Excluded until told otherwise.',
  },
];

const CONFIG = {
  timezone: 'America/New_York', // matches the server's REPORT_TIMEZONE default
  // Cron expression for when the digest runs. Default 7:00am Eastern, weekdays.
  schedule: '0 7 * * 1-5',
  // get_full_pacing already labels status as OVERPACING / UNDERPACING / ON PACE
  // at +5% / -15% of expected. These thresholds decide what leads the digest.
  thresholds: {
    warnPercent: 10, // more than 10 points off pace is a heads up
    alertPercent: 20, // more than 20 points off pace leads the digest
  },
  accounts: ACCOUNTS.filter((a) => a.active),
  // Platform/account pairs tracked server side but deliberately left out of the
  // digest. Anything get_full_pacing returns that is in neither this list nor
  // ACCOUNTS gets flagged, so a live account never goes silently unreported.
  ignoreUnlisted: [
    'google:Warrior Advocates',
    'meta:Warrior Advocates',
    'meta:Florida DOH Monroe County', // flight ended 2026-06-05, delivered in full
    // Budgeted at $10k but the account has not launched, so $0 spend and no
    // enabled daily budgets are expected. Muted so it does not lead the digest
    // every morning. Move it into ACCOUNTS on the day it goes live.
    'google:Axis Office',
  ],
  // StackAdapt rows come back from get_full_pacing too. All four advertisers
  // are currently uncapped with no spend, so they are out of scope here.
  includeStackAdapt: false,
};

module.exports = { CONFIG, ACCOUNTS };
