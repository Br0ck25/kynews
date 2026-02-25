import type { SummaryResult } from '../types';
import { wordCount } from './http';

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
- End mid-sentence under any circumstances. If you are approaching the
  word limit, finish the current sentence and stop cleanly.
- Output section headers, subheadings, or bolded titles of any kind.
- Output text as one unbroken paragraph.
- Include copyright notices, bylines, legal text, or publication footers.
- Add facts, opinions, assumptions, or analysis not in the original.
- Exaggerate, soften, or reframe any statement.

Return clean, publication-ready paragraphs only. No headlines, labels,
bullet points, subheadings, or commentary.`;

export async function summarizeArticle(
  env: Env,
  cacheKeySuffix: string,
  title: string,
  content: string,
): Promise<SummaryResult> {
  const originalWords = Math.max(wordCount(content), 1);
  const cacheKey = `summary:${cacheKeySuffix}`;

  if (env.CACHE) {
    try {
      const cached = await env.CACHE.get<SummaryResult>(cacheKey, 'json');
      if (cached?.summary && cached?.seoDescription) return cached;
    } catch {
      // best effort cache read
    }
  }

  const fallback = deterministicFallbackSummary(content, originalWords);

  let summary = fallback.summary;
  let seo = fallback.seoDescription;

  try {
    const userPrompt = `Title: ${title}\n\nArticle:\n${content.slice(0, 12_000)}`;

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
      // --- Anti-hallucination safeguards (Section 13 of SEO/AI plan) ---

      // 13.2 Length check: enforce 35–50% of original, or ≤200 words for short articles
      const aiWords = wordCount(aiText);
      const minWords = Math.round(originalWords * 0.35);
      const maxWords = originalWords < 400
        ? 200
        : Math.round(originalWords * 0.50);

      let validatedText = aiText;

      if (aiWords < minWords && aiWords < 30) {
        // Too short — fall back to deterministic (keeps the fallback already computed)
        validatedText = '';
      } else if (aiWords > maxWords) {
        // Too long — truncate at sentence boundary
        validatedText = truncateToSentenceBoundary(aiText, maxWords);
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
  };

  if (env.CACHE) {
    try {
      await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 7200 });
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
