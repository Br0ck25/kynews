// Helper for constructing SEO-friendly page titles.
// The title is enriched with county or Kentucky context when available,
// while attempting to keep the result under 70 characters when possible.

export function buildPageTitle(
  title: string,
  county: string | null | undefined,
  isKentucky: boolean | null | undefined,
): string {
  const base = (title || '').trim();
  const normalizedTitle = base || 'Local KY News';
  const countyName = county ? county.trim() : '';
  const siteSuffix = 'Local KY News';
  const maxLength = 60;

  const countyLabel = countyName
    ? (/county$/i.test(countyName) ? countyName : `${countyName} County`)
    : '';

  const hasCounty = Boolean(countyLabel);
  const hasKentucky = Boolean(isKentucky) && !hasCounty;

  const suffix = hasCounty
    ? `${countyLabel}, KY | ${siteSuffix}`
    : hasKentucky
    ? `Kentucky | ${siteSuffix}`
    : `| ${siteSuffix}`;
  const separator = hasCounty || hasKentucky ? ' — ' : ' ';

  const maxTitleLength = maxLength - separator.length - suffix.length;
  let titlePart = normalizedTitle.replace(/\s+/g, ' ').trim();

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
