import { d1First, d1Run } from "./db";
import { logError } from "../lib/logger";
import { sha256Hex } from "../lib/crypto";
import type { Env } from "../types";

function summaryCacheKey(itemId: string): string {
  return `summary:v1:${itemId}`;
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

function buildSummaryPrompt(input: { title: string; url: string; articleText: string }): string {
  return [
    "You are a professional local news editor.",
    "Write a comprehensive, factual news summary in at least 5 paragraphs.",
    "Include key people, places, timeline, causes, impacts, and what readers should watch next.",
    "Do not invent facts. If information is missing, state uncertainty clearly.",
    "Return plain text only.",
    "",
    `TITLE: ${input.title}`,
    `URL: ${input.url}`,
    "",
    "ARTICLE TEXT:",
    input.articleText.slice(0, 20_000)
  ].join("\n");
}

export async function getCachedSummary(env: Env, itemId: string): Promise<string | null> {
  const cached = await env.CACHE.get(summaryCacheKey(itemId));
  if (!cached) return null;
  const out = cached.trim();
  return out || null;
}

export async function generateSummaryWithAI(env: Env, input: {
  itemId: string;
  title: string;
  url: string;
  articleText: string;
}): Promise<string | null> {
  if (!input.articleText || input.articleText.trim().length < 300) return null;

  const sourceHash = await sha256Hex(input.articleText.slice(0, 20_000));
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
    const aiResponse = await env.AI.run(model, {
      prompt: buildSummaryPrompt(input),
      max_tokens: 900,
      temperature: 0.2
    });

    let summary = parseAiText(aiResponse);
    if (!summary) return null;

    summary = summary.replace(/\s+\n/g, "\n").trim();
    if (summary.length > 12_000) summary = summary.slice(0, 12_000);

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
        summary.length < 600 ? "summary_too_short" : summary.length > 6000 ? "summary_too_long" : "auto_generated"
      ]
    );

    return summary;
  } catch (err) {
    logError("ai.summary.failed", err, { itemId: input.itemId, model });
    return null;
  }
}
