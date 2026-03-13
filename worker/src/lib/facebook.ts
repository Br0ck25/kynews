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
 * Split a summary into an array of individual sentences.
 */
function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by whitespace and a capital letter.
  // Uses a simple approach that avoids splitting on abbreviations like "St." or "Dr."
  const abbrevRe = /\b(?:Mr|Mrs|Ms|Dr|Gov|Lt|Col|Gen|Rep|Sen|Prof|St|Sr|Jr|No|vs|etc|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec|a\.m|p\.m)$/i;
  const results: string[] = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buf += ch;
    if (!/[.!?]/.test(ch)) continue;
    // skip past closing quotes/parens
    let j = i + 1;
    while (j < text.length && /['")\u201d\u2019]/.test(text[j])) { buf += text[j]; j++; }
    if (j >= text.length || !/\s/.test(text[j])) continue;
    // skip whitespace to find next char
    let k = j;
    while (k < text.length && /\s/.test(text[k])) k++;
    if (k >= text.length) continue;
    // if ends with abbreviation, don't split
    const stem = buf.trimEnd().replace(/[.!?]["')\u201d\u2019]*$/, '').trimEnd();
    if (ch === '.' && abbrevRe.test(stem)) continue;
    results.push(buf.trim());
    buf = '';
    i = k - 1;
  }
  if (buf.trim()) results.push(buf.trim());
  return results;
}

/**
 * Choose a short hook from an article summary. Returns the first sentence and
 * truncates to 40 words if necessary.
 */
export function generateFacebookHook(summary: string = '', county?: string): string {
  const text = (summary || '').trim();
  if (!text) return '';

  const sentences = splitSentences(text);
  let hook = sentences[0] || text;

  // ignore hooks that are too short to be useful
  const wordCount = hook.split(/\s+/).filter(Boolean).length;
  if (wordCount < 3 || hook.length < 20) {
    hook = '';
  }

  if (hook) {
    const words = hook.split(/\s+/);
    if (words.length > 40) {
      hook = words.slice(0, 40).join(' ') + '…';
    }
    if (county && !new RegExp(county, 'i').test(hook)) {
      hook = `In ${county} County, ${hook}`;
    }
  }

  return hook;
}

/**
 * Build a string of hashtags for the given article record.
 * Target: 3–5 tags. Always includes #Kentucky and #LocalNews.
 * Adds a county tag, a category/topic tag, and optionally a region tag.
 */
export function generateFacebookHashtags(article: ArticleRecord): string {
  // obituaries get no hashtags
  if (article.category === 'obituaries') return '';

  const tags: string[] = [];

  // 1. County tag (most specific)
  if (article.county) {
    tags.push(`#${article.county.replace(/\s+/g, '')}`);
  }

  // 2. #Kentucky — core identity tag
  tags.push('#Kentucky');

  // 3. Category/topic tag
  if (article.category === 'weather') {
    tags.push('#KYwx');
    tags.push('#Weather');
  } else if (article.category === 'sports') {
    tags.push('#KentuckySports');
  } else if (article.category === 'schools') {
    tags.push('#KYEducation');
  } else if (article.category === 'crime' || article.category === 'courts') {
    tags.push('#KYCrime');
  } else if (article.category === 'politics') {
    tags.push('#KYPolitics');
  } else {
    tags.push('#LocalNews');
  }

  // 4. Always end with #LocalNews (unless already added above)
  if (!tags.includes('#LocalNews')) {
    tags.push('#LocalNews');
  }

  // cap at 5 tags
  return tags.slice(0, 5).join(' ');
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

/**
 * Generate a full Facebook caption using the High-Reach 4-Line News Format:
 *
 *   LINE 1 – Hook / Headline (article title, cleaned of branding)
 *   LINE 2 – What Happened (first sentence of summary)
 *   LINE 3 – Key Detail (second sentence: location, timing, charges, impact)
 *   LINE 4 – What Happens Next (third sentence if available: investigation, future impact)
 *   Hashtags (3–5)
 *
 * Returns empty string for non-Kentucky articles.
 */
export function generateFacebookCaption(article: ArticleRecord | null): string {
  if (!article) return '';
  const isKy = Boolean(article.county) || Boolean(article.isKentucky);
  if (!isKy) return '';

  // LINE 1 — Headline
  const headline = cleanFacebookHeadline(article.title || '');

  // Extract sentences from the summary (fall back to contentText if summary is sparse)
  const summaryText = (article.summary || article.contentText || '').trim();
  const sentences = splitSentences(summaryText);

  // LINE 2 — What Happened (first sentence, with county prefix if missing)
  let line2 = sentences[0] || '';
  if (line2) {
    const words = line2.split(/\s+/);
    if (words.length > 40) line2 = words.slice(0, 40).join(' ') + '…';
    // Only add county prefix if county isn't already mentioned in either
    // the headline or the opening sentence — avoids redundancy like
    // "In Knott County, ... crash in Knott Co."
    const countyInHeadline = new RegExp(article.county, 'i').test(headline);
    const countyInLine2 = new RegExp(article.county, 'i').test(line2);
    if (article.county && !countyInHeadline && !countyInLine2) {
      line2 = `In ${article.county} County, ${line2}`;
    }
  }

  // LINE 3 — Key Detail (second sentence)
  let line3 = sentences[1] || '';
  if (line3) {
    const words = line3.split(/\s+/);
    if (words.length > 40) line3 = words.slice(0, 40).join(' ') + '…';
  }

  // LINE 4 — What Happens Next (third sentence, optional)
  let line4 = sentences[2] || '';
  if (line4) {
    const words = line4.split(/\s+/);
    if (words.length > 40) line4 = words.slice(0, 40).join(' ') + '…';
  }

  // Article URL (always points at our site)
  const url = articleUrl(article);

  // Hashtags
  const hashtags = generateFacebookHashtags(article);

  // Assemble caption
  const parts: string[] = [headline];
  if (line2) parts.push(line2);
  if (line3) parts.push(line3);
  if (line4) parts.push(line4);
  if (url) parts.push(url);
  if (hashtags) parts.push(hashtags);

  return parts.join('\n\n').trim();
}
