import type { SummaryResult } from '../types';
import { sha256Hex, wordCount } from './http';
import { decodeHtmlEntities } from './scrape';

const MODEL = '@cf/zai-org/glm-4.7-flash' as keyof AiModels;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AiResultLike = {
  response?: string;
  result?: { response?: string };
  output_text?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
};

/** Stored in KV under feedback:<summaryKey> */
export type SummaryFeedback = {
  upvotes: number;
  downvotes: number;
  flaggedForRegeneration: boolean;
  lastVotedAt: string;
};

/** Stored in KV under correction:<summaryKey> — editor rewrites */
export type SummaryCorrection = {
  original: string;
  corrected: string;
  savedAt: string;
};

/** Stored in KV under learn:blacklist — global bad patterns */
type BlacklistStore = {
  patterns: string[];           // human-readable pattern descriptions
  updatedAt: string;
};

/** Stored in KV under learn:corrections-index — ordered list of recent correction keys */
type CorrectionsIndex = {
  keys: string[];               // up to MAX_CORRECTIONS_STORED summaryKeys
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Learning constants
// ---------------------------------------------------------------------------

/** How many downvotes before a summary is auto-flagged for regeneration */
const DOWNVOTES_BEFORE_REGENERATION = 2;

/** How many recent editor corrections to inject as few-shot examples */
const FEW_SHOT_EXAMPLES = 3;

/** Maximum number of correction examples to keep in the index */
const MAX_CORRECTIONS_STORED = 20;

/** Maximum number of blacklist patterns to carry in the system prompt */
const MAX_BLACKLIST_PATTERNS = 10;

// ---------------------------------------------------------------------------
// Base system prompt (static part)
// ---------------------------------------------------------------------------

const BASE_SYSTEM_PROMPT = `You are a professional news summarizer for a local Kentucky news platform.

Before summarizing, clean the input:
- Remove copyright notices, legal disclaimers, broadcast restrictions,
  bylines, author credits, and publication boilerplate.
- Remove section headers and subheadings. Incorporate any essential
  information from headers into the body paragraphs naturally.
- Remove any "CLICK HERE" text, promotional calls-to-action, or URLs.
- Remove related article titles, recommended video lists, sports scores,
  schedules, and any navigation or sidebar content.
- Remove social sharing labels (Facebook, Twitter, Threads, Flipboard, etc.)

Summarize the cleaned article to approximately 70–80% of its original
length. If the original article is under 400 words, cap your summary
at 350 words maximum.

Your summary must:
- Begin with a single, fully self-contained sentence that states the core fact of the article: who did what, where, and when — without relying on the headline for context. This sentence must be quotable on its own as a complete answer to the question "what happened?" Example of correct first sentence: "The Harlan County School Board voted 4–1 on March 5 to close Harlan Middle School at the end of the 2025–26 school year." Example of incorrect first sentence: "The board voted to close the school after months of deliberation." (requires headline to understand who and where)
- Cover the full arc of the article from start to finish.
- Always end on a complete sentence. Never end mid-sentence or mid-thought.
- Be formatted as short, readable paragraphs of 2–3 sentences each.
  Never output a wall of unbroken text or a single long paragraph.
  Every paragraph must be separated from the next by a blank line.
  A summary of more than 6 sentences MUST contain at least 2 paragraph breaks (\n\n).
- Preserve important facts, names, locations, dates, and figures exactly.
- Include no more than one direct quote, only if it meaningfully adds
  to the story.

Your summary must never:
- Repeat, restate, or begin with the article title. Start directly with the first sentence of your summary.
- End mid-sentence under any circumstances. If you are approaching the
  word limit, finish the current sentence and stop cleanly.
- Output section headers, subheadings, or bolded titles of any kind.
- Output text as one unbroken paragraph. Use blank lines (\n\n) between every 2–3 sentences.
- Include copyright notices, bylines, legal text, or publication footers.
- Include any "click here" text, "read more" links, or URLs of any kind.
- Include navigation text such as "Click below to jump to" or anchor links.
- Include related article titles, video titles, sports scores, or schedules.
- Include social media sharing labels (Facebook, Twitter, Threads, etc.).
- Add facts, opinions, assumptions, or analysis not in the original.
- Exaggerate, soften, or reframe any statement.
- Split a direct quote across paragraphs — if a quote spans a line break in the source, keep it as a single uninterrupted sentence in your output.
- Begin with a pronoun or article ("The board...", "Officials said...") when the subject has not been named. Always name the specific entity (board, person, organization) and its location in the first sentence.

Return clean, publication-ready paragraphs only. No headlines, labels,
bullet points, subheadings, URLs, or commentary.`;

// ---------------------------------------------------------------------------
// Dynamic system prompt builder
// ---------------------------------------------------------------------------

/**
 * Builds a system prompt enriched with:
 *   1. Learned blacklist rules (extracted from downvoted summaries)
 *   2. Few-shot style examples (from editor corrections)
 */
async function buildSystemPrompt(env: Env): Promise<string> {
  let prompt = BASE_SYSTEM_PROMPT;

  // 1. Inject blacklist rules learned from bad summaries
  try {
    const blacklistRaw = await env.CACHE.get<BlacklistStore>('learn:blacklist', 'json');
    const patterns = blacklistRaw?.patterns ?? [];
    if (patterns.length > 0) {
      const rules = patterns
        .slice(-MAX_BLACKLIST_PATTERNS)
        .map((p) => `- ${p}`)
        .join('\n');
      prompt += `\n\nAdditional rules learned from past quality issues — follow these strictly:\n${rules}`;
    }
  } catch {
    // best effort
  }

  // 2. Inject few-shot editor correction examples
  try {
    const indexRaw = await env.CACHE.get<CorrectionsIndex>('learn:corrections-index', 'json');
    const recentKeys = (indexRaw?.keys ?? []).slice(-FEW_SHOT_EXAMPLES);

    const examples: SummaryCorrection[] = [];
    for (const key of recentKeys) {
      try {
        const c = await env.CACHE.get<SummaryCorrection>(`correction:${key}`, 'json');
        if (c?.original && c?.corrected) examples.push(c);
      } catch {
        // skip missing entries
      }
    }

    if (examples.length > 0) {
      const shots = examples
        .map(
          (ex, i) =>
            `Example ${i + 1}:\nDraft: ${ex.original.slice(0, 400)}\nImproved: ${ex.corrected.slice(0, 400)}`,
        )
        .join('\n\n');
      prompt += `\n\nBelow are recent examples of editor-improved summaries. Study the style and apply it:\n\n${shots}`;
    }
  } catch {
    // best effort
  }

  return prompt;
}

// ---------------------------------------------------------------------------
// Public API — summarization
// ---------------------------------------------------------------------------

export async function summarizeArticle(
  env: Env,
  cacheKeySuffix: string,
  title: string,
  content: string,
  publishedAt: string,
): Promise<SummaryResult> {
  const cleanedSourceContent = cleanContentForSummarization(content, title);
  const sourceForSummary = cleanedSourceContent || content;

  // Articles that are purely scores/schedule tables cannot be meaningfully summarized
  if (isScheduleOrScoresArticle(sourceForSummary)) {
    const notice = 'This article consists primarily of game schedules or scores and does not contain enough narrative text to summarize.';
    return {
      summary: notice,
      seoDescription: notice,
      summaryWordCount: wordCount(notice),
      sourceHash: '',
    };
  }

  const originalWords = Math.max(wordCount(sourceForSummary), 1);
  const summaryKey = `summary:${cacheKeySuffix}`;
  const ttlKey    = `summary-ttl:${cacheKeySuffix}`;

  if (env.CACHE) {
    try {
      const ttlMarker = await env.CACHE.get(ttlKey);
      const existing = await env.CACHE.get<SummaryResult>(summaryKey, 'json');

      if (ttlMarker && existing?.summary && existing?.seoDescription) {
        // Within the freshness window — but check if it's flagged for regeneration
        const feedbackRaw = await env.CACHE.get<SummaryFeedback>(`feedback:${cacheKeySuffix}`, 'json');
        if (!feedbackRaw?.flaggedForRegeneration) {
          return existing;
        }
        // Flagged — fall through to regenerate
      }

      if (existing?.summary && existing.sourceHash) {
        const currentHash = await sha256Hex(sourceForSummary);
        if (currentHash === existing.sourceHash) {
          // Check regeneration flag even on hash-match
          const feedbackRaw = await env.CACHE.get<SummaryFeedback>(`feedback:${cacheKeySuffix}`, 'json');
          if (!feedbackRaw?.flaggedForRegeneration) {
            const ttl = summaryTtl(publishedAt);
            await env.CACHE.put(ttlKey, '1', { expirationTtl: ttl });
            return existing;
          }
          // Flagged — fall through to regenerate
        } else {
          // source hash changed since last cache; wipe TTL marker so we rebuild
          await env.CACHE.delete(ttlKey).catch(() => {});
        }
      }
    } catch {
      // best effort cache read
    }
  }

  const sourceHash = await sha256Hex(sourceForSummary).catch(() => '');
  const fallback = deterministicFallbackSummary(sourceForSummary, originalWords);

  let summary = fallback.summary;
  let seo = fallback.seoDescription;

  try {
    // Build prompt enriched with learned rules and style examples
    const systemPrompt = env.CACHE
      ? await buildSystemPrompt(env)
      : BASE_SYSTEM_PROMPT;

    const userPrompt = `Article:\n${sourceForSummary.slice(0, 12_000)}`;

    const aiRaw = (await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      seed: 42,
      max_completion_tokens: 4000,
    })) as AiResultLike;

    const aiText = extractAiText(aiRaw).trim();
    if (aiText) {
      const cleaned = enforceparagraphBreaks(stripBoilerplateFromOutput(aiText, title));

      const aiWords = wordCount(cleaned);
      const minWords = Math.round(originalWords * 0.60);
      const maxWords = originalWords < 400
        ? 350
        : Math.round(originalWords * 0.80);

      let validatedText = cleaned;

      if (aiWords < minWords && aiWords < 30) {
        validatedText = '';
      } else if (aiWords > maxWords) {
        validatedText = truncateToSentenceBoundary(validatedText, maxWords);
      }

      if (validatedText && hasHallucinatedNumbers(sourceForSummary, validatedText)) {
        validatedText = '';
      }

      if (validatedText) {
        validatedText = ensureCompleteLastSentence(validatedText);
        validatedText = fixLeadingParagraphPunctuation(validatedText);
        // decode HTML entities before checking for malformed output so that
        // &amp; and similar tokens don't trigger unnecessary regeneration.
        const decoded = decodeHtmlEntities(validatedText);
        if (!isMalformedSummary(decoded)) {
          summary = decoded;
          seo = enforceSeoLength(extractFirstSentence(decoded), decoded);
        }
      }
    }
  } catch (err) {
    // best effort AI, fallback stays in place
    console.warn('[SUMMARIZE FALLBACK]', err instanceof Error ? err.message : String(err));
  }

  summary = stripBoilerplateFromOutput(summary, title);
  summary = normalizeParagraphBoundaries(summary);
  summary = fixLeadingParagraphPunctuation(ensureCompleteLastSentence(summary));
  seo = enforceSeoLength(seo, summary);

  // ensure first letter of summary and seo description are capitalized
  if (summary.length > 0) {
    summary = summary.charAt(0).toUpperCase() + summary.slice(1);
  }
  if (seo.length > 0) {
    seo = seo.charAt(0).toUpperCase() + seo.slice(1);
  }

  const result: SummaryResult = {
    summary,
    seoDescription: seo,
    summaryWordCount: wordCount(summary),
    sourceHash,
  };

  if (env.CACHE) {
    try {
      const ttl = summaryTtl(publishedAt);
      await env.CACHE.put(summaryKey, JSON.stringify(result));
      await env.CACHE.put(ttlKey, '1', { expirationTtl: ttl });

      // Clear the regeneration flag now that we've freshly generated
      await clearRegenerationFlag(env, cacheKeySuffix);
    } catch {
      // best effort cache write
    }
  }

  return result;
}

/**
 * Given the updated article text and the existing summary,
 * generates a concise "Update:" paragraph covering only the
 * new information not present in the existing summary.
 *
 * Returns null if:
 *  - The AI determines there is no meaningful new information
 *  - The new content is not substantively different
 *  - AI call fails
 *
 * @param env         Worker environment
 * @param newContent  Full text of the updated article
 * @param existingSummary  The summary already stored in D1
 * @param publishedAt ISO date string for TTL calculation
 */
export async function generateUpdateParagraph(
  env: Env,
  newContent: string,
  existingSummary: string,
  publishedAt: string,
): Promise<string | null> {
  try {
    const systemPrompt = `You are a news editor. You will be given an updated article and the existing summary of the original version.

Your task: write a single concise "Update" paragraph (2-4 sentences max) covering ONLY the new information in the updated article that is NOT already covered in the existing summary.

Rules:
- Start with exactly "Update: " followed by the new information
- Do NOT repeat anything already in the existing summary
- Do NOT use phrases like "the article was updated" or "new information shows"
- If there is no meaningful new information, respond with exactly: NO_UPDATE
- Write in past tense, third person, plain news style
- Be specific: include names, numbers, charges, and facts from the update
- Maximum 60 words`;

    const userPrompt = `Existing summary:
${existingSummary}

Updated article content:
${newContent.slice(0, 8000)}`;

    const aiRaw = (await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      seed: 42,
      max_completion_tokens: 200,
    })) as AiResultLike;

    const text = extractAiText(aiRaw).trim();

    if (!text || text === 'NO_UPDATE' || text.includes('NO_UPDATE')) {
      return null;
    }

    // Must start with "Update" to be valid
    if (!/^update\b/i.test(text)) {
      return null;
    }

    // Strip any "Update: " prefix the AI added since we'll add our own
    // timestamped prefix when prepending to the summary
    return text.replace(/^update\s*:\s*/i, '').trim();

  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API — feedback loop (thumbs up / down)
// ---------------------------------------------------------------------------

/**
 * Record user feedback on a summary.
 *
 * - Upvotes are logged for future analytics.
 * - After DOWNVOTES_BEFORE_REGENERATION downvotes the summary is flagged so
 *   the next call to summarizeArticle() bypasses the cache and regenerates.
 * - Frequent bad patterns from downvoted summaries are extracted and stored
 *   in the global blacklist so the AI avoids them in future runs.
 *
 * @example
 *   // In your Hono/itty-router handler:
 *   await recordFeedback(env, articleSlug, 'down');
 */
export async function recordFeedback(
  env: Env,
  cacheKeySuffix: string,
  vote: 'up' | 'down',
): Promise<void> {
  if (!env.CACHE) return;

  const feedbackKey = `feedback:${cacheKeySuffix}`;

  try {
    const existing = await env.CACHE.get<SummaryFeedback>(feedbackKey, 'json') ?? {
      upvotes: 0,
      downvotes: 0,
      flaggedForRegeneration: false,
      lastVotedAt: '',
    };

    if (vote === 'up') {
      existing.upvotes += 1;
    } else {
      existing.downvotes += 1;

      // Flag for regeneration once we hit the threshold
      if (existing.downvotes >= DOWNVOTES_BEFORE_REGENERATION) {
        existing.flaggedForRegeneration = true;

        // Learn from this bad summary — extract patterns and add to blacklist
        await learnFromDownvotedSummary(env, cacheKeySuffix);
      }
    }

    existing.lastVotedAt = new Date().toISOString();
    // Store feedback indefinitely (no TTL) so quality signals are never lost
    await env.CACHE.put(feedbackKey, JSON.stringify(existing));
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Public API — editor correction (style learning)
// ---------------------------------------------------------------------------

/**
 * Store an editor-corrected summary as a few-shot training example.
 *
 * Call this whenever an editor saves a rewritten version of a summary.
 * The before/after pair is stored in KV and injected into future prompts
 * so the AI learns your publication's house style over time.
 *
 * @example
 *   // In your CMS save handler:
 *   await recordCorrection(env, articleSlug, editorRewrittenText);
 */
export async function recordCorrection(
  env: Env,
  cacheKeySuffix: string,
  correctedSummary: string,
): Promise<void> {
  if (!env.CACHE) return;

  try {
    // Load the original generated summary
    const existing = await env.CACHE.get<SummaryResult>(`summary:${cacheKeySuffix}`, 'json');
    if (!existing?.summary) return;

    // Don't store trivial corrections (less than 10 chars difference)
    if (Math.abs(existing.summary.length - correctedSummary.length) < 10) return;

    const correction: SummaryCorrection = {
      original: existing.summary,
      corrected: correctedSummary,
      savedAt: new Date().toISOString(),
    };

    // Store the before/after pair
    await env.CACHE.put(`correction:${cacheKeySuffix}`, JSON.stringify(correction));

    // Update the rolling index of recent corrections
    await updateCorrectionsIndex(env, cacheKeySuffix);

    // Immediately persist the editor's version as the live summary
    const updated: SummaryResult = {
      ...existing,
      summary: correctedSummary,
      seoDescription: enforceSeoLength(extractFirstSentence(correctedSummary), correctedSummary),
      summaryWordCount: wordCount(correctedSummary),
    };
    await env.CACHE.put(`summary:${cacheKeySuffix}`, JSON.stringify(updated));
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Internal — learning helpers
// ---------------------------------------------------------------------------

/**
 * Analyse a downvoted summary and append detected bad patterns to the
 * global blacklist that is injected into future system prompts.
 */
async function learnFromDownvotedSummary(env: Env, cacheKeySuffix: string): Promise<void> {
  try {
    const summaryRaw = await env.CACHE.get<SummaryResult>(`summary:${cacheKeySuffix}`, 'json');
    if (!summaryRaw?.summary) return;

    const text = summaryRaw.summary;
    const detectedPatterns: string[] = [];

    // Pattern: starts with the word "Summary"
    if (/^\s*Summary\b/i.test(text)) {
      detectedPatterns.push('Never start the output with the word "Summary"');
    }

    // Pattern: broken initialism like "S. They" at the start of a line
    if (/(?:^|\n)[A-Z]\.\s+[A-Z]/.test(text)) {
      detectedPatterns.push('Never split initialisms like U.S. or U.K. across line breaks — always keep them whole on a single line');
    }

    // Pattern: wall of text (no paragraph breaks and > 100 words)
    if (!text.includes('\n\n') && wordCount(text) > 100) {
      detectedPatterns.push('Always separate the summary into short paragraphs of 2–3 sentences with a blank line between each paragraph');
    }

    // Pattern: ends mid-sentence (no terminal punctuation)
    if (!/[.!?'"\u201d\u2019]$/.test(text.trim())) {
      detectedPatterns.push('Always end the summary on a complete sentence with terminal punctuation (.  !  ?)');
    }

    // Pattern: contains paywall prompts
    if (/listen to this article/i.test(text)) {
      detectedPatterns.push('Never include "Listen to this article" or any paywall / subscription prompts');
    }

    // Pattern: contains raw URLs or "click here"
    if (/click here|https?:\/\//i.test(text)) {
      detectedPatterns.push('Never include "click here" text or raw URLs in the summary');
    }

    if (detectedPatterns.length === 0) return;

    // Merge with existing blacklist, dedup, cap at MAX_BLACKLIST_PATTERNS
    const existing = await env.CACHE.get<BlacklistStore>('learn:blacklist', 'json') ?? {
      patterns: [],
      updatedAt: '',
    };

    const merged = Array.from(new Set([...existing.patterns, ...detectedPatterns]));
    const trimmed = merged.slice(-MAX_BLACKLIST_PATTERNS);

    await env.CACHE.put(
      'learn:blacklist',
      JSON.stringify({ patterns: trimmed, updatedAt: new Date().toISOString() }),
    );
  } catch {
    // best effort
  }
}

/** Maintain a rolling index of summaryKeys that have editor corrections. */
async function updateCorrectionsIndex(env: Env, cacheKeySuffix: string): Promise<void> {
  try {
    const existing = await env.CACHE.get<CorrectionsIndex>('learn:corrections-index', 'json') ?? {
      keys: [],
      updatedAt: '',
    };

    // Remove if already present (will re-add at end as most recent)
    const filtered = existing.keys.filter((k) => k !== cacheKeySuffix);
    filtered.push(cacheKeySuffix);

    // Keep only the most recent MAX_CORRECTIONS_STORED entries
    const trimmed = filtered.slice(-MAX_CORRECTIONS_STORED);

    await env.CACHE.put(
      'learn:corrections-index',
      JSON.stringify({ keys: trimmed, updatedAt: new Date().toISOString() }),
    );
  } catch {
    // best effort
  }
}

/** Clear the regeneration flag after a summary has been freshly generated. */
async function clearRegenerationFlag(env: Env, cacheKeySuffix: string): Promise<void> {
  try {
    const feedbackKey = `feedback:${cacheKeySuffix}`;
    const existing = await env.CACHE.get<SummaryFeedback>(feedbackKey, 'json');
    if (existing?.flaggedForRegeneration) {
      existing.flaggedForRegeneration = false;
      await env.CACHE.put(feedbackKey, JSON.stringify(existing));
    }
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Internal — AI text extraction
// ---------------------------------------------------------------------------

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
  const target = clamp(Math.round(originalWords * 0.75), 30, 900);
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
  if (ageHours < 24)   return 7_200;
  if (ageHours < 168)  return 43_200;
  return 259_200;
}

/**
 * Returns true when an article consists primarily of scores/schedules tables
 * with insufficient narrative prose to produce a meaningful summary.
 * When true, summarizeArticle will return a canned notice instead of
 * sending junk to the AI.
 */
export function isScheduleOrScoresArticle(text: string): boolean {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 5) return false;

  // Score-like lines: "Team A vs Team B", "Team A 72, Team B 68", time + channel
  const scoreLine = /\b(?:vs\.?|at|def\.?|defeated)\b|\b\d{1,3}[-–]\d{1,3}\b/i;
  const timeLine = /^\d{1,2}:\d{2}\s*(?:am|pm)/i;
  const channelLine = /^(?:FS\d?|ESPN[U2]?|CBS|NBC|ABC|TNT|TBS|BALLY|PEACOCK|MSG|NESN)\s*$/i;

  // Betting PREVIEW / ODDS articles: must have actual odds/picks language,
  // not just brand mentions or general discussion of the gambling industry.
  const hasBettingOddsLanguage =
    /\b(?:spread|over\/under|money\s*line|point\s*spread|promo\s*code|(?:ATS|SU)\s+record|SportsLine|covers\.com|action\s+network)\b/i.test(text);
  const hasBettingPickLanguage =
    /\b(?:our\s+(?:pick|model|prediction)|expert\s+pick|best\s+bet|free\s+pick|against\s+the\s+spread|ATS\s+(?:pick|record)|(?:take|lean|side)\s+(?:the|with)\s+[A-Z])\b/i.test(text);
  const isBettingArticle = hasBettingOddsLanguage && hasBettingPickLanguage;

  if (isBettingArticle) return true;

  let scoreCount = 0;
  let narrativeCount = 0;

  for (const line of lines) {
    if (scoreLine.test(line) || timeLine.test(line) || channelLine.test(line)) {
      scoreCount++;
    } else if (line.split(/\s+/).length >= 8) {
      // Lines with 8+ words are likely narrative prose
      narrativeCount++;
    }
  }

  // Flag as scores-only if score/schedule lines outnumber narrative lines 3-to-1
  // and there are at least 6 score lines
  return scoreCount >= 6 && scoreCount > narrativeCount * 3;
}

/**
 * Strip junk from article text before sending to AI.
 */
export function cleanContentForSummarization(text: string, title: string): string {
  let t = decodeHtmlEntities(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n');

  // Remove slideshow photo caption blocks: "1/22 Some caption text. (Photographer / Publication)"
  // The caption runs from the slide counter to the closing parenthesized credit.
  // Must handle hyphens, commas, periods, digits in the caption text.
  t = t.replace(/(^|\n)\s*\d+\/\d+\s[^\n]*?\([^)]{3,80}\/[^)]{3,80}\)\s*/g, '$1');
  // Also strip any remaining bare slide counters that had no credit: "3/22 Caption text\n"
  t = t.replace(/(^|\n)\s*\d+\/\d+\s[^\n]{0,300}\n/g, '$1\n');

  // Strip TV station nav/header junk scraped before the article body
  // e.g. "Skip to content News Livestreams Weather alert(B137 / Wikipedia / CC BY-SA 4.0)"
  t = t.replace(/^Skip\s+to\s+content\b[^\n]*/gim, '');
  // Strip image attribution caption lines e.g. "Traffic alert(B137 / Wikipedia / CC BY-SA 4.0)"
  t = t.replace(/^[^\n]{3,80}\([A-Z][^)]{3,60}\/\s*(?:Wikipedia|CC\s+BY|Wikimedia|AP|Getty|Reuters)[^)]*\)\s*$/gm, '');
  // Strip "Source: ORG." image credit prefix lines e.g. "Source: SKYCTC."
  t = t.replace(/^Source:\s*[A-Za-z0-9_.\-]{1,40}\.\s*/gim, '');

  if (title) {
    const escaped = title.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`^\\s*${escaped}\\s*\n?`, 'i'), '');
  }

  // Strip short heading-like lines that appear before the dateline — these are
  // image alt text or duplicate captions from broadcast CMS pages (e.g. LEX18,
  // WKYT). They look like the article title but are not exact matches.
  // A "caption-like" line: 3–12 words, appears before the first dateline, no verb tense.
  // Strip lines matching: appears before "CITY, Ky. (..." or "CITY, KY —" dateline.
  t = t.replace(
    /^[^\n]{10,120}\n(?=[A-Z][A-Z\s]{1,25},\s*(?:Ky|KY|KENTUCKY)[\s.,])/gm,
    '',
  );
  // Also strip the "(LEX 18) —", "(WKYT)" etc. broadcaster attribution that
  // prefixes the actual article body after a dateline.
  t = t.replace(/\b\((?:LEX\s*18|WKYT|WKYT-TV|WLWT|WHAS11?|WDRB|WBKO|WNKY|WYMT|WTVQ|ABC\s*36|FOX\s*56|WAVE\s*3|NBC)\)\s*[-—–]?\s*/gi, '');
  // Strip Envato/stock photo caption lines before they reach the AI
  // e.g. "Shot of a doctor examining a man. Source: Envato/by YuriArcursPeopleimages."
  t = t.replace(/^[^\n]{10,300}(?:Source:\s*Envato|Getty\s*Images?|iStock|Shutterstock|AP\s*Photo)[^\n]*\n?/gim, '');

  t = t.replace(/^\s*Summary\s*$/gim, '');

  // Publisher-specific boilerplate
  t = t.replace(/Listen to this article with a (?:free|paid)?\s*account[^\n]*/gi, '');
  t = t.replace(/NEW\s*You can now listen to Fox News articles!?/gi, '');
  t = t.replace(/Add Fox News on Google\b[^\n]*/gi, '');
  t = t.replace(/^(?:Gesture|Agree|Like|Disagree|Love|Sad|Wow|Angry)\s*$/gim, '');

  t = t.replace(
    /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2},? \d{4}[\s|,]+\d{1,2}:\d{2}\s*(?:am|pm)\s*(?:et|ct|mt|pt|est|cst|mst|pst|edt|cdt|mdt|pdt)?\s*(?:share)?\s*$/gim,
    '',
  );

  t = t.replace(
    /^[A-Z][a-zA-Z]+ (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2},? \d{4} \d{1,2}:\d{2}\s*(?:am|pm)\s*(?:et|ct|mt|pt|est|cst|mst|pst|edt|cdt|mdt|pdt)?\s*$/gim,
    '',
  );

  t = t.replace(/^\d+ (?:second|minute|hour|day|week|month)s? ago\s*$/gim, '');
  t = t.replace(/^CLICK HERE\b.+$/gim, '');
  t = t.replace(/^Click below to jump to[:\s].+$/gim, '');
  t = t.replace(/^(?:RELATED|READ MORE|MORE|SEE ALSO|WATCH|ALSO|SIGN UP|SUBSCRIBE|DOWNLOAD)[:\s].+$/gim, '');
  // Strip WordPress category navigation menus — vertical lists of nav labels
  // that appear at the top of scraped content from sites like nkytribune.com
  t = t.replace(
    /^(?:(?:Business|Education|Government|Health|Living|News|NonProfit|Region\/State|Sports|Voices|About|Contact|Subscribe|Advertise|Events|Opinion|Community|Politics|Economy|Environment|Science|Technology|Culture|Arts|Entertainment|Local|National|World|Weather|Obituaries|Jobs|Classifieds)\s*\n){2,}/i,
    '',
  );
  // Strip standalone "Home » Category » " breadcrumb lines that remain after the nav strip
  t = t.replace(/^(?:Home\s*[»›>|]\s*)+[^.!?\n]{0,120}(?:[»›>|][^.!?\n]{0,120})*\n?/im, '');
  t = t.replace(/^(?:Facebook|Twitter|X|Threads|Flipboard|Comments|Print|Email|Share|Instagram)\s*$/gim, '');
  t = t.replace(/^By\s+[A-Z][a-zA-Z .'-]{2,60}(?:Fox News|AP|Reuters|Staff|Reporter|Digital|Correspondent)?.*$/gm, '');
  t = t.replace(
    /^Published\s+\d{1,2}:\d{2}\s*(?:am|pm)\s+\w+,\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},\s+\d{4}.*$/gim,
    '',
  );
  t = t.replace(/^Published\b[^\n]*$/gim, '');
  t = t.replace(/^Updated\b[^\n]*$/gim, '');
  // Strip "Editorial Standards ⓘ" lines (Hearst TV / WLKY / WHAS11 / WLWT)
  t = t.replace(/^Editorial\s+Standards\s*[ⓘℹ️©®]?\s*$/gim, '');
  t = t.replace(/\bEditorial\s+Standards\s*[ⓘℹ️©®]?\s*/gi, '');

  // Strip lazy-load image attribute leakage: data-src=https://... loading=lazy src=https://...
  // These appear in lex18/Scripps articles when the HTML img tag bleeds into scraped text
  t = t.replace(/\bdata-src=https?:\/\/\S+\s+loading=\S+\s+src=https?:\/\/\S+/gi, '');
  t = t.replace(/\bdata-src=https?:\/\/\S+/gi, '');
  t = t.replace(/\bloading=(?:lazy|eager)\s*/gi, '');

  // Strip box score / stat table lines: lines that look like player stat rows
  // e.g. "Wells 8-12 0-0 10-12 26, Robinson 8-17 5-10 1-2 22"
  // and lines that are pure shooting stats: "Totals: 33-67 14-28 16-21 — 96"
  t = t.replace(/^(?:[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?\s+\d+-\d+[^,\n]*,?\s*){3,}$/gm, '');
  t = t.replace(/^(?:Totals?|TOTAL)[:\s]+[\d\s\-–—\/]+.*$/gim, '');
  // Strip scoring summary headers: "NKU 36 60 — 96"
  t = t.replace(/^[A-Z][A-Z\s]{2,20}\s+\d+\s+\d+\s+[—\-]\s+\d+\s*$/gm, '');
  // Strip "SCORING SUMMARY" section headers
  t = t.replace(/^SCORING\s+SUMMARY\s*$/gim, '');

  // Convert bullet-style lists (lines starting with •, *, -, numbers) into
  // paragraph-friendly text so the AI doesn't get a wall of items.
  // Each bullet becomes its own sentence terminated with a period.
  t = t.replace(/^[•·▪▸►\-\*]\s+(.+)$/gm, (_, item) => {
    const trimmed = item.trim();
    return trimmed.endsWith('.') || trimmed.endsWith('?') || trimmed.endsWith('!') ? trimmed : trimmed + '.';
  });
  // Numbered list items: "1. Item" → "Item."
  t = t.replace(/^\d+\.\s+(.+)$/gm, (_, item) => {
    const trimmed = item.trim();
    return trimmed.endsWith('.') || trimmed.endsWith('?') || trimmed.endsWith('!') ? trimmed : trimmed + '.';
  });

  // Strip inline photo credit suffixes appended to caption sentences.
  // Pattern: "...Lexington, Ky. Photo by Vincenzo Ciaramitaro | Kentucky Kernel"
  // These appear as "[sentence]. Photo by [Name] | [Publication]" on one line.
  t = t.replace(/\s+Photo\s+by\s+[A-Z][a-zA-Z\s.'-]{2,50}(?:\s*[|\/]\s*[A-Za-z\s.'-]{2,60})?\s*$/gm, '');
  // Strip "Photographer Name/AP" or "Name/Getty" photo credits that appear at the
  // very start of content (e.g. "Charles Krupa/AP LEXINGTON, Ky. —")
  t = t.replace(/^[A-Z][a-zA-Z\s.'-]{2,50}\/(?:AP|Getty\s*Images?|Reuters|AFP)\s+/gm, '');
  // Strip standalone figcaption-style lines: entire line that matches "Name | Publication" or
  // ends with "| Publication Name" after a photo description sentence.
  t = t.replace(/^[^\n]{20,200}\s*[|\/]\s*(?:Kentucky Kernel|Kentucky Today|Lex18|LEX 18|WKYT|WDRB|WBKO|AP Photo|Getty Images?|[A-Z][a-zA-Z\s]{2,40})\s*$/gm, '');
  t = t.replace(/^Photo by\b[^\n]*$/gim, '');
  // Strip "(Photo provided)", "(Photo courtesy of X)", "(Photo: Name)" inline captions
  t = t.replace(/\s*\(Photo(?:\s+provided|\s+courtesy(?:\s+of\s+[^)]{0,60})?|:\s*[^)]{0,60}|\/[^)]{0,60})?\)/gi, '');
  // Strip standalone caption lines ending with (Photo provided) or (Courtesy: X) or (Provided)
  t = t.replace(/^[^\n]{10,200}\s*\((?:Photo\s+provided|Courtesy[^)]{0,60}|Provided)\)\s*$/gim, '');
  t = t.replace(/^(?:Here is the original article|Source|Original article|Read more at)[:\s]+https?:\/\/\S+.*$/gim, '');
  t = t.replace(/^[A-Z][A-Z0-9\s'",.!?\-\u2013\u2014]{30,}$/gm, '');
  t = t.replace(/^(?:NCAA\s+\w+|NFL|NBA|NHL|MLB|MLS|PWHL|WNBA)\s*$/gm, '');
  t = t.replace(/^(?:TOTAL\s+[\d.]+|[A-Z]{2,6}\s+-?[\d.]+)\s*$/gm, '');
  t = t.replace(/^\d{1,2}:\d{2}\s*(?:AM|PM)\s*$/gim, '');
  t = t.replace(/^(?:FS1|ESPN[U2]?|CBS|NBC|ABC|TNT|TBS|BALLY|PEACOCK|PCOCK|MSG|NESN|RSN)\s*$/gm, '');
  t = t.replace(/^(?:Recommended Videos?|Recommended Articles?|More from|Related Stories?|Related Articles?|Watch more|You may also like)\s*$[\s\S]*/gim, '');
  // Strip embedded inline "related article" title lines that appear mid-article in Scripps/LEX18 pages.
  // These are short 2–5 word Title Case lines immediately followed by a longer sentence, e.g.:
  //   "Lottery Winner Arrest\nBodycam footage shows KY Lottery winner arrested in Florida\n"
  // Pattern: 1–6 Title Case words on a line, followed by a longer line that reads like a sentence.
  t = t.replace(/^([A-Z][a-zA-Z]{1,20}(?:\s+[A-Z][a-zA-Z]{1,20}){0,5})\n(?=[A-Z][a-z])/gm, '');
  t = t.replace(/^(.+)\n\1$/gm, '$1');
  t = t.replace(/\n{3,}/g, '\n\n');

  // Strip TV closed-caption transcript blocks that leaked through as plain text.
  // Two-pass: first mark each line, then remove entire runs of 3+ caps lines.
  {
    const rawLines = t.split('\n');
    const isCapsLine = rawLines.map((line) => {
      const trimmed = line.trim();
      const upperCount = (trimmed.match(/[A-Z]/g) || []).length;
      const letterCount = (trimmed.match(/[A-Za-z]/g) || []).length;
      return letterCount > 20 && upperCount / letterCount > 0.75;
    });
    const removeIdx = new Set<number>();
    let runStart = -1;
    for (let i = 0; i <= rawLines.length; i++) {
      if (i < rawLines.length && isCapsLine[i]) {
        if (runStart === -1) runStart = i;
      } else {
        if (runStart !== -1 && (i - runStart) >= 3) {
          for (let j = runStart; j < i; j++) removeIdx.add(j);
        }
        runStart = -1;
      }
    }
    t = rawLines.filter((_, i) => !removeIdx.has(i)).join('\n');
  }

  return t.trim();
}

/**
 * Strip common boilerplate that the AI may have echoed into its output.
 */
export function stripBoilerplateFromOutput(text: string, title: string): string {
  let t = decodeHtmlEntities(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n');

  if (title) {
    const escaped = title.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`^\\s*${escaped}\\s*\n?`, 'i'), '');
  }

  // Remove slideshow photo caption blocks: "1/22 Some caption text. (Photographer / Publication)"
  // The caption runs from the slide counter to the closing parenthesized credit.
  // Must handle hyphens, commas, periods, digits in the caption text.
  t = t.replace(/(^|\n)\s*\d+\/\d+\s[^\n]*?\([^)]{3,80}\/[^)]{3,80}\)\s*/g, '$1');
  // Also strip any remaining bare slide counters that had no credit: "3/22 Caption text\n"
  t = t.replace(/(^|\n)\s*\d+\/\d+\s[^\n]{0,300}\n/g, '$1\n');

  t = t.replace(/^\s*Summary\s*$/gim, '');
  t = t.replace(/^Skip\s+to\s+content\b[^\n]*/gim, '');
  t = t.replace(/^[^\n]{3,80}\([A-Z][^)]{3,60}\/\s*(?:Wikipedia|CC\s+BY|Wikimedia|AP|Getty|Reuters)[^)]*\)\s*$/gm, '');
  t = t.replace(/^Source:\s*[A-Za-z0-9_.\-]{1,40}\.\s*/gim, '');
  // Strip broadcaster attribution that the AI may echo: "(LEX 18) —", "(WKYT) —", etc.
  t = t.replace(/^\s*\((?:LEX\s*18|WKYT|WKYT-TV|WLWT|WHAS11?|WDRB|WBKO|WNKY|WYMT|WTVQ|ABC\s*36|FOX\s*56|WAVE\s*3|NBC)\)\s*[-—–]?\s*/im, '');
  // Strip inline broadcaster attribution mid-summary too (e.g. after dateline)
  t = t.replace(/\b\((?:LEX\s*18|WKYT|WKYT-TV|WLWT|WHAS11?|WDRB|WBKO|WNKY|WYMT|WTVQ|ABC\s*36|FOX\s*56|WAVE\s*3|NBC)\)\s*[-—–]?\s*/gi, '');
  // Strip Envato/stock photo captions that slip into the summary
  // e.g. "Shot of a doctor examining a man with a blood pressure gauge. Source: Envato/by YuriArcursPeopleimages."
  t = t.replace(/^[^\n]{10,300}(?:Source:\s*Envato|Getty\s*Images?|iStock|Shutterstock|AP\s*Photo)[^\n]*\n?/gim, '');
  // Strip sentences that reference a "link down below" — the link doesn't exist in our summaries
  t = t.replace(/[^.!?]*\b(?:using\s+the\s+link(?:\s+down\s+below)?|link\s+down\s+below|you\s+can\s+read\s+[^.]{0,60}using\s+the\s+link)[^.!?]*[.!?]?\s*/gi, '');
  // Strip dateline echoed at summary start: "CITY, Ky. (SOURCE) —" or "CITY, KY —"
  t = t.replace(/^\s*[A-Z][A-Z\s]{0,25},\s*(?:Ky|KY|KENTUCKY)[\s.,][^\n]{0,80}[-—–]\s*/im, '');
  t = t.replace(/^Published\b[^\n]*$/gim, '');
  t = t.replace(/^Updated\b[^\n]*$/gim, '');
  t = t.replace(/^Photo by\b[^\n]*$/gim, '');
  t = t.replace(/\s*\(Photo(?:\s+provided|\s+courtesy(?:\s+of\s+[^)]{0,60})?|:\s*[^)]{0,60}|\/[^)]{0,60})?\)/gi, '');
  t = t.replace(/^[^\n]{10,200}\s*\((?:Photo\s+provided|Courtesy[^)]{0,60}|Provided)\)\s*$/gim, '');
  // Strip inline photo credit suffixes appended to caption sentences.
  t = t.replace(/\s+Photo\s+by\s+[A-Z][a-zA-Z\s.'-]{2,50}(?:\s*[|\/]\s*[A-Za-z\s.'-]{2,60})?\s*$/gm, '');
  // Strip "Photographer Name/AP" or "Name/Getty" photo credits at the start of text
  t = t.replace(/^[A-Z][a-zA-Z\s.'-]{2,50}\/(?:AP|Getty\s*Images?|Reuters|AFP)\s+/gm, '');
  // Strip standalone figcaption-style lines: entire line that matches "Name | Publication" or
  // ends with "| Publication Name" after a photo description sentence.
  t = t.replace(/^[^\n]{20,200}\s*[|\/]\s*(?:Kentucky Kernel|Kentucky Today|Lex18|LEX 18|WKYT|WDRB|WBKO|AP Photo|Getty Images?|[A-Z][a-zA-Z\s]{2,40})\s*$/gm, '');
  t = t.replace(/^CLICK HERE\b.+$/gim, '');
  t = t.replace(/^Click below to jump to[:\s].+$/gim, '');
  t = t.replace(/^(?:Here is the original article|Source|Original article)[:\s]+https?:\/\/\S+.*$/gim, '');
  t = t.replace(/^https?:\/\/\S+\s*$/gm, '');
  t = t.replace(/^(?:Facebook|Twitter|X|Threads|Flipboard|Comments|Print|Email|Share|Instagram)\s*$/gim, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  t = normalizeParagraphBoundaries(t);
  t = fixLeadingParagraphPunctuation(t);
  t = repairUnbalancedQuotes(t);

  return t.trim();
}

function normalizeParagraphBoundaries(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n+/g, ' ').replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return '';

  const merged: string[] = [];
  for (const paragraph of paragraphs) {
    if (merged.length === 0) {
      merged.push(paragraph);
      continue;
    }

    const previous = merged[merged.length - 1];
    const shouldMerge =
      !endsWithSentenceBoundary(previous) ||
      (endsWithLikelyAbbreviation(previous) && startsWithLikelyContinuation(paragraph)) ||
      /^[,;:)\]]/.test(paragraph) ||
      /^[a-z]/.test(paragraph) ||
      isInsideOpenQuote(merged.slice(0, merged.length - 1).join('\n\n'), previous);

    if (shouldMerge) {
      merged[merged.length - 1] = `${previous} ${paragraph}`.replace(/\s+/g, ' ').trim();
      continue;
    }

    merged.push(paragraph);
  }

  return merged.join('\n\n');
}

function fixLeadingParagraphPunctuation(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n+/g, ' ').replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return '';

  const cleaned: string[] = [];
  for (const paragraph of paragraphs) {
    if (cleaned.length === 0) {
      const first = paragraph.replace(/^[,;:)\]]+\s*/, '').trim();
      if (first) cleaned.push(first);
      continue;
    }

    if (/^[,;:)\]]/.test(paragraph)) {
      const tail = paragraph.replace(/^[,;:)\]]+\s*/, '').trim();
      if (tail) {
        cleaned[cleaned.length - 1] = `${cleaned[cleaned.length - 1]} ${tail}`.replace(/\s+/g, ' ').trim();
      }
      continue;
    }

    cleaned.push(paragraph);
  }

  return cleaned.join('\n\n').trim();
}

function endsWithSentenceBoundary(input: string): boolean {
  return /[.!?]["')\]]*$/.test(input.trim());
}

function endsWithLikelyAbbreviation(input: string): boolean {
  const trimmed = input.trim();
  // Single capital letter before a period — likely part of an initialism like U.S. or U.K.
  if (/\b[A-Z]\.$/.test(trimmed)) return true;
  // Common titles and abbreviations, including month abbreviations
  if (/\b(?:Mr|Mrs|Ms|Dr|Gov|Lt|Gen|Rep|Sen|Prof|Sr|Jr|St|No|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.$/i.test(trimmed)) return true;
  return false;
}

function startsWithLikelyContinuation(input: string): boolean {
  // Lowercase start, capital initial (e.g. "S." from "U.\nS."), opening quote/paren,
  // digit continuation (date split like "5, 2026"), or dollar amount continuation
  return /^(?:[a-z]|[A-Z]\.|['"(]|\d|\$)/.test(input.trim());
}

/**
 * Returns true if the text so far (all prior paragraphs + current paragraph)
 * has an unclosed quotation, meaning the next paragraph is still inside the quote.
 */
function isInsideOpenQuote(priorText: string, currentParagraph: string): boolean {
  const combined = (priorText ? priorText + '\n\n' : '') + currentParagraph;
  const straightOpen = (combined.match(/"/g) ?? []).length;
  if (straightOpen % 2 !== 0) return true;
  const curlyOpen = (combined.match(/\u201c/g) ?? []).length;
  const curlyClose = (combined.match(/\u201d/g) ?? []).length;
  return curlyOpen > curlyClose;
}

function repairUnbalancedQuotes(text: string): string {
  let output = text;

  // Straight double quotes: if there's exactly one unmatched quote we can
  // simply append a closing quote. If there's more than one imbalance (e.g.
  // three or five quotes), the text is probably garbled so strip them all.
  const straightCount = (output.match(/"/g) ?? []).length;
  if (straightCount % 2 !== 0) {
    if (straightCount === 1) {
      output += '"';
    } else {
      // too many mismatches; drop them entirely as a last resort
      output = output.replace(/"/g, '');
    }
  }

  // Curly quotes – handle similarly but track opens vs closes separately
  let openCount = (output.match(/\u201c/g) ?? []).length;
  let closeCount = (output.match(/\u201d/g) ?? []).length;
  if (openCount !== closeCount) {
    const diff = openCount - closeCount;
    if (Math.abs(diff) === 1) {
      if (diff === 1) {
        // one extra opening curly – close it at end
        output += '\u201d';
      } else {
        // one extra closing curly – drop the last occurrence
        const idx = output.lastIndexOf('\u201d');
        if (idx !== -1) {
          output = output.slice(0, idx) + output.slice(idx + 1);
        }
      }
    } else {
      // too many mismatches to reasonably repair; strip all curly quotes
      output = output.replace(/[\u201c\u201d]/g, '');
    }
  }

  return output;
}

function isMalformedSummary(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;

  if (/&(?:#\d+|#x[0-9a-f]+|nbsp|amp|quot|lt|gt);?/i.test(trimmed)) return true;
  if (/^\s*(?:published|photo by)\b/im.test(trimmed)) return true;

  const straightQuoteCount = (trimmed.match(/"/g) ?? []).length;
  const curlyOpenCount = (trimmed.match(/\u201c/g) ?? []).length;
  const curlyCloseCount = (trimmed.match(/\u201d/g) ?? []).length;

  return straightQuoteCount % 2 !== 0 || curlyOpenCount !== curlyCloseCount;
}

function ensureCompleteLastSentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  if (/[.!?]["')\]\u201d\u2019]*$/.test(t)) return t;

  const boundaryIndex = findLastSentenceBoundaryIndex(t);
  if (boundaryIndex > 0) {
    return t.slice(0, boundaryIndex + 1).trim();
  }

  if (/\w$/.test(t)) return `${t}.`;
  return t;
}

function truncateToSentenceBoundary(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;

  const candidate = words.slice(0, maxWords).join(' ');
  const sentenceEndIdx = findLastSentenceBoundaryIndex(candidate);
  if (sentenceEndIdx > 0) {
    return candidate.slice(0, sentenceEndIdx + 1).trim();
  }
  return ensureCompleteLastSentence(candidate.trim());
}

function findLastSentenceBoundaryIndex(text: string): number {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (!(ch === '.' || ch === '!' || ch === '?')) continue;
    if (ch === '.' && (isLikelyAbbreviationAt(text, i) || isDecimalPoint(text, i))) continue;
    return i;
  }
  return -1;
}

function isLikelyAbbreviationAt(text: string, punctuationIndex: number): boolean {
  if (punctuationIndex < 0 || text[punctuationIndex] !== '.') return false;

  const start = Math.max(0, punctuationIndex - 24);
  const window = text.slice(start, punctuationIndex + 1);

  if (/\b(?:[A-Za-z]\.){2,}$/.test(window)) return true; // U.S. / D.C.
  if (/\b[A-Za-z]\.$/.test(window)) return true; // split initials, e.g. "U."
  if (/\b(?:Mr|Mrs|Ms|Dr|Gov|Lt|Gen|Rep|Sen|Prof|Sr|Jr|St|No|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Ky|a\.m|p\.m)\.$/i.test(window)) {
    return true;
  }

  return false;
}

function isDecimalPoint(text: string, punctuationIndex: number): boolean {
  if (punctuationIndex <= 0 || punctuationIndex >= text.length - 1) return false;
  return /\d/.test(text[punctuationIndex - 1] || '') && /\d/.test(text[punctuationIndex + 1] || '');
}

function hasHallucinatedNumbers(original: string, summary: string): boolean {
  const extractNums = (text: string): Set<string> => {
    const matches = text.match(/\b\d[\d,._]*%?(?:\s*(?:million|billion|thousand))?\b/gi) ?? [];
    return new Set(matches.map((n) => n.toLowerCase().replace(/,/g, '')));
  };

  const originalNums = extractNums(original);
  const summaryNums = extractNums(summary);

  for (const num of summaryNums) {
    if (!originalNums.has(num)) {
      const asYear = num.replace(/,/g, '');
      if (/^\d{4}$/.test(asYear) && original.includes(asYear)) continue;
      return true;
    }
  }
  return false;
}

/**
 * If the AI returns a wall of text (no paragraph breaks), split it into
 * readable paragraphs of roughly 2–3 sentences each.
 * Leaves text that already has paragraph breaks (double newlines) untouched.
 */
function enforceparagraphBreaks(text: string): string {
  // Strip inline section-header lines echoed from the source
  // (e.g. "From a bible study to a ministry", "How the program works")
  // These are short Title Case lines with no terminal punctuation.
  let t = text.replace(
    /\n([A-Z][a-zA-Z ''\-]{3,60}(?:\s+[A-Za-z ''\-]{2,30}){0,6})\n(?=[A-Z])/g,
    '\n\n'
  );

  // Already has paragraph structure — don't touch it
  if (/\n\n/.test(t)) return t.trim();

  // Split on sentence boundaries then group into 2–3 sentence paragraphs.
  // The previous regex required the next char to be uppercase, which missed
  // sentences starting with digits ("51-year-old…"), lowercase continuations, or
  // sentences following stripped datelines/broadcaster attributions.
  // New approach: split on ". " / "! " / "? " preceded by terminal punctuation
  // (optionally followed by a closing quote/paren), then look ahead for any
  // non-whitespace so we don't split on trailing ellipsis spaces.
  // Abbreviation guard: don't split when the period follows a single capital
  // letter (initialism) or a known title abbreviation.
  const sentences: string[] = [];
  const abbrevRe = /\b(?:Mr|Mrs|Ms|Dr|Gov|Lt|Col|Gen|Rep|Sen|Prof|St|Sr|Jr|No|vs|etc|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/i;
  const singleCapRe = /\b[A-Z]$/;
  let buf = '';
  // Walk character by character to handle abbreviation guard properly
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    buf += ch;
    if (!/[.!?]/.test(ch)) continue;
    // Consume optional closing quote/paren
    let j = i + 1;
    while (j < t.length && /["')\u201d\u2019]/.test(t[j])) { buf += t[j]; j++; }
    // Must be followed by whitespace then a non-whitespace char
    if (j >= t.length || !/\s/.test(t[j])) continue;
    let k = j;
    while (k < t.length && /\s/.test(t[k])) k++;
    if (k >= t.length) continue;
    // Abbreviation guard
    const beforePeriod = buf.trimEnd().replace(/[.!?]["')*\u201d\u2019]*$/, '').trimEnd();
    if (ch === '.'  && (singleCapRe.test(beforePeriod) || abbrevRe.test(beforePeriod))) continue;
    // Commit sentence
    sentences.push(buf.trim());
    buf = '';
    i = k - 1; // will be incremented by loop
  }
  if (buf.trim()) sentences.push(buf.trim());

  if (sentences.length <= 3) return t;

  // Group into paragraphs of 2–3 sentences.  Prefer 3 per paragraph but use
  // 2 for the last group when 4 sentences remain (avoids a single orphan).
  const paragraphs: string[] = [];
  let i = 0;
  while (i < sentences.length) {
    const remaining = sentences.length - i;
    const take = remaining === 4 ? 2 : Math.min(3, remaining);
    paragraphs.push(sentences.slice(i, i + take).join(' '));
    i += take;
  }
  return paragraphs.join('\n\n');
}
