// Helper for constructing SEO-friendly page titles.
// The title is enriched with county or Kentucky context when available,
// while attempting to keep the result under 70 characters when possible.

export function buildPageTitle(
  title: string,
  county: string | null | undefined,
  isKentucky: boolean | null | undefined,
): string {
  const base = (title || '').trim();
  if (!base) return 'Local KY News';

  const countyName = county ? county.trim() : '';

  if (countyName) {
    const full = `${base} | ${countyName} County, KY — Local KY News`;
    if (full.length <= 70) return full;

    const shortened = `${base} — ${countyName} County, KY`;
    if (shortened.length <= 70) return shortened;

    // If we still exceed 70 chars, fall back to the shorter suffix anyway.
    return shortened;
  }

  if (isKentucky) {
    const full = `${base} | Kentucky — Local KY News`;
    if (full.length <= 70) return full;

    const shortened = `${base} — Kentucky`;
    if (shortened.length <= 70) return shortened;

    return full;
  }

  return `${base} — Local KY News`;
}
