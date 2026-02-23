/**
 * Breaking News & Sentiment Flags
 *
 * Detects:
 *  1. Breaking/urgent news → is_breaking = 1 (surfaces to top of feeds)
 *  2. Alert/emergency level → alert_level: 'breaking' | 'developing' | 'urgent' | null
 *  3. Positive/negative sentiment (simple) → useful for filtering crisis content
 *
 * Breaking articles are sorted before non-breaking in the Today feed.
 * They expire from "breaking" status after 4 hours (set breaking_expires_at).
 */

// ─── Breaking / Urgency signals ───────────────────────────────────────────────

const BREAKING_PATTERNS = [
  /\bbreaking\s*(?:news|:)?\b/i,
  /\burgent\b/i,
  /\balert\s*:/i,
  /\bbreaking\b/i,
];

const DEVELOPING_PATTERNS = [
  /\bdeveloping\s*(?:story|situation|:)?\b/i,
  /\bupdate\s*:/i,
  /\bwatch\s*:/i,  // Weather watch
  /\bjust\s+in\b/i,
];

const EMERGENCY_PATTERNS = [
  /\bemergency\b/i,
  /\bevacuation\b/i,
  /\bevacuate\b/i,
  /\bshelter.in.place\b/i,
  /\bamber\s+alert\b/i,
  /\bsilver\s+alert\b/i,
  /\bblue\s+alert\b/i,
  /\bmissing\s+(?:child|person|adult)\b/i,
  /\bactive\s+shooter\b/i,
  /\bbomb\s+threat\b/i,
  /\bhazmat\b/i,
  /\bgas\s+leak\b/i,
];

// Words that indicate official emergency / government alert sources
const OFFICIAL_ALERT_SOURCES = [
  "national weather service",
  "nws",
  "kentucky emergency management",
  "kyem",
  "kentucky state police",
  "ksp",
  "governor's office",
  "fema",
];

// ─── Negative sentiment keywords (crisis / bad news) ─────────────────────────

const NEGATIVE_SIGNALS = [
  "killed","died","death","dead","fatal","fatality","crash","accident",
  "arrest","charged","indicted","convicted","sentenced","prison","jail",
  "fire","explosion","flood","tornado","storm damage","destroyed",
  "shooting","stabbing","homicide","murder","assault","robbery",
  "overdose","suicide","hospitalized","injury","injured",
  "bankruptcy","layoff","closure","shutdown","recalled","outbreak",
  "contamination","spill","leak","evacuation",
];

// ─── Positive sentiment keywords ─────────────────────────────────────────────

const POSITIVE_SIGNALS = [
  "awarded","honored","celebrated","achievement","success","won","win",
  "grant","funding","expansion","hired","opened","launched","rescued",
  "recovered","improving","record","milestone","graduation","scholarship",
  "donation","volunteer","community","partnership","breakthrough",
];

// ─── Classification ───────────────────────────────────────────────────────────

/**
 * @typedef {'breaking' | 'emergency' | 'developing' | null} AlertLevel
 * @typedef {'positive' | 'negative' | 'neutral'} Sentiment
 */

/**
 * Classify a single article for breaking news / sentiment.
 *
 * @param {string} title
 * @param {string} body
 * @param {string} [sourceUrl]
 * @returns {{
 *   isBreaking: boolean,
 *   alertLevel: AlertLevel,
 *   sentiment: Sentiment,
 *   breakingExpiresAt: string | null,
 *   signals: string[]
 * }}
 */
export function classifyBreaking(title, body, sourceUrl = "") {
  const combined = `${title} ${body.slice(0, 500)}`;
  const signals = [];
  let alertLevel = null;
  let isBreaking = false;

  // Emergency check (highest priority)
  for (const re of EMERGENCY_PATTERNS) {
    if (re.test(combined)) {
      alertLevel = "emergency";
      isBreaking = true;
      signals.push(`emergency:${re.source}`);
      break;
    }
  }

  // Breaking check
  if (!alertLevel) {
    for (const re of BREAKING_PATTERNS) {
      if (re.test(title)) { // Title-only for breaking — body mentions are noise
        alertLevel = "breaking";
        isBreaking = true;
        signals.push(`breaking:${re.source}`);
        break;
      }
    }
  }

  // Official alert source boost
  if (!alertLevel) {
    const lc = combined.toLowerCase();
    for (const src of OFFICIAL_ALERT_SOURCES) {
      if (lc.includes(src)) {
        alertLevel = "developing";
        isBreaking = true;
        signals.push(`official-source:${src}`);
        break;
      }
    }
  }

  // Developing check
  if (!alertLevel) {
    for (const re of DEVELOPING_PATTERNS) {
      if (re.test(combined)) {
        alertLevel = "developing";
        signals.push(`developing:${re.source}`);
        break;
      }
    }
  }

  // Sentiment
  const lc = combined.toLowerCase();
  let negScore = NEGATIVE_SIGNALS.filter((w) => lc.includes(w)).length;
  let posScore = POSITIVE_SIGNALS.filter((w) => lc.includes(w)).length;
  const sentiment =
    negScore > posScore + 1 ? "negative"
    : posScore > negScore + 1 ? "positive"
    : "neutral";

  // Breaking articles expire after 4 hours
  let breakingExpiresAt = null;
  if (isBreaking) {
    const exp = new Date(Date.now() + 4 * 60 * 60 * 1000);
    breakingExpiresAt = exp.toISOString();
  }

  return { isBreaking, alertLevel, sentiment, breakingExpiresAt, signals };
}

/**
 * Check if an item is still within its breaking window.
 */
export function isStillBreaking(breakingExpiresAt) {
  if (!breakingExpiresAt) return false;
  return new Date(breakingExpiresAt) > new Date();
}
