import type { ArticleRecord } from '../types';

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
 * truncates to 40 words.
 */
export function generateFacebookHook(summary: string = '', county?: string): string {
  const text = (summary || '').trim();
  if (!text) return '';
  const sentences = text.split(/(?<=[.?!])\s+/);
  let hook = sentences[0] || text;
  const words = hook.split(/\s+/);
  if (words.length > 40) {
    hook = words.slice(0, 40).join(' ') + '…';
  }
  if (county && !new RegExp(county, 'i').test(hook)) {
    hook = `In ${county} County, ${hook}`;
  }
  return hook;
}

/**
 * Build a string of hashtags for the given article record.
 */
export function generateFacebookHashtags(article: ArticleRecord): string {
  const tags: string[] = [];
  if (article.county) {
    tags.push(`#${article.county.replace(/\s+/g, '')}County`);
  }
  tags.push('#KentuckyNews');
  return tags.join(' ');
}

/**
 * Generate a full Facebook caption for an article. Returns a blank string if the
 * record is not considered Kentucky-centric (no county and is_kentucky false).
 */
export function generateFacebookCaption(article: ArticleRecord | null): string {
  if (!article) return '';
  const isKy = Boolean(article.county) || Boolean(article.isKentucky);
  if (!isKy) return '';

  const headline = cleanFacebookHeadline(article.title || '');
  const hook = generateFacebookHook(article.summary || '',
    article.county || (article.city || undefined));

  const url = article.canonicalUrl || article.sourceUrl || '';
  const hashtags = generateFacebookHashtags(article);

  let caption = headline;
  if (hook) caption += `\n\n${hook}`;
  if (url) caption += `\n\nRead more:\n${url}`;
  if (hashtags) caption += `\n\n${hashtags}`;
  return caption.trim();
}
