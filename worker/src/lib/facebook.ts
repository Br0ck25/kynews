import type { ArticleRecord } from '../types';
import { BASE_URL } from '../index';

/**
 * Clean up a headline for a Facebook post. Strips common trailing branding
 * segments separated by pipes or dashes/ems.
 */
export function cleanFacebookHeadline(title: string): string {
  if (!title) return '';
  let cleaned = title.trim();
  cleaned = cleaned.replace(/\s*[-–—|]\s*[^-–—|]+$/, '').trim();
  return cleaned;
}

/**
 * Choose a short hook from an article summary. Returns the first sentence and
 * truncates to 300 words (previously 150).
 */
export function generateFacebookHook(summary: string = '', county?: string): string {
  const text = (summary || '').trim();
  if (!text) return '';

  const sentences = text.split(/(?<=[.?!])\s+/);
  let hook = sentences[0] || text;

  // ignore hooks that are too short to be useful -- single-word/abbreviation
  // or otherwise under a reasonable length.  In those cases we prefer to
  // omit the hook entirely so the caption doesn't end up saying nothing
  // meaningful (e.g. just "Gov.").
  const wordCount = hook.split(/\s+/).filter(Boolean).length;
  if (wordCount < 3 || hook.length < 20) {
    hook = '';
  }

  if (hook) {
    const words = hook.split(/\s+/);
    if (words.length > 300) {
      hook = words.slice(0, 300).join(' ') + '…';
    }
    if (county && !new RegExp(county, 'i').test(hook)) {
      hook = `In ${county} County, ${hook}`;
    }
  }

  return hook;
}

/**
 * Build a string of hashtags for the given article record.
 */
export function generateFacebookHashtags(article: ArticleRecord): string {
  const tags: string[] = [];
  if (article.county) {
    // add KY suffix to make the hashtag more specific/searchable
    tags.push(`#${article.county.replace(/\s+/g, '')}CountyKY`);
  }
  // include a generic Kentucky tag for all KY stories
  tags.push('#KentuckyNews');
  // additional category-specific hashtags
  if (article.category === 'weather') {
    tags.push('#Weather');
  }
  if (article.category === 'sports') {
    tags.push('#KentuckySports');
  }
  if (article.category === 'schools') {
    tags.push('#KentuckyEducation');
  }
  // obituaries intentionally get no hashtags; return empty list entirely
  if (article.category === 'obituaries') {
    return '';
  }
  return tags.join(' ');
}

/**
 * Generate a full Facebook caption for an article. Returns a blank string if the
 * record is not considered Kentucky-centric (no county and is_kentucky false).
 */

// helper: convert a county name into "slug-case" county string
function countySlug(countyName: string): string {
  let cleaned = countyName.trim();
  if (!/county$/i.test(cleaned)) cleaned += ' County';
  return cleaned.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// build a full URL for an article using our public site origin
function articleUrl(article: ArticleRecord, baseUrl = BASE_URL): string {
  if (!article.slug) {
    return `${baseUrl}/post?articleId=${article.id}`;
  }
  if (article.county) {
    return `${baseUrl}/news/kentucky/${countySlug(article.county)}/${article.slug}`;
  }
  if (article.category === 'national') {
    return `${baseUrl}/news/national/${article.slug}`;
  }
  return `${baseUrl}/news/kentucky/${article.slug}`;
}

export function generateFacebookCaption(article: ArticleRecord | null): string {
  if (!article) return '';
  const isKy = Boolean(article.county) || Boolean(article.isKentucky);
  if (!isKy) return '';

  const headline = cleanFacebookHeadline(article.title || '');
  // only pass the county value; city should never be treated as a
  // county when constructing the hook text
  let hook = generateFacebookHook(article.summary || '',
    article.county || undefined);
  // if the summary didn't produce a useful hook (e.g. it was just "Gov.")
  // try falling back to the full content text which may contain more detail.
  if (!hook && article.contentText) {
    hook = generateFacebookHook(article.contentText, article.county || undefined);
  }

  let url = articleUrl(article);
  // ensure the url actually points at our site; fallback just in case
  if (!url.startsWith(BASE_URL)) {
    url = articleUrl(article);
  }
  const hashtags = generateFacebookHashtags(article);

  let caption = headline;
  if (hook) caption += `\n\n${hook}`;
  if (url) caption += `\n\nRead more:\n${url}`;
  if (hashtags) caption += `\n\n${hashtags}`;
  return caption.trim();
}
