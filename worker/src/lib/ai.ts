import type { SummaryResult } from '../types';
import { wordCount } from './http';

const MODEL = '@cf/zai-org/glm-4.7-flash' as keyof AiModels;

type AiResultLike = {
  response?: string;
  result?: { response?: string };
  output_text?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
};

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
    const prompt = [
      `Title: ${title}`,
      'Task: Write a concise factual summary and SEO description for this news article.',
      'Rules:',
      '- Output plain text only in JSON with keys summary and seoDescription.',
      '- summary should be between 55% and 65% of original article word count.',
      '- seoDescription must be <= 160 characters.',
      '- no markdown, no preface, no code fences.',
      '',
      'Article:',
      content.slice(0, 12_000),
    ].join('\n');

    const aiRaw = (await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: 'You are a precise newsroom summarizer.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      seed: 42,
      max_completion_tokens: 1400,
    })) as AiResultLike;

    const aiText = extractAiText(aiRaw);
    const parsed = parseSummaryJson(aiText);

    if (parsed?.summary) summary = parsed.summary;
    if (parsed?.seoDescription) seo = parsed.seoDescription;
  } catch {
    // best effort AI, fallback stays in place
  }

  summary = enforceSummaryWordRange(summary, content, originalWords);
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

function parseSummaryJson(input: string): { summary: string; seoDescription: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const normalized = trimmed.replace(/```json|```/gi, '').trim();
    const parsed = JSON.parse(normalized) as { summary?: string; seoDescription?: string };
    if (!parsed.summary && !parsed.seoDescription) return null;
    return {
      summary: (parsed.summary ?? '').trim(),
      seoDescription: (parsed.seoDescription ?? '').trim(),
    };
  } catch {
    return null;
  }
}

function deterministicFallbackSummary(content: string, originalWords: number): {
  summary: string;
  seoDescription: string;
} {
  const target = clamp(Math.round(originalWords * 0.6), 30, 250);
  const words = content.split(/\s+/u).filter(Boolean);
  const summary = words.slice(0, target).join(' ').trim();

  return {
    summary,
    seoDescription: enforceSeoLength(summary.slice(0, 220), summary),
  };
}

function enforceSummaryWordRange(summary: string, original: string, originalWords: number): string {
  const minWords = Math.max(Math.floor(originalWords * 0.55), 10);
  const maxWords = Math.max(Math.ceil(originalWords * 0.65), minWords + 1);

  const summaryWords = summary.split(/\s+/u).filter(Boolean);
  const originalWordsArray = original.split(/\s+/u).filter(Boolean);

  let clamped = summaryWords;

  if (summaryWords.length > maxWords) {
    clamped = summaryWords.slice(0, maxWords);
  } else if (summaryWords.length < minWords) {
    const missing = minWords - summaryWords.length;
    clamped = summaryWords.concat(originalWordsArray.slice(summaryWords.length, summaryWords.length + missing));
  }

  return clamped.join(' ').replace(/\s+/g, ' ').trim();
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
