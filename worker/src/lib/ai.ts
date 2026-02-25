import type { SummaryResult } from '../types';
import { sha256Hex, wordCount } from './http';

const MODEL = '@cf/zai-org/glm-4.7-flash' as keyof AiModels;

type AiResultLike = {
  response?: string;
  result?: { response?: string };
  output_text?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
};

const SUMMARIZER_SYSTEM_PROMPT = `You are a professional news summarizer for a local Kentucky news platform.

Before summarizing, clean the input:
- Remove copyright notices, legal disclaimers, broadcast restrictions,
  bylines, author credits, and publication boilerplate.
- Remove section headers and subheadings. Incorporate any essential
  information from headers into the body paragraphs naturally.
- Remove any "CLICK HERE" text, promotional calls-to-action, or URLs.
- Remove related article titles, recommended video lists, sports scores,
  schedules, and any navigation or sidebar content.
- Remove social sharing labels (Facebook, Twitter, Threads, Flipboard, etc.)

Summarize the cleaned article to approximately 35–50% of its original
length. If the original article is under 400 words, cap your summary
at 200 words maximum.

Your summary must:
- Begin with who, what, where, and why this is newsworthy.
- Cover the full arc of the article from start to finish.
- Always end on a complete sentence. Never end mid-sentence or mid-thought.
- Be formatted as short, readable paragraphs of 2–3 sentences each.
  Never output a wall of unbroken text or a single long paragraph.
- Preserve important facts, names, locations, dates, and figures exactly.
- Include no more than one direct quote, only if it meaningfully adds
  to the story.

Your summary must never:
- Repeat, restate, or begin with the article title. Start directly with the first sentence of your summary.
- End mid-sentence under any circumstances. If you are approaching the
  word limit, finish the current sentence and stop cleanly.
- Output section headers, subheadings, or bolded titles of any kind.
- Output text as one unbroken paragraph.
- Include copyright notices, bylines, legal text, or publication footers.
- Include any "click here" text, "read more" links, or URLs of any kind.
- Include related article titles, video titles, sports scores, or schedules.
- Include social media sharing labels (Facebook, Twitter, Threads, etc.).
- Add facts, opinions, assumptions, or analysis not in the original.
- Exaggerate, soften, or reframe any statement.

Return clean, publication-ready paragraphs only. No headlines, labels,
bullet points, subheadings, URLs, or commentary.`;


export async function summarizeArticle(
  env: Env,
  cacheKeySuffix: string,
  title: string,
  content: string,
  publishedAt: string,
): Promise<SummaryResult> {
  const originalWords = Math.max(wordCount(content), 1);
  const summaryKey = `summary:${cacheKeySuffix}`;
  const ttlKey    = `summary-ttl:${cacheKeySuffix}`;

  if (env.CACHE) {
    try {
      // Check whether the TTL marker is still fresh
      const ttlMarker = await env.CACHE.get(ttlKey);
      // Always load the indefinitely-stored summary record (no TTL on this key)
      const existing = await env.CACHE.get<SummaryResult>(summaryKey, 'json');

      if (ttlMarker && existing?.summary && existing?.seoDescription) {
        // Within the freshness window — serve as-is
        return existing;
      }

      if (existing?.summary && existing.sourceHash) {
        // Freshness marker expired — check whether source content has changed
        const currentHash = await sha256Hex(content);
        if (currentHash === existing.sourceHash) {
          // Content unchanged — reset the TTL marker and return the existing summary
          const ttl = summaryTtl(publishedAt);
          await env.CACHE.put(ttlKey, '1', { expirationTtl: ttl });
          return existing;
        }
        // Content changed — fall through to regenerate
      }
    } catch {
      // best effort cache read
    }
  }

  // Compute source hash now (used in the stored result)
  const sourceHash = await sha256Hex(content).catch(() => '');
  const fallback = deterministicFallbackSummary(content, originalWords);

  let summary = fallback.summary;
  let seo = fallback.seoDescription;

  try {
    // Pre-clean content before sending to AI
    const cleanedContent = cleanContentForSummarization(content, title);
    const userPrompt = `Article:\n${cleanedContent.slice(0, 12_000)}`;

    const aiRaw = (await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      seed: 42,
      max_completion_tokens: 2000,
    })) as AiResultLike;

    const aiText = extractAiText(aiRaw).trim();
    if (aiText) {
      // Strip any boilerplate the AI may have echoed (title, CTAs, URLs)
      const cleaned = stripBoilerplateFromOutput(aiText, title);

      // 13.2 Length check: enforce 35–50% of original, or ≤200 words for short articles
      const aiWords = wordCount(cleaned);
      const minWords = Math.round(originalWords * 0.35);
      const maxWords = originalWords < 400
        ? 200
        : Math.round(originalWords * 0.50);

      let validatedText = cleaned;

      if (aiWords < minWords && aiWords < 30) {
        // Too short — fall back to deterministic (keeps the fallback already computed)
        validatedText = '';
      } else if (aiWords > maxWords) {
        // Too long — truncate at sentence boundary
        validatedText = truncateToSentenceBoundary(validatedText, maxWords);
      }

      // 13.1 Number/date validation: reject if AI introduced numbers not in the original
      if (validatedText && hasHallucinatedNumbers(content, validatedText)) {
        // New numeric values detected — fall back to deterministic to avoid misinformation
        validatedText = '';
      }

      if (validatedText) {
        // Always enforce a clean sentence ending regardless of length (Section 3.2)
        validatedText = ensureCompleteLastSentence(validatedText);
        summary = validatedText;
        seo = enforceSeoLength(extractFirstSentence(validatedText), validatedText);
      }
    }
  } catch {
    // best effort AI, fallback stays in place
  }

  seo = enforceSeoLength(seo, summary);

  const result: SummaryResult = {
    summary,
    seoDescription: seo,
    summaryWordCount: wordCount(summary),
    sourceHash,
  };

  if (env.CACHE) {
    try {
      const ttl = summaryTtl(publishedAt);
      // Store summary indefinitely (no TTL) so it survives the freshness-marker expiry
      await env.CACHE.put(summaryKey, JSON.stringify(result));
      // Store a lightweight freshness marker with the tiered TTL
      await env.CACHE.put(ttlKey, '1', { expirationTtl: ttl });
    } catch {
      // best effort cache write
    }
  }

  return result;
}

function extractAiText(payload: AiResultLike): string {
  return (
    payload.response ??
    payload.result?.response ??
    payload.output_text ??
    payload.choices?.[0]?.message?.content ??
    ''
  );
}

function extractFirstSentence(text: string): string {
  const match = text.match(/^.+?[.!?](?:\s|$)/s);
  return match ? match[0].trim() : text.slice(0, 160).trim();
}

function deterministicFallbackSummary(content: string, originalWords: number): {
  summary: string;
  seoDescription: string;
} {
  const target = clamp(Math.round(originalWords * 0.45), 30, 250);
  const words = content.split(/\s+/u).filter(Boolean);
  const raw = words.slice(0, target).join(' ').trim();
  const summary = ensureCompleteLastSentence(raw);

  return {
    summary,
    seoDescription: enforceSeoLength(summary.slice(0, 220), summary),
  };
}

function enforceSeoLength(input: string, summary: string): string {
  const base = (input || summary || '').replace(/\s+/g, ' ').trim();
  if (base.length <= 160) return base;

  const shortened = base.slice(0, 157).replace(/[\s,;:.!?-]+$/g, '');
  return `${shortened}...`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * Tiered KV TTL (freshness marker) based on article age:
 *   < 24 h  → 2 h   (active stories may still be updated)
 *   1–7 d   → 12 h  (mostly settled; check twice a day)
 *   > 7 d   → 72 h  (stable; check every 3 days)
 */
function summaryTtl(publishedAt: string): number {
  const ageMs = Date.now() - new Date(publishedAt).getTime();
  const ageHours = ageMs / (1000 * 3600);
  if (ageHours < 24)   return 7_200;    // 2 hours
  if (ageHours < 168)  return 43_200;   // 12 hours (7 days)
  return 259_200;                        // 72 hours
}

/**
 * Strip junk from article text before sending to AI:
 * - Removes the article title if it appears at the beginning
 * - Removes "CLICK HERE" calls-to-action
 * - Removes Fox News / publisher boilerplate lines
 * - Removes related-article link lists
 * - Removes sports score/schedule blocks
 * - Removes social sharing labels
 * Preserves paragraph structure (double newlines).
 */
function cleanContentForSummarization(text: string, title: string): string {
  let t = text;

  // Remove article title if it appears at the very start (case-insensitive)
  if (title) {
    const escaped = title.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`^\\s*${escaped}\\s*\n?`, 'i'), '');
  }

  // Publisher-specific boilerplate
  t = t.replace(/NEW\s*You can now listen to Fox News articles!?/gi, '');
  t = t.replace(/Add Fox News on Google\b[^\n]*/gi, '');
  t = t.replace(/^(?:Gesture|Agree|Like|Disagree|Love|Sad|Wow|Angry)\s*$/gim, '');

  // "CLICK HERE" CTA lines
  t = t.replace(/^CLICK HERE\b.+$/gim, '');

  // "RELATED:", "READ MORE:", "WATCH:", "SIGN UP:", etc.
  t = t.replace(/^(?:RELATED|READ MORE|MORE|SEE ALSO|WATCH|ALSO|SIGN UP|SUBSCRIBE|DOWNLOAD)[:\s].+$/gim, '');

  // Social sharing labels on their own line
  t = t.replace(/^(?:Facebook|Twitter|X|Threads|Flipboard|Comments|Print|Email|Share|Instagram)\s*$/gim, '');

  // Bylines: "By Author Name Fox News" / "By Author Name AP"
  t = t.replace(/^By\s+[A-Z][a-zA-Z .'-]{2,60}(?:Fox News|AP|Reuters|Staff|Reporter|Digital|Correspondent)?.*$/gm, '');

  // "Published [date]" lines
  t = t.replace(/^Published\s+\w+\s+\d{1,2},\s+\d{4}.*$/gmi, '');

  // "Here is / Source: / Original article: URL" lines
  t = t.replace(/^(?:Here is the original article|Source|Original article|Read more at)[:\s]+https?:\/\/\S+.*$/gim, '');

  // All-caps CTA headlines (>= 5 words, e.g. "HUGHES' BROTHERS MOM, WHO WORKS FOR TEAM USA...")
  // Keep lines that are short (team names, cities) but strip long promo caps
  t = t.replace(/^[A-Z][A-Z0-9\s'",.!?\-\u2013\u2014]{30,}$/gm, '');

  // Sports score/schedule blocks — detect by "NCAA \w+" or league abbreviations alone on a line
  t = t.replace(/^(?:NCAA\s+\w+|NFL|NBA|NHL|MLB|MLS|PWHL|WNBA)\s*$/gm, '');
  // Betting odds / totals
  t = t.replace(/^(?:TOTAL\s+[\d.]+|[A-Z]{2,6}\s+-?[\d.]+)\s*$/gm, '');
  // Standalone time patterns "7:00PM"
  t = t.replace(/^\d{1,2}:\d{2}\s*(?:AM|PM)\s*$/gim, '');
  // Network name alone on a line (FS1, ESPN, PCOCK, etc.)
  t = t.replace(/^(?:FS1|ESPN[U2]?|CBS|NBC|ABC|TNT|TBS|BALLY|PEACOCK|PCOCK|MSG|NESN|RSN)\s*$/gm, '');

  // "Recommended Videos" / "Recommended Articles" header — strip it and everything after
  t = t.replace(/^(?:Recommended Videos?|Recommended Articles?|More from|Related Stories?|Related Articles?|Watch more|You may also like)\s*$[\s\S]*/gim, '');

  // Duplicate consecutive lines (Fox News often repeats article titles)
  t = t.replace(/^(.+)\n\1$/gm, '$1');

  // Collapse 3+ blank lines
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

/**
 * Strip common boilerplate that the AI may have echoed into its output:
 * - Article title at the start
 * - "CLICK HERE" CTAs
 * - "Here is the original article: URL" lines
 * - Social sharing / navigation labels
 */
function stripBoilerplateFromOutput(text: string, title: string): string {
  let t = text;

  // Remove article title if AI started with it
  if (title) {
    const escaped = title.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`^\\s*${escaped}\\s*\n?`, 'i'), '');
  }

  // Remove any "CLICK HERE" lines the AI echoed
  t = t.replace(/^CLICK HERE\b.+$/gim, '');

  // Remove any "Here is the original article: URL" echoed by AI
  t = t.replace(/^(?:Here is the original article|Source|Original article)[:\s]+https?:\/\/\S+.*$/gim, '');

  // Remove raw URLs on their own line
  t = t.replace(/^https?:\/\/\S+\s*$/gm, '');

  // Collapse blank lines
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

/**
 * Ensure a block of text ends on a complete sentence.
 * If the last character is not sentence-ending punctuation, trim back to the
 * previous sentence boundary. Applied to every summary regardless of length.
 */
function ensureCompleteLastSentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  // Already ends cleanly
  if (/[.!?'"\u201d\u2019]$/.test(t)) return t;
  // Find the last sentence-ending punctuation followed by a space (or end of string)
  const lastEnd = Math.max(
    t.lastIndexOf('. '),
    t.lastIndexOf('! '),
    t.lastIndexOf('? '),
    t.lastIndexOf('.\n'),
    t.lastIndexOf('!\n'),
    t.lastIndexOf('?\n'),
  );
  if (lastEnd > 0) {
    return t.slice(0, lastEnd + 1).trim();
  }
  // Single-sentence text with no trailing period — add one only if it ends with a word char
  if (/\w$/.test(t)) return `${t}.`;
  return t;
}

/**
 * Truncate text at a sentence boundary at or before maxWords.
 * Ensures the summary never ends mid-sentence (Section 13.2).
 */
function truncateToSentenceBoundary(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;

  // Join only up to maxWords, then find the last sentence-ending punctuation
  const candidate = words.slice(0, maxWords).join(' ');
  // Walk backward to find a sentence end
  const sentenceEndIdx = Math.max(
    candidate.lastIndexOf('. '),
    candidate.lastIndexOf('! '),
    candidate.lastIndexOf('? '),
    candidate.lastIndexOf('.\n'),
  );
  if (sentenceEndIdx > 0) {
    return candidate.slice(0, sentenceEndIdx + 1).trim();
  }
  // Fallback: return the candidate as-is (may not end on period)
  return candidate.trim();
}

/**
 * Check whether the AI summary introduced numeric values (including years,
 * percentages, counts, dollar amounts) that did not appear in the original.
 * Returns true if the summary contains hallucinated numbers.
 * Section 13.1: reject if numerical values differ.
 */
function hasHallucinatedNumbers(original: string, summary: string): boolean {
  // Extract all distinct number tokens from both texts
  const extractNums = (text: string): Set<string> => {
    const matches = text.match(/\b\d[\d,._]*%?(?:\s*(?:million|billion|thousand))?\b/gi) ?? [];
    return new Set(matches.map((n) => n.toLowerCase().replace(/,/g, '')));
  };

  const originalNums = extractNums(original);
  const summaryNums = extractNums(summary);

  for (const num of summaryNums) {
    if (!originalNums.has(num)) {
      // Allow pure year values (4-digit) if they appear anywhere in the original text
      // since OCR/scraping sometimes formats them differently (e.g. 2026 vs 2,026)
      const asYear = num.replace(/,/g, '');
      if (/^\d{4}$/.test(asYear) && original.includes(asYear)) continue;
      return true;
    }
  }
  return false;
}
