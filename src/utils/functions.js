import { KENTUCKY_COUNTIES } from '../constants/counties';

// root of the public-facing site; used when building full URLs in captions
export const SITE_URL = 'https://localkynews.com';

/**
 * Formats a date as "MM/DD/YYYY hh:mm AM/PM ET" using the article's original published timestamp.
 * Falls back to the raw value string if the date is unparseable.
 */
export function ToDateTime(value) {
  if (!value) return '';
  try {
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    const datePart = new Intl.DateTimeFormat('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      timeZone: 'America/New_York',
    }).format(d);
    const timePart = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/New_York',
      timeZoneName: 'short',
    }).format(d);
    return `${datePart} ${timePart}`;
  } catch {
    return String(value);
  }
}

/**
 * Shows the same MM/DD/YYYY formatted date.
 */
export function DateFromNow(value) {
  return ToDateTime(value);
}

export async function ShareAPI(title, text, url){
    if (navigator.share === undefined) {
        console.log('Error: Unsupported feature: navigator.share');
        return;
      }
  
    //   const text = `I'm reading on Kentucky News. Read the original article here: ${props.post.title}`
  
      try {
        await navigator.share({title, text, url});
        console.log('Successfully sent share');
      } catch (error) {
        console.log('Error sharing: ' + error);
      }
}

export function isMobile(){
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

// converts a county name (from KENTUCKY_COUNTIES) into a slug.  the
// returned value is always kebab-case and will include "-county" so the
// resulting URLs look like `/news/fayette-county`.  Accepts either the raw
// name ("Jefferson") or a name that already contains the word "County".
export function countyToSlug(countyName) {
  if (!countyName || typeof countyName !== 'string') return '';
  let cleaned = countyName.trim();
  if (!/county$/i.test(cleaned)) {
    cleaned += ' County';
  }
  return cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// reverse of countyToSlug; returns the canonical county name from the
// provided slug (based on KENTUCKY_COUNTIES). If the slug doesn't match any
// county an empty string is returned.
export function slugToCounty(slug) {
  if (!slug || typeof slug !== 'string') return '';
  const normalized = slug.trim().toLowerCase();
  const stripped = normalized.replace(/-county$/, '');
  const match = KENTUCKY_COUNTIES.find((c) => {
    const lower = c.toLowerCase();
    return lower === stripped || lower === normalized;
  });
  return match || '';
}

// derive display tags for a post object; used by card components.

// county intro generator moved out of county-page for reuse and testability
import { getCountyInfo } from "../constants/countyInfo";

export function getCountyFaqs(countyName) {
  const infoMap = getCountyInfo();
  const info = infoMap[`${countyName} County`] || {};
  const faqs = [];

  if (info['County Seat']) {
    faqs.push({
      q: `What is the county seat of ${countyName} County, Kentucky?`,
      a: `The county seat of ${countyName} County is ${info['County Seat']}.`,
    });
  }
  if (info['Population']) {
    faqs.push({
      q: `What is the population of ${countyName} County, Kentucky?`,
      a: `${countyName} County, Kentucky has a population of approximately ${info['Population'].replace(/[^0-9,]/g, '')}.`,
    });
  }
  if (info['School District(s)']) {
    faqs.push({
      q: `What school district serves ${countyName} County, Kentucky?`,
      a: `${countyName} County is served by ${info['School District(s)']}.`,
    });
  }
  if (info['Sheriff']) {
    faqs.push({
      q: `Who is the ${countyName} County Sheriff?`,
      a: `The ${countyName} County Sheriff's Office is ${info['Sheriff']}.`,
    });
  }
  if (info['Median Household Income']) {
    faqs.push({
      q: `What is the median household income in ${countyName} County, Kentucky?`,
      a: `The median household income in ${countyName} County, Kentucky is approximately ${info['Median Household Income']}.`,
    });
  }

  // Always include a general news question
  faqs.push({
    q: `Where can I find the latest news for ${countyName} County, Kentucky?`,
    a: `Local KY News aggregates the latest ${countyName} County news from local newspapers, TV stations, and government sources at localkynews.com/news/kentucky/${countyName.toLowerCase().replace(/\s/g, '-')}-county.`,
  });

  return faqs;
}

export function getCountyIntro(countyName) {
  const infoMap = getCountyInfo();
  const key = `${countyName} County`;
  const info = infoMap[key] || {};

  // assemble custom opening using available data
  let opening = `${countyName} County is one of Kentucky's 120 counties`;
  if (info['County Seat']) {
    opening += `; the county seat is ${info['County Seat']}.`;
  } else {
    opening += `, located in the Commonwealth of Kentucky.`;
  }
  if (info.Population) {
    opening += ` It has a population of approximately ${info.Population.replace(/[^0-9,]/g, '')}.`;
  }
  if (info['Median Household Income']) {
    opening += ` Median household income is around ${info['Median Household Income']}.`;
  }
  if (info['Unique Fact']) {
    opening += ` ${info['Unique Fact']}`;
  }
  opening += `\n\n`;

  let body = `Like many of Kentucky's counties, ${countyName} County has a rich history rooted in the traditions, communities, and industries that have shaped the region over generations. Residents of ${countyName} County are served by local government, public school districts, healthcare providers, churches, and community organizations that make up the fabric of everyday life in this part of the state.`;

  if (info.Sheriff) {
    body += ` The local sheriff’s office is ${info.Sheriff}.`;
  }
  if (info['School District(s)']) {
    body += ` School services are provided by ${info['School District(s)']}.`;
  }
  if (info['Time Zone']) {
    body += ` The county lies in the ${info['Time Zone']} time zone.`;
  }
  body += `\n\n`;

  const footer = `This page is updated continuously as new ${countyName} County news is published across our monitored sources. If you want quick access to ${countyName} County news, you can bookmark this county with the button above and revisit it from the Saved page. To filter your Home feed by county, go to <a href=\"/settings\">Settings \u2192 County Filters</a>.`;

  return opening + body + footer;
}

// derive display tags for a post object; used by card components.
// always include "Kentucky" for KY articles, or "National" otherwise.
// append county names (split on commas) if provided, and any explicit
// tags already present on the post.
export function getPostTags(post) {
  if (!post || typeof post !== 'object') return [];
  const result = [];

  // county presence overrides isKentucky flag
  if (post.county || (Array.isArray(post.counties) && post.counties.length > 0)) {
    result.push('Kentucky');
  } else if (post.isKentucky) {
    result.push('Kentucky');
  } else {
    result.push('National');
  }

  // collect county names; prefer the explicit `counties` list if available
  if (Array.isArray(post.counties) && post.counties.length > 0) {
    result.push(...post.counties.filter((c) => typeof c === 'string' && c.trim()));
  } else if (post.county) {
    const parts = post.county.split(',').map((p) => p.trim()).filter(Boolean);
    result.push(...parts);
  }

  if (Array.isArray(post.tags) && post.tags.length > 0) {
    result.push(...post.tags.filter((t) => t && typeof t === 'string'));
  }

  // de-duplicate while preserving order
  return [...new Set(result)];
}

/**
 * Build the correct internal article URL from a post object.
 *
 * Priority:
 *   1. County article with slug  → /news/kentucky/<countySlug>/<articleSlug>
 *   2. Statewide KY article      → /news/kentucky/<articleSlug>
 *   3. National article w/ slug  → /news/national/<articleSlug>
 *   4. No slug (legacy fallback) → /post?articleId=<id>
 */
export function articleToUrl(post) {
  if (!post) return '/';
  const slug = post.slug;
  if (!slug) {
    return post.id ? `/post?articleId=${post.id}` : '/post';
  }
  const isNational =
    Boolean(post.isNational) ||
    (Array.isArray(post.categories)
      ? post.categories.includes('national')
      : post.category === 'national');
  if (post.county) {
    return `/news/kentucky/${countyToSlug(post.county)}/${slug}`;
  }
  if (isNational) {
    return `/news/national/${slug}`;
  }
  // Kentucky statewide article
  return `/news/kentucky/${slug}`;
}

// ---------------------------------------------------------------------------
// Facebook caption helper (for building auto-post templates)
// ---------------------------------------------------------------------------

/**
 * Clean up a headline for use in a Facebook post. Strips common
 * trailing branding segments separated by pipes or dashes.
 */
export function cleanHeadline(title) {
  if (!title || typeof title !== 'string') return '';
  let cleaned = title.trim();
  // remove trailing " - Something" or " | Something" or similar
  cleaned = cleaned.replace(/\s*[-–—|]\s*[^-–—|]+$/, '').trim();
  return cleaned;
}

/**
 * Pick a short hook from the article summary. Uses the first sentence
 * and trims to 80 words if necessary (double the previous limit).
 */
export function generateHook(summary = '', county = '') {
  const text = (summary || '').trim();
  if (!text) return '';
  const sentences = text.split(/(?<=[.?!])\s+/);
  let hook = sentences[0] || text;
  const words = hook.split(/\s+/);
  if (words.length > 80) {
    hook = words.slice(0, 80).join(' ') + '…';
  }
  // if county is provided and not already mentioned, prefix a location phrase
  if (county && !new RegExp(county, 'i').test(hook)) {
    hook = `In ${county} County, ${hook.charAt(0).toLowerCase() === hook.charAt(0) ? hook : hook}`;
  }
  return hook;
}

/**
 * Build a caption suitable for Facebook auto-posting. Returns an empty string
 * for non-Kentucky articles (no county and isKentucky false).
 */
export function generateFacebookCaption(post = {}) {
  if (!post || typeof post !== 'object') return '';
  const isKy = Boolean(post.county) || Boolean(post.isKentucky);
  if (!isKy) return '';

  const headline = cleanHeadline(post.title || '');
  const hook = generateHook(post.summary || '', post.county || post.city || '');
  // always point at our own site; ignore any stray url property
  let link = `${SITE_URL}${articleToUrl(post)}`;
  if (!link.startsWith(SITE_URL)) {
    link = `${SITE_URL}${articleToUrl(post)}`;
  }

  const hashtags = [];
  if (post.county) {
    const tag = `#${post.county.replace(/\s+/g, '')}County`;
    hashtags.push(tag);
  }
  hashtags.push('#KentuckyNews');

  let caption = headline;
  if (hook) caption += `\n\n${hook}`;
  if (link) caption += `\n\nRead more:\n${link}`;
  if (hashtags.length) caption += `\n\n${hashtags.join(' ')}`;
  return caption.trim();
}

/**
 * Build an SEO-friendly <title> / og:title string for an article.
 *
 * If a county is provided, the title includes the county and site name.
 * If no county is provided but isKentucky is true, it includes the city (if available)
 * or falls back to "Kentucky" and the site name.
 * Otherwise it falls back to the standard "| Local KY News" suffix.
 *
 * The result is kept under 70 characters where possible to avoid truncation in search results.
 * For the county case, two fallback tiers reduce the suffix when the article title
 * would otherwise be cut too short.
 */
export function buildPageTitle(title, county, isKentucky, city) {
  const base = (title || '').trim();
  const normalizedTitle = base || 'Local KY News';
  const countyName = county ? String(county).trim() : '';
  const cityName = city ? String(city).trim() : '';
  const siteSuffix = 'Local KY News';
  const maxLength = 70;

  const countyLabel = countyName
    ? (/county$/i.test(countyName) ? countyName : `${countyName} County`)
    : '';

  const hasCounty = Boolean(countyLabel);
  const hasCity = Boolean(cityName) && Boolean(isKentucky) && !hasCounty;
  const hasKentucky = Boolean(isKentucky) && !hasCounty && !hasCity;

  let titlePart = normalizedTitle.replace(/\s+/g, ' ').trim();

  if (hasCounty) {
    // Suffix includes the separator so maxTitleLength = maxLength - suffix.length.
    let suffix = ` — ${countyLabel}, KY | ${siteSuffix}`;
    let maxTitleLength = maxLength - suffix.length;

    if (maxTitleLength < 20) {
      // County label makes the suffix too long — drop it and use just the site name.
      suffix = ` | ${siteSuffix}`;
      maxTitleLength = maxLength - suffix.length;
    }

    if (maxTitleLength < 15) {
      // No room for a meaningful title — omit site name, keep county geo.
      return `${titlePart.slice(0, 55)}… — ${countyLabel}, KY`;
    }

    if (titlePart.length > maxTitleLength) {
      const truncated = titlePart.slice(0, maxTitleLength - 3).trimEnd();
      titlePart = `${truncated || titlePart.slice(0, maxTitleLength - 3)}...`;
    }

    return `${titlePart}${suffix}`;
  }

  // Non-county paths keep the separator/suffix split for simpler logic.
  const suffix = hasCity
    ? `${cityName}, KY | ${siteSuffix}`
    : hasKentucky
    ? `Kentucky | ${siteSuffix}`
    : `| ${siteSuffix}`;
  const separator = hasCity || hasKentucky ? ' — ' : ' ';

  const maxTitleLength = maxLength - separator.length - suffix.length;

  if (maxTitleLength > 0 && titlePart.length > maxTitleLength) {
    if (maxTitleLength <= 3) {
      titlePart = '.'.repeat(maxTitleLength);
    } else {
      const truncated = titlePart.slice(0, maxTitleLength - 3).trimEnd();
      titlePart = `${truncated || titlePart.slice(0, maxTitleLength - 3)}...`;
    }
  }

  return `${titlePart}${separator}${suffix}`;
}
