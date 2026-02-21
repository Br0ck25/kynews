import { d1First, d1Run } from "./db";
import { logError } from "../lib/logger";
import { sha256Hex } from "../lib/crypto";
import type { Env } from "../types";

const SUMMARY_PROMPT_VERSION = "v2";
const SUMMARY_MIN_WORDS = 200;
const SUMMARY_MAX_WORDS = 400;

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

function trimToMaxWords(input: string, maxWords: number): string {
  const words = splitWords(input);
  if (words.length <= maxWords) return input.trim();
  const clipped = words.slice(0, maxWords).join(" ").trim();
  return /[.!?]$/.test(clipped) ? clipped : `${clipped}.`;
}

function normalizeSummary(text: string): string {
  return text
    .replace(/^\s*(here(?:'s| is)\s+(?:a|the)\s+summary[:\-\s]*)/i, "")
    .replace(/^\s*summary[:\-\s]*/i, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function buildSummaryPrompt(input: { title: string; url: string; articleText: string }): string {
  return [
    "You are a professional local news editor.",
    `Write a factual summary between ${SUMMARY_MIN_WORDS} and ${SUMMARY_MAX_WORDS} words.`,
    "Always write in your own words.",
    "Focus on the main ideas, key facts, and concrete outcomes.",
    "Do not include personal opinions, filler, bullet lists, or headings.",
    "Do not copy long phrases from the source text.",
    "Do not invent facts. If details are uncertain, state that clearly.",
    "Return plain text only.",
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
}): string {
  return [
    "Rewrite this summary to meet strict constraints.",
    `Required length: ${SUMMARY_MIN_WORDS}-${SUMMARY_MAX_WORDS} words.`,
    "Use your own wording only.",
    "Keep only factual, relevant information from the source text.",
    "No opinions, no bullet points, no headings, and no invented details.",
    "Return plain text only.",
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
  const out = cached.trim();
  if (!out) return null;

  const words = wordCount(out);
  if (words < SUMMARY_MIN_WORDS || words > SUMMARY_MAX_WORDS) return null;
  return out;
}

export async function generateSummaryWithAI(env: Env, input: {
  itemId: string;
  title: string;
  url: string;
  articleText: string;
}): Promise<string | null> {
  if (!input.articleText || input.articleText.trim().length < 300) return null;

  const sourceHash = await sha256Hex(`${SUMMARY_PROMPT_VERSION}:${input.articleText.slice(0, 20_000)}`);
  const existing = await d1First<{ summary: string }>(
    env.ky_news_db,
    "SELECT summary FROM item_ai_summaries WHERE item_id=? AND source_hash=? LIMIT 1",
    [input.itemId, sourceHash]
  );
  if (existing?.summary) {
    return existing.summary;
  }

  const model = env.AI_MODEL || "@cf/meta/llama-3.1-8b-instruct";

  try {
    let summary = await runAiSummary(env, model, buildSummaryPrompt(input), 900);
    if (!summary) return null;

    let words = wordCount(summary);
    if (words < SUMMARY_MIN_WORDS || words > SUMMARY_MAX_WORDS) {
      const repaired = await runAiSummary(
        env,
        model,
        buildRepairPrompt({
          title: input.title,
          url: input.url,
          articleText: input.articleText,
          currentSummary: summary
        }),
        900
      );
      if (repaired) {
        summary = repaired;
        words = wordCount(summary);
      }
    }

    if (words > SUMMARY_MAX_WORDS) {
      summary = trimToMaxWords(summary, SUMMARY_MAX_WORDS);
      words = wordCount(summary);
    }

    if (words < SUMMARY_MIN_WORDS) {
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
        words < SUMMARY_MIN_WORDS ? "summary_too_short" : words > SUMMARY_MAX_WORDS ? "summary_too_long" : "auto_generated"
      ]
    );

    return summary;
  } catch (err) {
    logError("ai.summary.failed", err, { itemId: input.itemId, model });
    return null;
  }
}
