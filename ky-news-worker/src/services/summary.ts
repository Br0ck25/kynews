import { d1First, d1Run } from "./db";
import { logError } from "../lib/logger";
import { sha256Hex } from "../lib/crypto";
import { decodeHtmlEntities, normalizeWhitespace } from "../lib/text";
import type { Env } from "../types";

const SUMMARY_PROMPT_VERSION = "v3";
const SUMMARY_TARGET_MIN_RATIO = 0.8;
const SUMMARY_TARGET_MAX_RATIO = 0.9;
const SUMMARY_ABSOLUTE_MIN_WORDS = 40;
const SUMMARY_ABSOLUTE_MAX_WORDS = 420;
const SUMMARY_TEMPLATE_LABEL_RE =
  /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*|__)?\s*(?:background|key points?|impact|what'?s next|overview|bottom line|main takeaways?|takeaways?)\s*:?\s*(?:\*\*|__)?\s*/gi;
const SUMMARY_BOILERPLATE_RE =
  /you are using an outdated browser|subscribe home news sports opinion obituaries features|submit an obituary|engagement announcement|wedding announcement/i;

type SummaryLengthBounds = {
  sourceWords: number;
  minWords: number;
  maxWords: number;
  targetWords: number;
};

function summaryCacheKey(itemId: string): string {
  return `summary:${SUMMARY_PROMPT_VERSION}:${itemId}`;
}

function parseAiText(response: unknown): string {
  if (typeof response === "string") return response.trim();
  if (!response || typeof response !== "object") return "";

  const res = response as Record<string, unknown>;
  if (typeof res.response === "string") return res.response.trim();
  if (typeof (res.result as any)?.response === "string") return String((res.result as any).response).trim();

  if (Array.isArray(res.content)) {
    const joined = res.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as any).text === "string") return (part as any).text;
        return "";
      })
      .join("\n")
      .trim();
    if (joined) return joined;
  }

  if (Array.isArray((res.result as any)?.content)) {
    const joined = (res.result as any).content
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as any).text === "string") return (part as any).text;
        return "";
      })
      .join("\n")
      .trim();
    if (joined) return joined;
  }

  return "";
}

function splitWords(input: string): string[] {
  return input
    .trim()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

function wordCount(input: string): number {
  return splitWords(input).length;
}

function summaryLengthBounds(articleText: string): SummaryLengthBounds {
  const sourceWords = Math.max(1, wordCount(normalizeWhitespace(articleText)));
  const ratioMin = Math.floor(sourceWords * SUMMARY_TARGET_MIN_RATIO);
  const ratioMax = Math.ceil(sourceWords * SUMMARY_TARGET_MAX_RATIO);

  let maxWords = Math.max(SUMMARY_ABSOLUTE_MIN_WORDS + 4, Math.min(SUMMARY_ABSOLUTE_MAX_WORDS, ratioMax));
  let minWords = Math.max(SUMMARY_ABSOLUTE_MIN_WORDS, ratioMin);

  if (minWords > maxWords) {
    minWords = Math.max(SUMMARY_ABSOLUTE_MIN_WORDS, Math.min(maxWords - 4, Math.floor(maxWords * 0.9)));
  }
  if (maxWords <= minWords) {
    maxWords = Math.min(SUMMARY_ABSOLUTE_MAX_WORDS, minWords + 4);
  }
  if (maxWords <= minWords) {
    minWords = Math.max(SUMMARY_ABSOLUTE_MIN_WORDS, maxWords - 1);
  }

  const targetWords = Math.max(minWords, Math.min(maxWords, Math.round((minWords + maxWords) / 2)));
  return { sourceWords, minWords, maxWords, targetWords };
}

function trimToMaxWords(input: string, maxWords: number): string {
  const words = splitWords(input);
  if (words.length <= maxWords) return input.trim();
  const clipped = words.slice(0, maxWords).join(" ").trim();
  return /[.!?]$/.test(clipped) ? clipped : `${clipped}.`;
}

function normalizeSummary(text: string): string {
  const out = decodeHtmlEntities(text)
    .replace(/^\s*(here(?:'s| is)\s+(?:a|the)\s+summary[:\-\s]*)/i, "")
    .replace(/^\s*summary[:\-\s]*/i, "")
    .replace(SUMMARY_TEMPLATE_LABEL_RE, " ")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`{1,3}/g, "")
    .trim();
  // AI summaries must be continuous prose with no paragraph breaks.
  // Collapse ALL newlines (including double-newlines from abbreviation splits like
  // "The U.\n\nS. team" which the model sometimes emits) into a single space.
  return normalizeWhitespace(out)
    .replace(/\n+/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function isSummaryUsable(text: string, bounds?: SummaryLengthBounds): boolean {
  if (!text) return false;
  if (SUMMARY_BOILERPLATE_RE.test(text)) return false;
  const words = wordCount(text);
  const minWords = bounds?.minWords ?? SUMMARY_ABSOLUTE_MIN_WORDS;
  const maxWords = bounds?.maxWords ?? SUMMARY_ABSOLUTE_MAX_WORDS;
  return words >= minWords && words <= maxWords;
}

function buildSummaryPrompt(input: { title: string; url: string; articleText: string }, bounds: SummaryLengthBounds): string {
  return [
    "You are a professional local news editor.",
    `Source text is about ${bounds.sourceWords} words.`,
    `Write a factual summary between ${bounds.minWords} and ${bounds.maxWords} words (target about ${bounds.targetWords} words, roughly ${Math.round(SUMMARY_TARGET_MIN_RATIO * 100)}-${Math.round(SUMMARY_TARGET_MAX_RATIO * 100)}% of the source).`,
    "Always write in your own words.",
    "Focus on the main ideas, key facts, and concrete outcomes.",
    "Use only facts explicitly stated in the source text.",
    "If a detail is missing from the source text, omit it.",
    "Do not include personal opinions, filler, bullet lists, or headings.",
    "Never output labels such as Background, Key Points, Impact, or What's Next.",
    "Do not use markdown formatting.",
    "Do not copy long phrases from the source text.",
    "Do not invent facts. If details are uncertain, state that clearly.",
    "Write as a single continuous paragraph. Do NOT add line breaks, paragraph breaks, or blank lines anywhere in the output.",
    "Write abbreviations like U.S., U.N., D.C. without any line breaks between letters.",
    "Return plain text only. No newlines.",
    "",
    `TITLE: ${input.title}`,
    `URL: ${input.url}`,
    "",
    "SOURCE TEXT:",
    input.articleText.slice(0, 20_000)
  ].join("\n");
}

function buildRepairPrompt(input: {
  title: string;
  url: string;
  articleText: string;
  currentSummary: string;
  bounds: SummaryLengthBounds;
}): string {
  return [
    "Rewrite this summary to meet strict constraints.",
    `Required length: ${input.bounds.minWords}-${input.bounds.maxWords} words.`,
    `Target about ${input.bounds.targetWords} words.`,
    "Use your own wording only.",
    "Keep only factual information that is explicitly present in the source text.",
    "If the source text does not state a detail, remove it.",
    "No opinions, no bullet points, no headings, and no invented details.",
    "Do not use markdown labels such as Background, Key Points, Impact, or What's Next.",
    "Write as a single continuous paragraph with NO line breaks or paragraph breaks anywhere.",
    "Write abbreviations like U.S., U.N., D.C. without any line breaks between letters.",
    "Return plain text only. No newlines.",
    "",
    `TITLE: ${input.title}`,
    `URL: ${input.url}`,
    "",
    "CURRENT SUMMARY:",
    input.currentSummary.slice(0, 10_000),
    "",
    "SOURCE TEXT:",
    input.articleText.slice(0, 20_000)
  ].join("\n");
}

async function runAiSummary(env: Env, model: string, prompt: string, maxTokens = 900): Promise<string | null> {
  const aiResponse = await env.AI.run(model, {
    prompt,
    max_tokens: maxTokens,
    temperature: 0.2
  });

  const parsed = normalizeSummary(parseAiText(aiResponse));
  return parsed || null;
}

export async function getCachedSummary(env: Env, itemId: string): Promise<string | null> {
  const cached = await env.CACHE.get(summaryCacheKey(itemId));
  if (!cached) return null;
  const out = normalizeSummary(cached);
  if (!out) return null;

  if (!isSummaryUsable(out)) return null;
  if (out !== cached.trim()) {
    const ttl = Number(env.SUMMARY_CACHE_TTL_SECONDS || 30 * 24 * 60 * 60);
    await env.CACHE.put(summaryCacheKey(itemId), out, {
      expirationTtl: Number.isFinite(ttl) ? ttl : 30 * 24 * 60 * 60
    });
  }
  return out;
}

export async function generateSummaryWithAI(env: Env, input: {
  itemId: string;
  title: string;
  url: string;
  articleText: string;
}): Promise<string | null> {
  if (!input.articleText || input.articleText.trim().length < 300) return null;
  const bounds = summaryLengthBounds(input.articleText);

  const sourceHash = await sha256Hex(`${SUMMARY_PROMPT_VERSION}:${input.articleText.slice(0, 20_000)}`);
  const existing = await d1First<{ summary: string }>(
    env.ky_news_db,
    "SELECT summary FROM item_ai_summaries WHERE item_id=? AND source_hash=? LIMIT 1",
    [input.itemId, sourceHash]
  );
  if (existing?.summary) {
    const cleaned = normalizeSummary(existing.summary);
    if (isSummaryUsable(cleaned, bounds)) {
      if (cleaned !== existing.summary) {
        await d1Run(
          env.ky_news_db,
          "UPDATE item_ai_summaries SET summary=?, generated_at=datetime('now') WHERE item_id=?",
          [cleaned, input.itemId]
        );
        await d1Run(env.ky_news_db, "UPDATE items SET summary=? WHERE id=?", [cleaned, input.itemId]);
      }
      return cleaned;
    }
  }

  const model = env.AI_MODEL || "@cf/meta/llama-3.1-8b-instruct";

  try {
    let summary = await runAiSummary(env, model, buildSummaryPrompt(input, bounds), 900);
    if (!summary) return null;

    let words = wordCount(summary);
    if (!isSummaryUsable(summary, bounds)) {
      const repaired = await runAiSummary(
        env,
        model,
        buildRepairPrompt({
          title: input.title,
          url: input.url,
          articleText: input.articleText,
          currentSummary: summary,
          bounds
        }),
        900
      );
      if (repaired) {
        summary = repaired;
        words = wordCount(summary);
      }
    }

    if (words > bounds.maxWords) {
      summary = normalizeSummary(trimToMaxWords(summary, bounds.maxWords));
      words = wordCount(summary);
    }

    if (!isSummaryUsable(summary, bounds)) {
      return null;
    }

    const ttl = Number(env.SUMMARY_CACHE_TTL_SECONDS || 30 * 24 * 60 * 60);
    await env.CACHE.put(summaryCacheKey(input.itemId), summary, {
      expirationTtl: Number.isFinite(ttl) ? ttl : 30 * 24 * 60 * 60
    });

    await d1Run(
      env.ky_news_db,
      `INSERT INTO item_ai_summaries (item_id, summary, model, source_hash, generated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(item_id) DO UPDATE SET
         summary=excluded.summary,
         model=excluded.model,
         source_hash=excluded.source_hash,
         generated_at=excluded.generated_at`,
      [input.itemId, summary, model, sourceHash]
    );

    await d1Run(env.ky_news_db, "UPDATE items SET summary=? WHERE id=?", [summary, input.itemId]);
    await d1Run(
      env.ky_news_db,
      `
      INSERT INTO summary_review_queue (
        item_id, status, queue_reason, reviewer_email, reviewed_at, reviewed_summary, note, created_at, updated_at
      ) VALUES (?, 'pending', ?, NULL, NULL, NULL, NULL, datetime('now'), datetime('now'))
      ON CONFLICT(item_id) DO UPDATE SET
        status='pending',
        queue_reason=excluded.queue_reason,
        reviewer_email=NULL,
        reviewed_at=NULL,
        reviewed_summary=NULL,
        note=NULL,
        updated_at=datetime('now')
      `,
      [
        input.itemId,
        words < bounds.minWords ? "summary_too_short" : words > bounds.maxWords ? "summary_too_long" : "auto_generated"
      ]
    );

    return summary;
  } catch (err) {
    logError("ai.summary.failed", err, { itemId: input.itemId, model });
    return null;
  }
}
