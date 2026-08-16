/**
 * Digest delivery.
 *
 * Channels are chosen by whichever env vars are set, so adding or dropping one
 * is configuration rather than code:
 *
 *   RESEND_API_KEY                     → email over HTTPS (primary)
 *   GMAIL_USER + GMAIL_APP_PASSWORD    → email over SMTP (see caveat below)
 *   SLACK_WEBHOOK_URL                  → Slack incoming webhook
 *
 * Resend is the primary email path because it posts to port 443. Railway
 * blocks outbound SMTP: 465 and 587 both time out from the container over a
 * working IPv4 route, which is the usual anti-spam egress policy on cloud
 * hosts. The SMTP path is kept because it works fine anywhere that doesn't
 * block it (a local run, a VPS, a different platform) and costs nothing to
 * retain — but it will not deliver from Railway.
 *
 * If both are configured, Resend wins and SMTP is skipped, so leaving the
 * GMAIL_* variables in place does no harm.
 *
 * If none are configured the digest logs to stdout instead of throwing, so a
 * misconfigured channel never silently kills the job. If several are
 * configured they all get a copy, which is what makes a cutover safe: run
 * email and Slack together for a week, then delete the webhook variable.
 *
 * One channel failing does not stop the others. The caller gets a per channel
 * report and decides what counts as a failed run.
 */

const net = require('net');
const dns = require('dns').promises;
const nodemailer = require('nodemailer');

/** Slack's section block caps out around 3000 characters. */
const SLACK_LIMIT = 2900;

/**
 * Resolve to an IPv4 address.
 *
 * Nodemailer resolves hostnames itself rather than leaving it to net.connect:
 * it queries A and AAAA separately, concatenates IPv4-then-IPv6, and dials the
 * first — and it skips a family outright when os.networkInterfaces() shows no
 * matching interface. On Railway that yields an IPv6-only list, so it dialled
 * 2607:f8b0::…:587 and the container has no IPv6 route (ENETUNREACH).
 *
 * Passing an IP as `host` makes nodemailer skip its resolver entirely
 * (shared/index.js — `net.isIP(options.host)` short circuit), so this pins the
 * connection to IPv4. TLS still verifies against the real hostname via
 * `tls.servername`, so certificate validation is unaffected.
 *
 * Falls back to the hostname if the A lookup fails — better to let nodemailer
 * try than to fail the send outright on a DNS blip.
 */
async function resolveIPv4(hostname) {
  if (net.isIP(hostname)) return hostname;
  try {
    const [address] = await dns.resolve4(hostname);
    return address || hostname;
  } catch {
    return hostname;
  }
}

/**
 * Built per send rather than cached. The digest is one message a day, so a
 * connection pool buys nothing, and a cached transporter would pin a Gmail IP
 * that rotates underneath it.
 */
async function createTransporter(user, pass) {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 587);

  return nodemailer.createTransport({
    host: await resolveIPv4(host),
    port,
    secure: port === 465, // 465 is implicit TLS; 587 upgrades via STARTTLS
    auth: { user, pass },
    tls: { servername: host }, // cert is checked against the name, not the IP
    // Fail fast. Without these, an unreachable route hangs until the platform
    // default gives up, stalling the whole digest run behind it.
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
}

/**
 * Email over HTTPS. Works anywhere outbound 443 works, which is everywhere.
 *
 * DIGEST_EMAIL_FROM must be an address Resend will send as: either
 * onboarding@resend.dev (allowed with no setup, but only to the address that
 * owns the Resend account) or an address at a domain verified in Resend.
 */
async function sendEmailHttp(text, subject, {
  apiKey = process.env.RESEND_API_KEY,
  to = process.env.DIGEST_EMAIL_TO || process.env.GMAIL_USER,
  from = process.env.DIGEST_EMAIL_FROM || 'onboarding@resend.dev',
} = {}) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: String(to).split(',').map((a) => a.trim()).filter(Boolean),
      subject,
      text,
    }),
  });

  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }
  const body = await res.json().catch(() => ({}));
  return { id: body.id ?? null };
}

async function sendEmail(text, subject, {
  user = process.env.GMAIL_USER,
  // App password, not the account password. Google only issues these to
  // accounts with 2-Step Verification on.
  pass = process.env.GMAIL_APP_PASSWORD,
  to = process.env.DIGEST_EMAIL_TO || process.env.GMAIL_USER,
} = {}) {
  const transporter = await createTransporter(user, pass);
  const info = await transporter.sendMail({
    from: user,
    // Comma separated DIGEST_EMAIL_TO is fine; nodemailer accepts the string.
    to,
    subject,
    // Plain text on purpose. The digest is prose with short sections, and
    // plain text renders the same everywhere with no HTML to maintain.
    text,
  });
  return { messageId: info.messageId ?? null };
}

async function postToSlack(text, { webhook = process.env.SLACK_WEBHOOK_URL } = {}) {
  const truncated = text.length > SLACK_LIMIT;
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'Morning pacing digest',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: truncated
              ? text.slice(0, SLACK_LIMIT - 20) + '\n... (truncated)'
              : text,
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Slack ${res.status}: ${await res.text()}`);
  }
  return { truncated };
}

/**
 * Send the digest to every configured channel.
 * Returns { delivered: [...], failed: [...], skipped: bool }.
 */
async function deliver(text, { subject = 'Morning pacing digest' } = {}) {
  const channels = [];

  // Resend first: if it is configured, the SMTP path is skipped rather than
  // duplicated, so a leftover GMAIL_* pair can't send you a second copy.
  if (process.env.RESEND_API_KEY) {
    channels.push({ name: 'email', send: () => sendEmailHttp(text, subject) });
  } else if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    channels.push({ name: 'email-smtp', send: () => sendEmail(text, subject) });
  }
  if (process.env.SLACK_WEBHOOK_URL) {
    channels.push({ name: 'slack', send: () => postToSlack(text) });
  }

  if (!channels.length) {
    console.log(
      '[digest] No delivery channel configured ' +
        '(set RESEND_API_KEY, or GMAIL_USER + GMAIL_APP_PASSWORD, or SLACK_WEBHOOK_URL). Output:\n' +
        text
    );
    return { delivered: [], failed: [], skipped: true };
  }

  const results = await Promise.allSettled(channels.map((c) => c.send()));
  const delivered = [];
  const failed = [];

  results.forEach((r, i) => {
    const name = channels[i].name;
    if (r.status === 'fulfilled') {
      delivered.push({ channel: name, ...r.value });
    } else {
      failed.push({ channel: name, error: r.reason?.message || String(r.reason) });
      console.error(`[digest] ${name} delivery failed:`, r.reason?.message);
    }
  });

  return { delivered, failed, skipped: false };
}

module.exports = { deliver, sendEmailHttp, sendEmail, postToSlack };
