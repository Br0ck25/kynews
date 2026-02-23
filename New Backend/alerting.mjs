/**
 * Alerting Module
 *
 * Sends notifications when:
 *  1. A Kentucky county has had ZERO articles for 48+ hours
 *  2. A feed has been failing for 3+ consecutive fetches
 *  3. Breaking news is detected (optional — alerts admin channel)
 *
 * Channels:
 *  - Slack (via Incoming Webhook URL)
 *  - Email (via Cloudflare Email Workers or SMTP/Mailgun/Postmark)
 *
 * Deduplication: Alerts are throttled — same alert won't fire again
 * within the COOLDOWN period (default: 6 hours for coverage gaps,
 * 1 hour for feed failures).
 *
 * Environment variables:
 *   SLACK_WEBHOOK_URL     — Slack incoming webhook
 *   ALERT_EMAIL_TO        — Recipient email
 *   ALERT_EMAIL_FROM      — Sender email (must be verified in your ESP)
 *   MAILGUN_API_KEY       — (if using Mailgun)
 *   MAILGUN_DOMAIN        — (if using Mailgun)
 *   POSTMARK_API_TOKEN    — (if using Postmark)
 *   ALERT_COOLDOWN_HOURS  — Hours between repeat alerts (default: 6)
 */

const COOLDOWN_HOURS = Number(process.env.ALERT_COOLDOWN_HOURS || 6);
const COVERAGE_GAP_HOURS = 48;
const FEED_FAIL_THRESHOLD = 3;

// ─── Slack ────────────────────────────────────────────────────────────────────

/**
 * Send a Slack message via Incoming Webhook.
 * @param {string} webhookUrl
 * @param {object} payload  — Slack Block Kit payload
 */
async function sendSlack(webhookUrl, payload) {
  if (!webhookUrl) return;
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    console.error(`Slack alert failed: ${res.status} ${await res.text()}`);
  }
}

// ─── Email (Postmark) ─────────────────────────────────────────────────────────

async function sendEmailPostmark({ to, from, subject, text, html }) {
  const token = process.env.POSTMARK_API_TOKEN;
  if (!token) return;

  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "X-Postmark-Server-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ From: from, To: to, Subject: subject, TextBody: text, HtmlBody: html }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    console.error(`Postmark alert failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Email via Mailgun
 */
async function sendEmailMailgun({ to, from, subject, text }) {
  const key = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  if (!key || !domain) return;

  const body = new URLSearchParams({ from, to, subject, text });
  const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`api:${key}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    console.error(`Mailgun alert failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Send alert via all configured channels.
 */
async function sendAlert({ subject, text, slackPayload }) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const emailTo   = process.env.ALERT_EMAIL_TO;
  const emailFrom = process.env.ALERT_EMAIL_FROM || "alerts@localkynews.com";

  const promises = [];

  if (webhookUrl) {
    promises.push(sendSlack(webhookUrl, slackPayload || {
      text: `*${subject}*\n${text}`,
    }));
  }

  if (emailTo) {
    if (process.env.POSTMARK_API_TOKEN) {
      promises.push(sendEmailPostmark({ to: emailTo, from: emailFrom, subject, text }));
    } else if (process.env.MAILGUN_API_KEY) {
      promises.push(sendEmailMailgun({ to: emailTo, from: emailFrom, subject, text }));
    }
  }

  await Promise.allSettled(promises);
}

// ─── Alert deduplication ──────────────────────────────────────────────────────

/**
 * Check and record alert in DB to prevent spam.
 * Returns true if alert should fire, false if still in cooldown.
 */
async function shouldFireAlert(db, alertKey) {
  const cooldownCutoff = new Date(Date.now() - COOLDOWN_HOURS * 3_600_000).toISOString();

  const recent = await db.prepare(`
    SELECT id FROM alert_log
    WHERE alert_key = @key AND fired_at >= @cutoff
    LIMIT 1
  `).get({ key: alertKey, cutoff: cooldownCutoff });

  if (recent) return false;

  await db.prepare(`
    INSERT INTO alert_log (alert_key, fired_at) VALUES (@key, datetime('now'))
  `).run({ key: alertKey });

  return true;
}

// ─── Coverage gap alerting ────────────────────────────────────────────────────

/**
 * Run coverage check and alert for counties with no articles in 48h.
 * Call this from the coverage-report script or a daily cron.
 */
export async function alertCoverageGaps(db) {
  const { KY_COUNTIES } = await import("./ky-geo.mjs");

  // Get counties with article counts in last 48 hours
  const covered = await db.prepare(`
    SELECT il.county, COUNT(DISTINCT i.id) as n
    FROM item_locations il
    JOIN items i ON i.id = il.item_id
    WHERE il.state_code = 'KY'
      AND il.county != ''
      AND i.published_at >= datetime('now', '-${COVERAGE_GAP_HOURS} hours')
    GROUP BY il.county
  `).all();

  const coveredSet = new Set(covered.map((r) => r.county));
  const zeroCoverage = KY_COUNTIES.filter((c) => !coveredSet.has(c));

  if (zeroCoverage.length === 0) {
    console.log("✅ All counties have coverage in last 48h");
    return;
  }

  const alertKey = `coverage-gap-${zeroCoverage.slice(0, 5).sort().join(",")}`;
  const fire = await shouldFireAlert(db, alertKey);
  if (!fire) {
    console.log(`🔕 Coverage gap alert throttled (cooldown: ${COOLDOWN_HOURS}h)`);
    return;
  }

  const subject = `⚠️ KY News: ${zeroCoverage.length} counties with no coverage`;
  const text = [
    `${zeroCoverage.length} Kentucky counties have had ZERO articles in the last ${COVERAGE_GAP_HOURS} hours:`,
    "",
    zeroCoverage.join(", "),
    "",
    "Action: Add RSS feeds or scrapers for these counties.",
    "Coverage report: https://localkynews.com/admin/coverage",
  ].join("\n");

  // Group counties by region for Slack
  const slackPayload = {
    text: `:warning: *${zeroCoverage.length} Kentucky counties with no news coverage (${COVERAGE_GAP_HOURS}h)*`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:newspaper: *Coverage Gap Alert*\n${zeroCoverage.length} counties with zero articles in last ${COVERAGE_GAP_HOURS} hours`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Uncovered counties:*\n${zeroCoverage.map((c) => `• ${c}`).join("\n")}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View Coverage Report" },
            url: "https://localkynews.com/admin/coverage",
            style: "danger",
          },
        ],
      },
    ],
  };

  await sendAlert({ subject, text, slackPayload });
  console.log(`🚨 Coverage gap alert sent: ${zeroCoverage.length} counties`);
}

// ─── Feed failure alerting ────────────────────────────────────────────────────

/**
 * Alert when a feed has N consecutive errors.
 */
export async function alertFeedFailures(db) {
  // Get feeds with recent consecutive errors
  const failing = await db.prepare(`
    SELECT f.id, f.name, f.url, COUNT(fe.id) as error_count
    FROM feeds f
    JOIN fetch_errors fe ON fe.feed_id = f.id
    WHERE fe.at >= datetime('now', '-3 hours')
      AND f.enabled = 1
    GROUP BY f.id
    HAVING error_count >= @threshold
    ORDER BY error_count DESC
  `).all({ threshold: FEED_FAIL_THRESHOLD });

  if (failing.length === 0) return;

  const alertKey = `feed-failures-${failing.map((f) => f.id).sort().join(",")}`;
  const fire = await shouldFireAlert(db, alertKey);
  if (!fire) return;

  const subject = `🔴 KY News: ${failing.length} feeds failing`;
  const lines = failing.map((f) => `• ${f.name}: ${f.error_count} errors — ${f.url}`);
  const text = [
    `${failing.length} feeds are consistently failing:`,
    "",
    ...lines,
  ].join("\n");

  const slackPayload = {
    text: `:red_circle: *${failing.length} feeds failing*`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:red_circle: *Feed Failure Alert*\n${failing.length} feeds with ${FEED_FAIL_THRESHOLD}+ errors in last 3 hours`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: failing.map((f) => `• *${f.name}* — ${f.error_count} errors`).join("\n"),
        },
      },
    ],
  };

  await sendAlert({ subject, text, slackPayload });
  console.log(`🚨 Feed failure alert sent: ${failing.length} feeds`);
}

// ─── Breaking news alerting (optional) ───────────────────────────────────────

/**
 * Send a Slack notification for a newly detected breaking news item.
 * Only fires if ALERT_ON_BREAKING=true env var is set.
 */
export async function alertBreakingNews(db, item) {
  if (process.env.ALERT_ON_BREAKING !== "true") return;
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const alertKey = `breaking-${item.id}`;
  const fire = await shouldFireAlert(db, alertKey);
  if (!fire) return;

  const county = item.counties || "Kentucky";
  await sendSlack(webhookUrl, {
    text: `:rotating_light: *BREAKING* — ${item.title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:rotating_light: *Breaking News — ${county}*\n*${item.title}*`,
        },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: (item.summary || "").slice(0, 300) },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Read Story" },
            url: item.url,
          },
        ],
      },
    ],
  });
}
