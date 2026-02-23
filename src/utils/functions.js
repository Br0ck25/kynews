import { KENTUCKY_COUNTIES } from '../constants/counties';

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
// always include "Kentucky" for KY articles, or "National" otherwise.
// append county names (split on commas) if provided, and any explicit
// tags already present on the post.
export function getPostTags(post) {
  if (!post || typeof post !== 'object') return [];
  const result = [];

  // county presence overrides isKentucky flag
  if (post.county) {
    result.push('Kentucky');
  } else if (post.isKentucky) {
    result.push('Kentucky');
  } else {
    result.push('National');
  }

  if (post.county) {
    const parts = post.county.split(',').map((p) => p.trim()).filter(Boolean);
    result.push(...parts);
  }

  if (Array.isArray(post.tags) && post.tags.length > 0) {
    result.push(...post.tags.filter((t) => t && typeof t === 'string'));
  }

  // de-duplicate while preserving order
  return [...new Set(result)];
}