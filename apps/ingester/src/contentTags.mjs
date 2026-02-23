/**
 * Shared content-tagging utilities used by both the ingester (at ingest time)
 * and the API server (for tag-based query filtering).
 *
 * Import from ingester: import { ... } from "./contentTags.mjs"
 * Import from server:   import { ... } from "../../ingester/src/contentTags.mjs"
 *
 * FIX #10: This module is the single source of truth for sports/obituary/schools
 * tag detection, replacing the duplicated client-side logic in App.tsx.
 */

/**
 * Strip HTML tags and collapse whitespace to produce plain readable text.
 * FIX #7: textOnly was used in ingester.mjs but never defined — added here.
 * @param {string} html
 * @returns {string}
 */
export function textOnly(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Sports detection
// FIX #10: Ported from App.tsx SPORTS_CONTENT_RE — single canonical copy.
// ---------------------------------------------------------------------------

export const SPORTS_CONTENT_RE =
  /\b(sports?|football|basketball|baseball|soccer|volleyball|wrestling|athletic(?:s)?|nfl|nba|mlb|nhl|ncaa|hockey|olympics?|olympic|swimming|swimmer|tennis|golf|golfer|gymnastics?|gymnast|cycling|cyclist|lacrosse|softball|rugby|rowing|track\s+and\s+field|medal|athlete|tournament|championship|semifinal|quarterfinal)\b/i;

/**
 * Returns true if the combined text looks like a sports article.
 * @param {string} text  Combined title + summary + content
 */
export function isSportsContent(text) {
  return SPORTS_CONTENT_RE.test(String(text || ""));
}

// ---------------------------------------------------------------------------
// Obituary detection
// FIX #10: Ported from App.tsx isObituaryItem signals — single canonical copy.
// FIX #6: Added "funeral" and "visitation" as positive signals.
// ---------------------------------------------------------------------------

const OBITUARY_PHRASES = [
  "obituar",
  "passed away",
  "in loving memory",
  "in memory of",
  "in memoriam",
  "survived by",
  "predeceased",
  "laid to rest",
  "celebration of life",
  "death notice",
  "funeral arrangements",
  "memorial service for",
  "graveside service",
  "condolences to the family",
  // FIX #6: Added "funeral" and "visitation" as explicitly requested positive signals.
  "funeral home",
  "funeral service",
  "visitation will be held",
  "visitation from",
  "visitation at",
];

const OBITUARY_URL_PATTERNS = [
  { url: "/notice/", requires: ["funeral", "dignit", "legacy"] },
];

/**
 * Returns true if the article text/url looks like an obituary notice.
 * @param {{ title?: string, url?: string, summary?: string, content?: string }} item
 */
export function isObituaryContent({ title = "", url = "", summary = "", content = "" }) {
  const fullText = `${title} ${url} ${summary} ${content}`.toLowerCase();

  for (const phrase of OBITUARY_PHRASES) {
    if (fullText.includes(phrase)) return true;
  }

  const urlLower = String(url || "").toLowerCase();
  if (urlLower.includes("/notice/") && (urlLower.includes("funeral") || urlLower.includes("dignit") || urlLower.includes("legacy"))) {
    return true;
  }
  if (urlLower.includes("funeralhome") || urlLower.includes("funeral-home")) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Schools detection
// FIX #10: School-related keyword detection.
// ---------------------------------------------------------------------------

export const SCHOOLS_CONTENT_RE =
  /\b(school|schools|school\s+district|district|classroom|students?|teachers?|principal|university|college|graduation|enrollment|school\s+sports?|high\s+school|middle\s+school|elementary\s+school|board\s+of\s+education|superintendent|academic|curriculum|semester|tuition|homecoming|prom|school\s+board|faculty|campus)\b/i;

/**
 * Returns true if the combined text looks like a schools-related article.
 * @param {string} text  Combined title + summary + content
 */
export function isSchoolsContent(text) {
  return SCHOOLS_CONTENT_RE.test(String(text || ""));
}

// ---------------------------------------------------------------------------
// Tag computation
// Returns a comma-separated string of applicable tags, e.g. "sports,schools"
// FIX #10: Used at ingest time to write tags to items.tags DB column.
// ---------------------------------------------------------------------------

/**
 * Compute content tags for an item based on title, summary, and article text.
 * @param {{ title?: string, summary?: string, content?: string, articleText?: string, url?: string }} item
 * @returns {string}  Comma-separated tags (empty string if none).
 */
export function computeContentTags({ title = "", summary = "", content = "", articleText = "", url = "" }) {
  const combined = `${title} ${summary} ${content} ${articleText}`;
  const tags = [];
  if (isSportsContent(combined)) tags.push("sports");
  if (isObituaryContent({ title, url, summary, content: `${content} ${articleText}` })) tags.push("obituary");
  if (isSchoolsContent(combined)) tags.push("schools");
  return tags.join(",");
}
