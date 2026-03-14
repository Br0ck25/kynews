// Helper for constructing SEO-friendly page titles.
// The title is enriched with county, city, or Kentucky context when available,
// while attempting to keep the result under 70 characters when possible.
//
// For the county case two fallback tiers reduce the suffix when the article
// title would otherwise be cut too short:
//   1. If maxTitleLength < 20, drop the county label and use " | Local KY News".
//   2. If maxTitleLength < 15 even then, omit the site name entirely and return
//      "{first 55 chars}… — {CountyLabel}, KY".

export function buildPageTitle(
  title: string,
  county: string | null | undefined,
  isKentucky: boolean | null | undefined,
  city?: string | null,
): string {
  const base = (title || '').trim();
  const normalizedTitle = base || 'Local KY News';
  const countyName = county ? county.trim() : '';
  const cityName = city ? city.trim() : '';
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
      return `${titlePart.slice(0, 55)}\u2026 \u2014 ${countyLabel}, KY`;
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
  const separator = hasCity || hasKentucky ? ' \u2014 ' : ' ';

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
