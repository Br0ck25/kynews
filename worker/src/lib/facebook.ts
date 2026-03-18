import type { ArticleRecord, Env } from '../types';
import { BASE_URL } from '../index';

// Share the same model as the rest of the AI pipeline
const FB_MODEL = '@cf/zai-org/glm-4.7-flash' as keyof AiModels;

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

  // ignore hooks that are too short to be useful (single-word stubs like "Gov.")
  const wordCount = hook.split(/\s+/).filter(Boolean).length;
  if (wordCount < 2 || hook.length < 5) {
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
  // Obituaries are personal — suppress hashtags entirely
  if (article.category === 'obituaries') return '';

  const tags: string[] = [];

  // 1. County tag: #WarrenCountyKY format for maximum discoverability
  if (article.county) {
    tags.push(`#${article.county.replace(/\s+/g, '')}CountyKY`);
  }

  // 2. #KentuckyNews — core identity tag
  tags.push('#KentuckyNews');

  // 3. Category/topic tag
  if (article.category === 'weather') {
    tags.push('#KYwx');
    tags.push('#Weather');
  } else if (article.category === 'sports') {
    tags.push('#KentuckySports');
  } else if (article.category === 'schools') {
    tags.push('#KentuckyEducation');
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

  // Obituaries should not be auto-posted to Facebook
  if (article.category === 'obituaries') return '';

  // LINE 1 — Headline in ALL CAPS for maximum visual impact
  const headline = cleanFacebookHeadline(article.title || '').toUpperCase();

  // Extract sentences; fall back to contentText if the summary is too brief
  // (e.g. a single abbreviation like "Gov.") to be worth displaying.
  const getUsable = (text: string): string[] =>
    splitSentences(text).filter(s => s.split(/\s+/).filter(Boolean).length >= 5);
  const summaryUsable = getUsable((article.summary || '').trim());
  const rawText = summaryUsable.length
    ? (article.summary || '').trim()
    : (article.contentText || '').trim();
  const usable = getUsable(rawText);

  // Helper: hard-truncate a sentence to a max word count
  const trunc = (s: string, max: number): string => {
    const words = s.split(/\s+/);
    return words.length > max ? words.slice(0, max).join(' ') + '…' : s;
  };

  // PROSE BLOCK — first two sentences as plain paragraphs
  const prose = usable.slice(0, 2).map(s => trunc(s, 50));

  // BULLET BLOCK — sentences 3–5 as bullet points when there is enough content
  // to justify a structured breakdown (requires at least 4 usable sentences).
  const bullets = usable.length >= 4
    ? usable.slice(2, 5).map(s => `• ${trunc(s, 40)}`)
    : [];

  // CLOSING — one sentence after the bullet block (sentence 6 when present)
  const closingIdx = usable.length >= 4 ? 5 : 2;
  const closing = usable[closingIdx] ? trunc(usable[closingIdx], 40) : '';

  // Article URL (always points at our site)
  const url = articleUrl(article);

  // Hashtags
  const hashtags = generateFacebookHashtags(article);

  // Assemble caption
  const parts: string[] = [headline];
  parts.push(...prose.filter(Boolean));
  if (bullets.length) parts.push(bullets.join('\n'));
  if (closing) parts.push(closing);
  if (url) parts.push(`Read more: ${url}`);
  if (hashtags) parts.push(hashtags);

  return parts.join('\n\n').trim();
}

/**
 * AI-powered Facebook caption generator.
 * Uses the article summary as source material and instructs the model to
 * compress + structure it — not rewrite it — into the high-reach post format.
 * Falls back to the algorithmic `generateFacebookCaption` if AI is
 * unavailable or returns an empty/malformed response.
 */
export async function generateAiFacebookCaption(
  article: ArticleRecord | null,
  env: Env,
): Promise<string> {
  // Guard: use fallback for non-KY / obituary / missing article
  const algorithmicCaption = generateFacebookCaption(article);
  if (!algorithmicCaption || !env.AI) return algorithmicCaption;

  const summaryText = (article!.summary || article!.contentText || '').trim();
  if (!summaryText || summaryText.split(/\s+/).length < 20) return algorithmicCaption;

  const headline = cleanFacebookHeadline(article!.title || '').toUpperCase();
  const url = articleUrl(article!);
  const hashtags = generateFacebookHashtags(article!);

  const systemPrompt = `You are a social media editor for a Kentucky local news website.
You write Facebook posts that are clear, concise, and drive link clicks.
You NEVER rewrite the story in a new style. You ONLY trim, simplify, and structure what is already written.
You NEVER add outside information, opinions, or commentary.
You NEVER invent facts, names, numbers, or quotes.`;

  const userPrompt = `Create a Facebook news post using ONLY the summary below. Do not rewrite. Only trim, simplify, and organize.

HEADLINE (already written — use exactly as-is, do not change):
${headline}

FORMAT YOUR RESPONSE AS:
1. The headline on its own line (copy it exactly)
2. A blank line
3. ONE intro paragraph — use or lightly trim the opening sentence of the summary. One sentence only. Do not add a second paragraph.
4. A blank line
5. 2–4 bullet points using • as the bullet character. Each bullet must be a complete, self-contained sentence or phrase. If a fact is too long, rewrite it in fewer words — do NOT use … or ... to truncate it. Skip the fact entirely rather than cut it off.
6. A blank line
7. ONE closing sentence that explains the core conflict or issue (use summary wording). Skip this if there is no clear conflict.
8. A blank line
9. Read more: ${url}
10. A blank line
11. ${hashtags}

RULES:
- Total post: 80–150 words (not counting the headline and URL)
- ONE intro paragraph only — do not write two opening paragraphs
- NEVER use … or ... anywhere in the post. If something is too long, shorten it with real words or cut it entirely
- Do NOT include attorney names, judge names, or procedural filing details unless they are the entire point of the story
- Do NOT include long quotes
- Make it slightly incomplete so readers click the link

SUMMARY:
${summaryText.slice(0, 6000)}`;

  try {
    const result = (await env.AI.run(FB_MODEL, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      seed: 42,
      max_completion_tokens: 900,
    })) as { response?: string };

    const raw = (result?.response || '').trim();
    if (!raw || raw.length < 80) return algorithmicCaption;

    // Strip <think>...</think> reasoning blocks the model may emit
    let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!cleaned || cleaned.length < 80) return algorithmicCaption;

    // Remove any bullet truncated with an ellipsis (… or ...) — the model
    // should not produce these per the prompt, but strip as a safety net.
    cleaned = cleaned.replace(/^• [^\n]*(?:…|\.\.\.)\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

    return cleaned;
  } catch {
    return algorithmicCaption;
  }
}
