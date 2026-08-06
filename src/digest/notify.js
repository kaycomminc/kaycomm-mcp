/**
 * Digest delivery.
 *
 * Channels are chosen by whichever env vars are set, so adding or dropping one
 * is configuration rather than code:
 *
 *   GMAIL_USER + GMAIL_APP_PASSWORD    → email (primary)
 *   SLACK_WEBHOOK_URL                  → Slack incoming webhook
 *
 * Email goes out over Gmail SMTP as the mailbox owner rather than through a
 * sending service. kaycomminc.com is on Google Workspace and its SPF record
 * already includes _spf.google.com, so mail sent this way authenticates with
 * no DNS changes and no domain verification step.
 *
 * If none are configured the digest logs to stdout instead of throwing, so a
 * misconfigured channel never silently kills the job. If several are
 * configured they all get a copy, which is what makes a cutover safe: run
 * email and Slack together for a week, then delete the webhook variable.
 *
 * One channel failing does not stop the others. The caller gets a per channel
 * report and decides what counts as a failed run.
 */

const nodemailer = require('nodemailer');

/** Slack's section block caps out around 3000 characters. */
const SLACK_LIMIT = 2900;

let transporter = null;

function getTransporter(user, pass) {
  // Reused across runs. The digest is one message a day, but the cron keeps
  // this process alive for weeks, and rebuilding the pool per send is waste.
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });
  }
  return transporter;
}

async function sendEmail(text, subject, {
  user = process.env.GMAIL_USER,
  // App password, not the account password. Google only issues these to
  // accounts with 2-Step Verification on.
  pass = process.env.GMAIL_APP_PASSWORD,
  to = process.env.DIGEST_EMAIL_TO || process.env.GMAIL_USER,
} = {}) {
  const info = await getTransporter(user, pass).sendMail({
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

  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    channels.push({ name: 'email', send: () => sendEmail(text, subject) });
  }
  if (process.env.SLACK_WEBHOOK_URL) {
    channels.push({ name: 'slack', send: () => postToSlack(text) });
  }

  if (!channels.length) {
    console.log(
      '[digest] No delivery channel configured ' +
        '(set GMAIL_USER + GMAIL_APP_PASSWORD, or SLACK_WEBHOOK_URL). Output:\n' +
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

module.exports = { deliver, sendEmail, postToSlack };
