/**
 * Morning pacing digest.
 *
 * Flow: pull pacing from kaycomm-mcp, reshape it, hand the computed numbers to
 * Claude for the write up, post to Slack.
 *
 * The math is deliberately not done by the model. It is not done here either:
 * get_full_pacing already computes it from accounts.json, and doing it a second
 * time from a second budget table is how the digest starts disagreeing with the
 * rest of the toolchain. The model writes prose about numbers it is given. It
 * does not calculate them.
 */

const { CONFIG } = require('./config');
const { shapeRow, money, localParts } = require('./pacing');
const { createClient } = require('./mcp-client');
const { deliver } = require('./notify');

const MODEL = process.env.DIGEST_MODEL || 'claude-sonnet-5';

/**
 * get_full_pacing returns:
 *   { date, spend_through, day, days_in_month, google: [row], meta: [row] }
 * Rows are keyed by account NAME (`account`). They carry no account id, which
 * is why config.js matches on the accounts.json name rather than on an id.
 */
function indexPacing(raw) {
  const byPlatform = { google: {}, meta: {} };
  // A whole-platform failure (expired Google refresh token, bad Meta token)
  // comes back as a row with an error and no account name. Without this it
  // vanishes and every account just reads "no data returned", which hides the
  // one thing worth knowing: the platform is down, not the accounts.
  const platformErrors = [];
  for (const platform of ['google', 'meta']) {
    for (const row of raw?.[platform] || []) {
      if (row?.account) byPlatform[platform][row.account] = row;
      else if (row?.error) platformErrors.push({ platform, error: row.error });
    }
  }
  return { byPlatform, platformErrors };
}

/**
 * Platform/account pairs get_full_pacing returned that nobody has decided
 * about yet. Keyed per platform on purpose: an account configured for Google
 * only should still flag its live Meta side rather than dropping it silently.
 */
function unlistedAccounts(byPlatform) {
  const known = new Set(CONFIG.ignoreUnlisted);
  for (const a of CONFIG.accounts) {
    for (const p of a.platforms) known.add(`${p}:${a.name}`);
  }
  const out = [];
  for (const platform of ['google', 'meta']) {
    for (const [name, row] of Object.entries(byPlatform[platform])) {
      if (known.has(`${platform}:${name}`)) continue;
      out.push({
        platform,
        account: name,
        status: row.status ?? null,
        budget: row.budget ?? null,
        spend: row.mtd_spend ?? row.flight_spend ?? null,
        error: row.error ?? null,
      });
    }
  }
  return out;
}

/**
 * Conversions and ROAS are not in get_full_pacing. Ecommerce accounts get one
 * extra call. Note this range is month to date INCLUDING today, while pacing
 * spend stops at yesterday, so the two spend figures will not match.
 */
async function gatherEcommerce(client, acct) {
  try {
    const perf = await client.callToolWithRetry('get_campaign_performance', {
      account_name: acct.name,
      platform: 'both',
      date_range: 'THIS_MONTH',
    });

    const totals = {};
    for (const platform of ['google', 'meta']) {
      const campaigns = perf?.[platform]?.campaigns;
      if (!Array.isArray(campaigns)) {
        const err = perf?.[`${platform}_error`];
        if (err) totals[platform] = { error: err };
        continue;
      }
      let spend = 0;
      let conversions = 0;
      let convValue = 0;
      for (const c of campaigns) {
        spend += Number(c.spend || 0);
        conversions += Number(c.conversions || 0);
        convValue += Number(c.conv_value || 0);
      }
      totals[platform] = {
        note: 'month to date including today, unlike pacing spend',
        spend: Math.round(spend * 100) / 100,
        conversions: Math.round(conversions * 10) / 10,
        conversionValue: Math.round(convValue * 100) / 100,
        roas: spend > 0 && convValue > 0
          ? Math.round((convValue / spend) * 100) / 100
          : null,
      };
    }
    return totals;
  } catch (err) {
    return { error: err.message };
  }
}

async function gatherAccounts(client) {
  const raw = await client.callToolWithRetry('get_full_pacing', {});
  const { byPlatform, platformErrors } = indexPacing(raw);
  const results = [];

  for (const acct of CONFIG.accounts) {
    const entry = {
      label: acct.label,
      account: acct.name,
      note: acct.note || null,
      flight: !!acct.flight,
      platforms: [],
    };

    for (const platform of acct.platforms) {
      const row = byPlatform[platform][acct.name];
      const shaped = shapeRow(row, platform === 'google' ? 'Google' : 'Meta', CONFIG.thresholds);
      if (!row) shaped.missing = true;
      entry.platforms.push(shaped);
    }

    if (acct.ecommerce) entry.performance = await gatherEcommerce(client, acct);

    results.push(entry);
  }

  return {
    date: raw?.date ?? localParts().iso,
    spendThrough: raw?.spend_through ?? null,
    day: raw?.day ?? null,
    daysInMonth: raw?.days_in_month ?? null,
    accounts: results,
    platformErrors,
    unlisted: unlistedAccounts(byPlatform),
  };
}

/**
 * Subject line. Counted here rather than asked of the model: the subject is
 * the part you read on a phone without opening anything, so it should not be
 * the one number in the pipeline that nobody checked.
 */
function buildSubject(data) {
  let needsAction = 0;
  let broken = 0;

  for (const a of data.accounts) {
    for (const p of a.platforms) {
      if (p.missing || p.error) broken++;
      else if (p.status === 'alert' || p.status === 'warn' || p.exhausted) needsAction++;
    }
  }

  const parts = [`Pacing digest ${data.date}`];
  if (data.platformErrors?.length) {
    parts.push(`${data.platformErrors.map((e) => e.platform).join(' + ')} data unavailable`);
  } else if (needsAction) {
    parts.push(`${needsAction} need${needsAction === 1 ? 's' : ''} attention`);
  } else {
    parts.push('all on pace');
  }
  if (broken) parts.push(`${broken} no data`);

  // Comma separated, not em dashed, to match the digest's own style rule.
  return parts.join(', ');
}

function buildPrompt(data) {
  return `You are writing Jason's morning pacing digest for ${data.date}. Jason runs KayComm, a solo paid media practice.

Below is computed pacing data. Every number is already calculated. Report the numbers exactly as given. Do not recalculate anything, do not estimate, and do not invent figures that are not present.

Reading the data:
- Spend figures are month to date through ${data.spendThrough || 'yesterday'}, not through today. Today is day ${data.day} of ${data.daysInMonth}.
- "variancePercent" is points off pace. Positive means overspending, negative means underspending.
- "recommendedDaily" is the per day spend needed to land exactly on budget across the remaining days. "currentDaily" is what the daily budgets add up to now.
- "capped": false means the account has no budget set, so it is report only.
- Accounts with a "flight" value run on a fixed flight window, not a calendar month. Their spend is flight to date.
- Anything under "performance" is a separate pull that DOES include today, so its spend will not match the pacing spend. Do not present them as the same number.

DATA:
${JSON.stringify(data, null, 2)}

Write the digest with these rules:
- Open with a single line saying how many accounts need action today and how many are fine.
- Then a "Needs attention" section listing only accounts with status "alert" or "warn", or where "exhausted" is true. For each: the account, platform, spend, budget, how far off pace, and the recommended daily budget. If a recommendation string is present, use it.
- Then a "Denver Parade of Homes" section. This runs on a fixed flight window, not a monthly budget, and its budget steps up on a schedule. Give flight to date spend against the flight budget and the recommended daily for the days remaining.
- Then a one line "Everything else on pace" roll up naming the remaining accounts with no detail.
- If any platform has an "error" or "missing" field, say plainly that the data did not come back for it. Never fill a gap with a guess.
- If "platformErrors" is not empty, lead with it: that whole platform failed to report, so its accounts are unknown rather than at zero. Do not describe those accounts as underpacing.
- Accounts with "capped": false are report only. Mention their run rate but do not describe them as off pace.
- For Summit Express, include ROAS since it is ecommerce.
- If "unlisted" is not empty, add a final line naming those accounts as tracked in accounts.json but not configured in the digest.

Style: direct, concise, no preamble, no sign off. This is delivered as a plain text email, so write plain text: no markdown, no asterisks for bold, no bullet characters other than a leading "- ". Section headings on their own line. Never use em dashes. Use commas, periods, or parentheses instead. Currency to the dollar is fine, drop the cents.`;
}

async function writeDigest(data) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: buildPrompt(data) }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Plain text fallback if the model call fails. The digest still ships. */
function fallbackDigest(data) {
  const lines = [
    `Pacing digest ${data.date} (fallback, model call failed)`,
    `Spend through ${data.spendThrough || 'unknown'}`,
    '',
  ];

  for (const pe of data.platformErrors || []) {
    lines.push(`${pe.platform.toUpperCase()} DATA UNAVAILABLE: ${pe.error}`);
  }
  if (data.platformErrors?.length) lines.push('');

  for (const a of data.accounts) {
    for (const p of a.platforms) {
      if (p.missing) {
        lines.push(`${a.label} ${p.platform}: no data returned`);
        continue;
      }
      if (p.error) {
        lines.push(`${a.label} ${p.platform}: data unavailable (${p.error})`);
        continue;
      }
      if (!p.capped) {
        lines.push(`${a.label} ${p.platform}: ${money(p.spend)} spent, no budget set (report only)`);
        continue;
      }
      const flag = p.status === 'ok' ? '' : ` [${p.status.toUpperCase()}]`;
      const off =
        p.variancePercent == null
          ? 'variance n/a'
          : `${p.variancePercent >= 0 ? '+' : ''}${p.variancePercent.toFixed(0)}% vs pace`;
      lines.push(
        `${a.label} ${p.platform}: ${money(p.spend)} of ${money(p.budget)}, ${off}, ` +
          `recommended daily ${money(p.recommendedDaily)}${flag}`
      );
      if (p.breakdown) {
        for (const [k, b] of Object.entries(p.breakdown)) {
          lines.push(
            `  ${k}: ${money(b.spend)} of ${money(b.budget)}, ` +
              `recommended daily ${money(b.recommendedDaily)}`
          );
        }
      }
    }

    // Ecommerce accounts carry a separate performance pull. Spend here includes
    // today, so it is labelled rather than shown next to the pacing spend.
    if (a.performance && !a.performance.error) {
      for (const [platform, t] of Object.entries(a.performance)) {
        if (!t || t.error) continue;
        lines.push(
          `  ${a.label} ${platform} MTD incl today: ${money(t.spend)}, ` +
            `${t.conversions} conv, ${money(t.conversionValue)} value, ` +
            `ROAS ${t.roas == null ? 'n/a' : t.roas.toFixed(2)}`
        );
      }
    }
  }

  if (data.unlisted.length) {
    lines.push(
      '',
      `Not configured in the digest: ${data.unlisted
        .map((u) => `${u.account} (${u.platform})`)
        .join(', ')}`
    );
  }

  return lines.join('\n');
}

async function runDigest({ resolve = null, dryRun = false } = {}) {
  const client = createClient({ resolve });
  const data = await gatherAccounts(client);

  let text;
  try {
    text = await writeDigest(data);
  } catch (err) {
    console.error('Digest write failed, using fallback:', err.message);
    text = fallbackDigest(data);
  }

  const subject = buildSubject(data);

  if (dryRun) {
    console.log(`Subject: ${subject}\n`);
    console.log(text);
    return { text, subject, data };
  }

  const delivery = await deliver(text, { subject });
  // Every configured channel failing is a failed run; the cron logs it and the
  // manual trigger route surfaces it. One of several failing is not.
  if (!delivery.skipped && !delivery.delivered.length) {
    throw new Error(
      `Digest built but delivery failed: ${delivery.failed
        .map((f) => `${f.channel} (${f.error})`)
        .join(', ')}`
    );
  }

  return { text, subject, data, delivery };
}

module.exports = {
  runDigest,
  gatherAccounts,
  indexPacing,
  fallbackDigest,
  buildPrompt,
  buildSubject,
};

// Allow running by hand: node src/digest/digest.js --dry-run
if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = { dryRun: args.includes('--dry-run') };

  // In process by default when run from inside the repo: skip the HTTP hop and
  // the MCP auth token entirely by calling the server's handler directly.
  if (!args.includes('--http')) {
    process.env.MCP_TEST = process.env.MCP_TEST || '1';
    const { handleToolCall } = require('../../server');
    opts.resolve = (name) => (toolArgs) => handleToolCall(name, toolArgs);
  }

  runDigest(opts).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
