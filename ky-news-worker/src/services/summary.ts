import { d1First, d1Run } from "./db";
import { logError } from "../lib/logger";
import { sha256Hex } from "../lib/crypto";
import { decodeHtmlEntities, normalizeWhitespace } from "../lib/text";
import type { Env } from "../types";

const SUMMARY_PROMPT_VERSION = "v4";
const SUMMARY_TARGET_MIN_RATIO = 0.55;
const SUMMARY_TARGET_MAX_RATIO = 0.65;
const SUMMARY_TARGET_RATIO = 0.6;
const SUMMARY_ABSOLUTE_MIN_WORDS = 40;
const SUMMARY_ABSOLUTE_MAX_WORDS = 900;
const SEO_DESCRIPTION_MAX_CHARS = 160;
const SUMMARY_BOILERPLATE_RE =
  /you are using an outdated browser|subscribe home news sports opinion obituaries features|submit an obituary|engagement announcement|wedding announcement/i;

type SummaryLengthBounds = {
  sourceWords: number;
  minWords: number;
  maxWords: number;
  targetWords: number;
};

type AiRewriteOutput = {
  summary: string;
  seoDescription: string;
};

type AiMessage = {
  role: "system" | "user";
  content: string;
};

export function summaryCacheKey(itemId: string): string {
  return `summary:${SUMMARY_PROMPT_VERSION}:${itemId}`;
}

export function summarySeoCacheKey(itemId: string): string {
  return `summary-seo:${SUMMARY_PROMPT_VERSION}:${itemId}`;
}

function parseAiText(response: unknown): string {
  if (typeof response === "string") return response.trim();
  if (!response || typeof response !== "object") return "";

  const res = response as Record<string, unknown>;
  if (typeof res.response === "string") return res.response.trim();
  if (typeof (res.result as any)?.response === "string") return String((res.result as any).response).trim();

  const openAiStyle = (res as any)?.choices?.[0]?.message?.content;
  if (typeof openAiStyle === "string") return openAiStyle.trim();
  if (Array.isArray(openAiStyle)) {
    const joined = openAiStyle
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as any).text === "string") return (part as any).text;
        return "";
      })
      .join("\n")
      .trim();
    if (joined) return joined;
  }

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
    .map((word) => word.trim())
    .filter(Boolean);
}

function wordCount(input: string): number {
  return splitWords(input).length;
}

function summaryLengthBounds(articleText: string): SummaryLengthBounds {
  const sourceWords = Math.max(1, wordCount(normalizeWhitespace(articleText)));
  const ratioMin = Math.floor(sourceWords * SUMMARY_TARGET_MIN_RATIO);
  const ratioMax = Math.ceil(sourceWords * SUMMARY_TARGET_MAX_RATIO);
  const ratioTarget = Math.floor(sourceWords * SUMMARY_TARGET_RATIO);

  let minWords = Math.max(SUMMARY_ABSOLUTE_MIN_WORDS, ratioMin);
  let maxWords = Math.max(minWords + 20, Math.min(SUMMARY_ABSOLUTE_MAX_WORDS, ratioMax));
  if (maxWords <= minWords) maxWords = minWords + 20;

  const targetWords = Math.max(minWords, Math.min(maxWords, ratioTarget));
  return { sourceWords, minWords, maxWords, targetWords };
}

function stripCodeFences(input: string): string {
  const trimmed = input.trim();
  const fenced = trimmed.match(/^```(?:json|text)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function normalizeSummary(text: string): string {
  const withLines = decodeHtmlEntities(stripCodeFences(text))
    .replace(/^\s*(here(?:'s| is)\s+(?:a|the)\s+(?:rewritten\s+)?summary[:\-\s]*)/i, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`{1,3}/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const cleaned = withLines
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

  return cleaned;
}

function normalizeSeoDescription(text: string): string {
  const cleaned = decodeHtmlEntities(stripCodeFences(text))
    .replace(/^\s*(seo(?:\s+meta)?\s+description)\s*:\s*/i, "")
    .replace(/\r\n?/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, "")
    .trim();

  if (!cleaned) return "";
  if (cleaned.length <= SEO_DESCRIPTION_MAX_CHARS) return cleaned;

  let clipped = cleaned.slice(0, SEO_DESCRIPTION_MAX_CHARS).trim();
  clipped = clipped.replace(/\s+\S*$/, "").trim();
  if (!/[.!?]$/.test(clipped)) clipped = `${clipped}.`;
  return clipped.slice(0, SEO_DESCRIPTION_MAX_CHARS).trim();
}

function deriveSeoDescription(summary: string): string {
  const compact = normalizeSummary(summary)
    .replace(/^\s*(overview|key details|background|why it matters)\s*:?\s*/gim, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalizeSeoDescription(compact);
}

function hasRequiredSections(summary: string): boolean {
  const text = summary || "";
  return (
    /^\s*Overview\s*:?\s*/im.test(text) &&
    /^\s*Key Details\s*:?\s*/im.test(text) &&
    /^\s*Background\s*:?\s*/im.test(text) &&
    /^\s*Why It Matters\s*:?\s*/im.test(text)
  );
}

function isSummaryUsable(text: string, bounds?: SummaryLengthBounds): boolean {
  if (!text) return false;
  if (SUMMARY_BOILERPLATE_RE.test(text)) return false;
  if (!hasRequiredSections(text)) return false;
  const words = wordCount(text);
  const minWords = bounds?.minWords ?? SUMMARY_ABSOLUTE_MIN_WORDS;
  const maxWords = bounds?.maxWords ?? SUMMARY_ABSOLUTE_MAX_WORDS;
  return words >= minWords && words <= maxWords;
}

function buildSummaryMessages(
  input: { title: string; url: string; articleText: string },
  bounds: SummaryLengthBounds
): AiMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are a neutral news editor.",
        "Write factually and objectively.",
        "Do not speculate.",
        "Do not reference the original publication.",
        "Do not copy phrasing directly.",
        "Do not reproduce quotes verbatim unless a quote is essential.",
        "Rewrite fully in fresh wording."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        "Rewrite the following article into a comprehensive neutral summary.",
        "",
        "Requirements:",
        `- Approximately ${bounds.targetWords} words (must be between ${bounds.minWords} and ${bounds.maxWords}, about 55-65% of source length)`,
        "- Preserve all key facts, names, dates, locations, and numbers",
        "- Fully self-contained so readers do not need the original article",
        "- Do not invent any details",
        "- Use this exact section order with subheadings:",
        "  1) Overview",
        "  2) Key Details",
        "  3) Background",
        "  4) Why It Matters",
        "- Under Key Details, use concise bullet points",
        "- Do not include markdown code fences",
        "- Also generate a 160-character SEO meta description",
        "",
        "Return ONLY valid JSON with this shape:",
        '{"summary":"<structured summary text>","seo_description":"<160-char SEO meta description>"}',
        "",
        `TITLE: ${input.title}`,
        `URL: ${input.url}`,
        "",
        "ARTICLE:",
        input.articleText.slice(0, 22_000)
      ].join("\n")
    }
  ];
}

function buildRepairMessages(input: {
  title: string;
  url: string;
  articleText: string;
  currentSummary: string;
  currentSeoDescription: string;
  bounds: SummaryLengthBounds;
}): AiMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are a neutral news editor.",
        "Write factually and objectively.",
        "Do not speculate.",
        "Do not copy phrasing directly.",
        "Do not reproduce quotes verbatim unless essential.",
        "Rewrite fully in fresh wording."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        "Repair the draft so it strictly meets every rule.",
        "",
        "Hard constraints:",
        `- Summary must be between ${input.bounds.minWords} and ${input.bounds.maxWords} words (target about ${input.bounds.targetWords})`,
        "- Must include these section headings exactly: Overview, Key Details, Background, Why It Matters",
        "- Key Details must include bullet points",
        "- Preserve all source facts, names, dates, locations, and numbers",
        "- Fully rewritten wording; no publication references",
        "- SEO meta description must be 160 characters or fewer",
        "",
        "Return ONLY valid JSON with this shape:",
        '{"summary":"<structured summary text>","seo_description":"<160-char SEO meta description>"}',
        "",
        `TITLE: ${input.title}`,
        `URL: ${input.url}`,
        "",
        "CURRENT SUMMARY:",
        input.currentSummary.slice(0, 12_000),
        "",
        "CURRENT SEO DESCRIPTION:",
        input.currentSeoDescription.slice(0, 500),
        "",
        "ARTICLE:",
        input.articleText.slice(0, 22_000)
      ].join("\n")
    }
  ];
}

function extractJsonCandidate(input: string): string | null {
  const stripped = stripCodeFences(input);
  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  return stripped.slice(firstBrace, lastBrace + 1).trim();
}

function parseAiRewriteOutput(raw: string): AiRewriteOutput | null {
  const text = (raw || "").trim();
  if (!text) return null;

  const jsonCandidate = extractJsonCandidate(text);
  if (jsonCandidate) {
    try {
      const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
      const summary = normalizeSummary(String(parsed.summary || ""));
      const seoDescription = normalizeSeoDescription(
        String(parsed.seo_description || parsed.seoDescription || "")
      );
      if (summary) {
        return {
          summary,
          seoDescription: seoDescription || deriveSeoDescription(summary)
        };
      }
    } catch {
      // fallback parsing below
    }
  }

  const metaLine = text.match(/(?:^|\n)\s*seo(?:\s+meta)?\s+description\s*:\s*(.+)$/im);
  const summary = normalizeSummary(
    metaLine ? text.replace(metaLine[0], "").trim() : text
  );
  if (!summary) return null;

  const seoDescription = normalizeSeoDescription(metaLine?.[1] || "") || deriveSeoDescription(summary);
  return { summary, seoDescription };
}

async function runAiRewrite(
  env: Env,
  model: string,
  messages: AiMessage[],
  maxTokens = 1800
): Promise<AiRewriteOutput | null> {
  try {
    const chatResponse = await env.AI.run(model, {
      messages,
      max_tokens: maxTokens,
      temperature: 0.2
    });
    const parsedChat = parseAiRewriteOutput(parseAiText(chatResponse));
    if (parsedChat) return parsedChat;
  } catch {
    // Some model bindings still expect prompt-style input.
  }

  const prompt = messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n");
  const promptResponse = await env.AI.run(model, {
    prompt,
    max_tokens: maxTokens,
    temperature: 0.2
  });

  return parseAiRewriteOutput(parseAiText(promptResponse));
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

export async function getCachedSeoDescription(env: Env, itemId: string): Promise<string | null> {
  const cached = await env.CACHE.get(summarySeoCacheKey(itemId));
  if (!cached) return null;
  const out = normalizeSeoDescription(cached);
  if (!out) return null;

  const ttl = Number(env.SUMMARY_CACHE_TTL_SECONDS || 30 * 24 * 60 * 60);
  if (out !== cached.trim()) {
    await env.CACHE.put(summarySeoCacheKey(itemId), out, {
      expirationTtl: Number.isFinite(ttl) ? ttl : 30 * 24 * 60 * 60
    });
  }
  return out;
}

export async function generateSummaryWithAI(
  env: Env,
  input: {
    itemId: string;
    title: string;
    url: string;
    articleText: string;
  }
): Promise<string | null> {
  if (!input.articleText || input.articleText.trim().length < 300) return null;
  const bounds = summaryLengthBounds(input.articleText);

  const sourceHash = await sha256Hex(`${SUMMARY_PROMPT_VERSION}:${input.articleText.slice(0, 22_000)}`);
  const existing = await d1First<{ summary: string; seo_description: string | null }>(
    env.ky_news_db,
    "SELECT summary, seo_description FROM item_ai_summaries WHERE item_id=? AND source_hash=? LIMIT 1",
    [input.itemId, sourceHash]
  );
  if (existing?.summary) {
    const cleanedSummary = normalizeSummary(existing.summary);
    const cleanedSeo = normalizeSeoDescription(existing.seo_description || "") || deriveSeoDescription(cleanedSummary);
    if (isSummaryUsable(cleanedSummary, bounds)) {
      if (cleanedSummary !== existing.summary || cleanedSeo !== normalizeSeoDescription(existing.seo_description || "")) {
        await d1Run(
          env.ky_news_db,
          "UPDATE item_ai_summaries SET summary=?, seo_description=?, generated_at=datetime('now') WHERE item_id=?",
          [cleanedSummary, cleanedSeo || null, input.itemId]
        );
        await d1Run(env.ky_news_db, "UPDATE items SET summary=?, seo_description=? WHERE id=?", [
          cleanedSummary,
          cleanedSeo || null,
          input.itemId
        ]);
      }
      return cleanedSummary;
    }
  }

  const model = env.AI_MODEL || "@cf/zai-org/glm-4.7-flash";

  try {
    let rewrite = await runAiRewrite(env, model, buildSummaryMessages(input, bounds), 1800);
    if (!rewrite) return null;

    if (!isSummaryUsable(rewrite.summary, bounds)) {
      rewrite = await runAiRewrite(
        env,
        model,
        buildRepairMessages({
          title: input.title,
          url: input.url,
          articleText: input.articleText,
          currentSummary: rewrite.summary,
          currentSeoDescription: rewrite.seoDescription,
          bounds
        }),
        1800
      ) || rewrite;
    }

    const summary = normalizeSummary(rewrite.summary);
    const words = wordCount(summary);
    if (!isSummaryUsable(summary, bounds)) {
      return null;
    }

    const seoDescription = normalizeSeoDescription(rewrite.seoDescription) || deriveSeoDescription(summary);
    const ttl = Number(env.SUMMARY_CACHE_TTL_SECONDS || 30 * 24 * 60 * 60);
    const safeTtl = Number.isFinite(ttl) ? ttl : 30 * 24 * 60 * 60;

    await env.CACHE.put(summaryCacheKey(input.itemId), summary, {
      expirationTtl: safeTtl
    });
    await env.CACHE.put(summarySeoCacheKey(input.itemId), seoDescription, {
      expirationTtl: safeTtl
    });

    await d1Run(
      env.ky_news_db,
      `INSERT INTO item_ai_summaries (item_id, summary, seo_description, model, source_hash, generated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(item_id) DO UPDATE SET
         summary=excluded.summary,
         seo_description=excluded.seo_description,
         model=excluded.model,
         source_hash=excluded.source_hash,
         generated_at=excluded.generated_at`,
      [input.itemId, summary, seoDescription || null, model, sourceHash]
    );

    await d1Run(env.ky_news_db, "UPDATE items SET summary=?, seo_description=? WHERE id=?", [
      summary,
      seoDescription || null,
      input.itemId
    ]);
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
