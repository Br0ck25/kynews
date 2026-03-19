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
  // Also matches two-part initialisms like U.S, U.K, N.Y — (?:[A-Z]\.)[A-Z] catches
  // the stem of "U.S." after the trailing dot is stripped (leaving "U.S"), preventing
  // "U.S. Senate" from being split into two sentences.
  const abbrevRe = /(\b(?:Mr|Mrs|Ms|Dr|Gov|Lt|Col|Gen|Rep|Sen|Prof|St|Sr|Jr|No|vs|etc|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Ky|a\.m|p\.m)|(?:[A-Z]\.)[A-Z])$/;
  const results: string[] = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buf += ch;
    if (!/[.!?\u2026]/.test(ch)) continue;
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

function normalizeCaptionSourceText(text: string): string {
  if (!text) return '';
  let t = text
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();

  // Strip common lead-in labels/teasers that are not article prose.
  t = t.replace(/^\s*Summary\s*:?\s*/i, '');
  t = t.replace(/^\s*Update\s*\([^)]{1,120}\)\s*:\s*/i, '');
  t = t.replace(
    /^\s*\d{1,2}:\d{2}\s*[AP]M\s*(?:[A-Z]{2,4}\s+)?[A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}\s*/i,
    '',
  );

  // Remove recurring resource-disclaimer lines that can crowd out real story detail.
  t = t
    .replace(/^\s*This story discusses suicide\.\s*/i, '')
    .replace(/^\s*If you or someone you know is struggling with suicidal thoughts[^.]*\.\s*/i, '')
    .replace(/^\s*A directory of mental health providers[^.]*\.\s*/i, '');

  // Some wire summaries collapse sentence boundaries: "bill.The", "organizations.Gov".
  t = t.replace(/([A-Za-z0-9][.!?])([A-Z])/g, '$1 $2');

  // Flatten spacing/newlines for stable sentence splitting.
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function stripOuterQuotes(text: string): string {
  return text.trim().replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '').trim();
}

function isDatelineStub(text: string): boolean {
  return /^(?:[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,4}),\s*(?:Ky|KY|Kentucky)\.?$/.test(text);
}

function isLikelySentenceFragment(text: string, words: number): boolean {
  if (/^On\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?$/i.test(text)) {
    return true;
  }
  const quoteCount = (text.match(/["“”]/g) || []).length;
  if (quoteCount % 2 === 1 && words < 12) {
    return true;
  }
  return false;
}

function isBoilerplateCaptionSentence(text: string): boolean {
  return (
    /^Summary$/i.test(text) ||
    /^What you need to know\b/i.test(text) ||
    /^This story discusses suicide\.?$/i.test(text) ||
    /^If you or someone you know is struggling with suicidal thoughts/i.test(text) ||
    /^A directory of mental health providers/i.test(text) ||
    /988\s*(Suicide and Crisis Lifeline|lifeline)/i.test(text) ||
    /988lifeline\.org/i.test(text) ||
    /mentalhealthlou\.com/i.test(text)
  );
}

function isUsableCaptionSentence(sentence: string, strict = true): boolean {
  const text = stripOuterQuotes(sentence);
  if (!text) return false;
  if (isBoilerplateCaptionSentence(text)) return false;
  if (isDatelineStub(text)) return false;
  if (/[.][.][.]|\u2026/.test(text)) return false;
  if (/https?:\/\//i.test(text)) return false;
  if (/[A-Za-z]/.test(text) === false) return false;

  const words = countWords(text);
  if (words < (strict ? 5 : 3)) return false;
  if (strict && words > 65) return false;
  if (isLikelySentenceFragment(text, words)) return false;
  if (strict && /[:;,\-]\s*$/.test(text)) return false;
  return true;
}

function collectCaptionSentences(text: string, strict = true): string[] {
  const normalized = normalizeCaptionSourceText(text);
  if (!normalized) return [];
  return splitSentences(normalized)
    .map((s) => stripOuterQuotes(s))
    .filter((s) => isUsableCaptionSentence(s, strict));
}

function dedupeSentences(input: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const sentence of input) {
    const key = sentence.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(sentence.trim());
  }
  return out;
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
  }

  return hook;
}

/**
 * Build a string of hashtags for the given article record.
 * Target: 3–5 tags. Always includes #KentuckyNews and #LocalNews.
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
 *   LINE 1 – Headline (article title, cleaned of branding)
 *   LINE 2 – What Happened (first sentence of summary, with county prefix)
 *   LINE 3 – Key Detail (second sentence)
 *   LINE 4 – What Happens Next (third sentence, if available)
 *   URL + Hashtags
 *
 * Returns empty string for non-Kentucky articles.
 */
export function generateFacebookCaption(article: ArticleRecord | null): string {
  if (!article) return '';
  const isKy = Boolean(article.county) || Boolean(article.isKentucky);
  if (!isKy) return '';

  // Obituaries should not be auto-posted to Facebook
  if (article.category === 'obituaries') return '';

  // LINE 1 — Headline
  const headline = cleanFacebookHeadline(article.title || '');

  // Prefer summary sentences, but fill gaps from body text when summary lines are
  // teaser-like, truncated, or otherwise low quality.
  const summaryStrict = collectCaptionSentences(article.summary || '', true);
  const contentStrict = collectCaptionSentences(article.contentText || '', true);
  let sentences = dedupeSentences([...summaryStrict, ...contentStrict]);
  if (sentences.length < 2) {
    const summaryLoose = collectCaptionSentences(article.summary || '', false);
    const contentLoose = collectCaptionSentences(article.contentText || '', false);
    sentences = dedupeSentences([...sentences, ...summaryLoose, ...contentLoose]);
  }

  // LINE 2 — What Happened (first complete sentence)
  const line2 = sentences[0] || '';

  // LINE 3 — Key Detail (second complete sentence)
  const line3 = sentences[1] || '';

  // LINE 4 — What Happens Next (third complete sentence, optional)
  const line4 = sentences[2] || '';

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

/**
 * AI-powered Facebook caption generator.
 *
 * Uses the FULL article body (contentText) as source material so the model has
 * access to all the detail, conflict, and context in the story — not just the
 * opening summary sentences. Falls back to the algorithmic
 * `generateFacebookCaption` if AI is unavailable or returns a short/malformed
 * response.
 */
export async function generateAiFacebookCaption(
  article: ArticleRecord | null,
  env: Env,
): Promise<string> {
  // Guard: use fallback for non-KY / obituary / missing article
  const algorithmicCaption = generateFacebookCaption(article);
  if (!algorithmicCaption || !env.AI) return algorithmicCaption;

  // Prefer the full article body over the AI summary — contentText contains
  // the complete story including details deeper in the article that make for
  // a far more compelling post. Fall back to summary only if body is sparse.
  const fullBody = (article!.contentText || '').trim();
  const summaryText = (article!.summary || '').trim();
  const rawSource = fullBody.split(/\s+/).length >= summaryText.split(/\s+/).length
    ? fullBody
    : summaryText;

  // Rejoin sentences that were split across a paragraph break after an
  // abbreviation like "U.S." — handles both single (\n) and double (\n\n) breaks.
  const sourceText = rawSource.replace(/([A-Z]\.)\n+([A-Za-z])/g, '$1 $2');

  if (!sourceText || sourceText.split(/\s+/).length < 20) return algorithmicCaption;

  const headline = cleanFacebookHeadline(article!.title || '').toUpperCase();
  const url = articleUrl(article!);
  const hashtags = generateFacebookHashtags(article!);

  const systemPrompt = `You are a social media editor for a Kentucky local news website.
You write Facebook posts that stop the scroll — clear, conversational, and locally relevant.
You lead with the most interesting conflict, stakes, or "why this matters" angle in the article.
You NEVER add outside information, opinions, or invented facts.
You write like a neighbor sharing important local news, not a press release.`;

  const userPrompt = `Create an engaging Facebook news post using ONLY the information in the article text below.

HEADLINE (already written — copy it exactly, do not change):
${headline}

FORMAT YOUR RESPONSE AS:
1. The headline on its own line (copy exactly as-is)
2. A blank line
3. ONE hook sentence — rewrite the opening in a conversational way that draws readers in. Lead with the most interesting tension, conflict, or local stakes from ANYWHERE in the article (not just the first paragraph). Max 35 words. Should feel like a neighbor sharing news, not a wire service dispatch.
4. A blank line
5. 2–4 bullet points using • as the bullet character. Each bullet must be a complete, self-contained sentence. Prioritize surprising, specific, or locally impactful facts — especially ones found deeper in the article. If a fact is too long, rewrite it in fewer words — do NOT use … or ... to truncate.
6. A blank line
7. ONE closing sentence that hints at what is still unresolved or what comes next — leave readers wanting to click for the full story. Skip only if there is truly no unresolved element.
8. A blank line
9. Read more: ${url}
10. A blank line
11. ${hashtags}

RULES:
- Total post body: 80–140 words (not counting the headline, URL, and hashtags)
- Hook must lead with conflict, stakes, or local impact — not who filed what or procedural facts
- Mine the FULL article for compelling details, not just the opening sentences
- NEVER use … or ... anywhere — cut or rewrite instead of truncating
- Skip attorney names, judge names, and filing procedures unless they are the central point of the story
- Do NOT reproduce direct quotes longer than 6 words
- Make it slightly incomplete so readers click through for the full story

ARTICLE TEXT:
${sourceText.slice(0, 8000)}`;

  try {
    const result = (await env.AI.run(FB_MODEL, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      seed: 42,
      max_completion_tokens: 900,
    })) as { response?: string };

    const raw = (result?.response || '').trim();
    if (!raw || raw.length < 80) return algorithmicCaption;

    // Strip <think>...</think> reasoning blocks the model may emit
    let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!cleaned || cleaned.length < 80) return algorithmicCaption;

    // Rejoin sentences split across a paragraph break after an abbreviation —
    // handles both single and double newlines in the AI's output.
    cleaned = cleaned.replace(/([A-Z]\.)\n+([A-Za-z])/g, '$1 $2');

    // Remove any bullet truncated with an ellipsis (… or ...) — the model
    // should not produce these per the prompt, but strip as a safety net.
    cleaned = cleaned
      .replace(/^• [^\n]*(?:…|\.\.\.)\s*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return cleaned;
  } catch {
    return algorithmicCaption;
  }
}
