/**
 * Paywall Detection
 *
 * Detects paywalled articles via multiple signals and assigns a confidence score.
 * Feeds and domains can be pre-flagged as known-paywall sources.
 *
 * Policy:
 *  - is_paywalled = 1   → show with a "Subscriber" badge in the UI
 *  - If a free source covers the same story (duplicate detection finds a match)
 *    AND the free source has more words → deprioritize the paywalled version
 *    (set paywall_deprioritized = 1, it sinks to the bottom of the feed)
 *  - Feeds can be flagged paywall_likely = 1 in the feeds table to pre-warn
 */

// ─── Known paywall domains ────────────────────────────────────────────────────

export const KNOWN_PAYWALL_DOMAINS = new Set([
  // National
  "nytimes.com",
  "wsj.com",
  "washingtonpost.com",
  "ft.com",
  "bloomberg.com",
  "theatlantic.com",
  "newyorker.com",
  "wired.com",
  "thetimes.co.uk",
  // Kentucky papers with known meters
  "courier-journal.com",    // Gannett — metered paywall
  "kentucky.com",           // McClatchy — metered
  "bgdailynews.com",        // metered
  "paducahsun.com",         // metered
  "messenger-inquirer.com", // metered
  "murrayledger.com",       // metered
  "hendersongleaner.com",   // metered
  "kentuckynewera.com",     // metered
  "somerset-kentucky.com",  // metered
  "timestribune.com",       // metered
  "richmondregister.com",   // metered
  "amnews.com",             // metered
]);

// Domains confirmed free (never flag these)
const FREE_DOMAINS = new Set([
  "kentuckylantern.com",
  "kycir.org",
  "ket.org",
  "kentuckyhealthnews.com",
  "nkytribune.com",
  "lanereport.com",
  "linknky.com",
  "rivercitynews.com",
  "lpm.org",
  "wfpl.org",
  "wymt.com",
  "wkyt.com",
  "lex18.com",
  "wdrb.com",
  "whas11.com",
  "wlky.com",
  "apnews.com",
  "weku.org",
  "wuky.org",
]);

// ─── HTML signal patterns ─────────────────────────────────────────────────────

const PAYWALL_META_SELECTORS = [
  // Schema.org
  '[name="paywall"]',
  '[property="og:paywall"]',
  // Common paywall meta tags
  '[name="access"]',
  '[name="content-type"][content="subscriber"]',
];

const PAYWALL_CSS_SIGNALS = [
  "paywall",
  "subscriber-only",
  "subscription-required",
  "premium-content",
  "locked-content",
  "content-gate",
  "piano-",           // Piano.io paywall platform
  "tinypass",         // Piano legacy
  "leaky-paywall",    // WordPress plugin
  "metered-paywall",
  "sw-content-gate",  // Subscriber Wall
  "access-locked",
  "nag-screen",
];

const PAYWALL_JSON_LD_SIGNALS = [
  '"isAccessibleForFree":"False"',
  '"isAccessibleForFree": "False"',
  '"isAccessibleForFree":false',
];

// Text that appears when content is cut off
const PAYWALL_TEXT_SIGNALS = [
  "subscribe to continue reading",
  "subscribe to read the full",
  "create a free account to read",
  "sign in to continue",
  "this content is for subscribers",
  "subscriber exclusive",
  "for subscribers only",
  "to read the full story",
  "to continue reading, please",
  "already a subscriber? sign in",
  "unlock this article",
  "get full access",
  "your free articles have been used",
  "you've used all your free",
  "you have used your",
  "members only",
];

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Analyse a fetched article HTML + URL for paywall signals.
 *
 * @param {string} html        - raw article HTML
 * @param {string} url         - article URL
 * @param {string} bodyText    - extracted body text (after Cheerio)
 * @returns {{ isPaywalled: boolean, confidence: number, signals: string[] }}
 *
 * confidence: 0–100 (≥60 → isPaywalled = true)
 */
export function detectPaywall(html, url, bodyText = "") {
  const signals = [];
  let score = 0;

  // 1. Known domain check
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (FREE_DOMAINS.has(host)) {
      return { isPaywalled: false, confidence: 0, signals: ["known-free-domain"] };
    }
    if (KNOWN_PAYWALL_DOMAINS.has(host)) {
      score += 40;
      signals.push("known-paywall-domain");
    }
  } catch {}

  const htmlLower = html.toLowerCase();
  const textLower = bodyText.toLowerCase();

  // 2. JSON-LD schema signal
  for (const sig of PAYWALL_JSON_LD_SIGNALS) {
    if (html.includes(sig)) {
      score += 35;
      signals.push("json-ld:isAccessibleForFree=false");
      break;
    }
  }

  // 3. CSS class / ID signals in HTML
  let cssHits = 0;
  for (const cls of PAYWALL_CSS_SIGNALS) {
    if (htmlLower.includes(cls)) {
      cssHits++;
      signals.push(`css:${cls}`);
    }
  }
  if (cssHits > 0) score += Math.min(cssHits * 10, 30);

  // 4. Visible paywall text
  let textHits = 0;
  for (const phrase of PAYWALL_TEXT_SIGNALS) {
    if (textLower.includes(phrase) || htmlLower.includes(phrase)) {
      textHits++;
      signals.push(`text:"${phrase.slice(0, 40)}"`);
    }
  }
  if (textHits > 0) score += Math.min(textHits * 15, 40);

  // 5. Very short body despite article page (sign of truncation)
  const wordCount = bodyText.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount > 0 && wordCount < 80) {
    score += 15;
    signals.push(`short-body:${wordCount}w`);
  }

  const confidence = Math.min(score, 100);
  const isPaywalled = confidence >= 60;

  return { isPaywalled, confidence, signals };
}

/**
 * Should we deprioritize a paywalled article?
 * True when a free duplicate exists with more content.
 *
 * @param {object} db
 * @param {string} itemId
 * @param {string} canonicalFreeId   - free duplicate item ID from dedup check
 */
export async function shouldDeprioritize(db, itemId, canonicalFreeId) {
  if (!canonicalFreeId) return false;

  const freeItem = await db.prepare(
    `SELECT word_count, is_paywalled FROM items WHERE id = @id`
  ).get({ id: canonicalFreeId });

  if (!freeItem) return false;

  // Deprioritize if the free version has more (or equal) words and isn't itself paywalled
  return !freeItem.is_paywalled && (freeItem.word_count || 0) >= 30;
}
