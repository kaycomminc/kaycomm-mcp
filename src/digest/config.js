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

const fs = require('fs');

// Build ACCOUNTS from accounts.json at require time
function buildAccountsFromConfig() {
    const accountsData = JSON.parse(fs.readFileSync(`${__dirname}/../../accounts.json`, 'utf8'));
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Per-account overrides beyond name/platforms/flight
    const OVERRIDES = {
        'Summit Express': {
            ecommerce: true,
            note: 'Ecommerce. Report conversion value and ROAS alongside spend.',
        },
        'Eye Associates of NF': {
            note: 'Media cap only. The $500 management fee is separate and not part of pacing.',
        },
        'Childrens Therapy Services of Colorado': {
            label: 'CTSC',
            note: '$250/week or $1,000/month Google. No Meta account.',
        },
        'Boulevard Carroll': {
            label: 'BLVD Carroll',
            note: 'Reported as a total plus the NC / other budget split.',
        },
    };

    // Collect all unique account names and their platforms
    const accountsByName = {};
    for (const [platform, accounts] of Object.entries(accountsData).filter(([k]) => k === 'google' || k === 'meta')) {
        for (const [, info] of Object.entries(accounts || {})) {
            if (!accountsByName[info.name]) {
                accountsByName[info.name] = { platforms: new Set(), flight_start: info.flight_start, flight_end: info.flight_end, inactive: true };
            }
            if (!info.inactive) accountsByName[info.name].inactive = false;
            accountsByName[info.name].platforms.add(platform);
        }
    }

    // Build account entries, excluding inactive accounts (inactive on every platform) and expired flights
    const accounts = [];
    for (const [name, data] of Object.entries(accountsByName)) {
        if (data.inactive) continue;
        if (data.flight_end && data.flight_end < today) continue;  // Exclude expired flights

        const entry = {
            name,
            label: name,
            platforms: Array.from(data.platforms).sort(),
            flight: !!(data.flight_start && data.flight_end),
        };

        // Apply overrides
        if (OVERRIDES[name]) {
            Object.assign(entry, OVERRIDES[name]);
        }

        accounts.push(entry);
    }

    return accounts;
}

const ACCOUNTS = buildAccountsFromConfig();

const CONFIG = {
  timezone: 'America/New_York', // matches the server's REPORT_TIMEZONE default
  // Cron expression for when the digest runs. Default 7:00am Eastern, weekdays.
  schedule: '0 7 * * 1-5',
  // get_full_pacing already labels status as OVERPACING / UNDERPACING / ON PACE
  // at ±5% (per-account override via health.pacing_tolerance_pct) of expected.
  // These thresholds decide what leads the digest.
  thresholds: {
    warnPercent: 10, // more than 10 points off pace is a heads up
    alertPercent: 20, // more than 20 points off pace leads the digest
  },
  accounts: ACCOUNTS,
  // Platform/account pairs tracked server side but deliberately left out of the
  // digest. Anything get_full_pacing returns that is in neither this list nor
  // ACCOUNTS gets flagged, so a live account never goes silently unreported.
  ignoreUnlisted: [
    'google:Warrior Advocates',
    'meta:Warrior Advocates',
    'google:Axis Office',
  ],
  // StackAdapt rows come back from get_full_pacing too. All four advertisers
  // are currently uncapped with no spend, so they are out of scope here.
  includeStackAdapt: false,
};

module.exports = { CONFIG, ACCOUNTS };
