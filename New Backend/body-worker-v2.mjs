/**
 * Body + AI Worker v2
 *
 * Extended pipeline per item:
 *  1. Fetch full article body text
 *  2. Word count gate (≥50 words; Facebook exempt)
 *  3. Paywall detection → is_paywalled, paywall_confidence
 *  4. Duplicate detection (MinHash/Jaccard) → is_duplicate, canonical_item_id
 *     If paywalled + free duplicate exists → paywall_deprioritized = 1
 *  5. Breaking news classification → is_breaking, alert_level, sentiment
 *  6. Re-classify counties/categories on full body text
 *  7. Legislature bill tagging
 *  8. Cloudflare Workers AI: summary (55-65%) + SEO meta description
 *  9. Alerting for breaking news (optional)
 *
 * Run: node workers/body-worker-v2.mjs
 * Schedule every 5 minutes.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../lib/db-adapter.mjs";
import { fetchArticleText } from "../lib/scraper.mjs";
import { summarizeViaRestApi } from "../lib/summarizer.mjs";
import { classifyArticle, isWordCountValid } from "../lib/classifier.mjs";
import { detectPaywall, shouldDeprioritize } from "../lib/paywall.mjs";
import { checkDuplicate, storeSignature } from "../lib/dedup.mjs";
import { classifyBreaking } from "../lib/breaking.mjs";
import { tagArticleWithBills } from "../lib/legislature.mjs";
import { alertBreakingNews } from "../lib/alerting.mjs";

// ─── Config ──────────────────────────────────────────────────────────────────

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB_PATH = process.env.DB_PATH || path.join(root, "data", "dev.sqlite");
const CF_ACCOUNT_ID   = process.env.CF_ACCOUNT_ID;
const CF_AI_API_TOKEN = process.env.CF_AI_API_TOKEN;
const CF_SUMMARY_MODEL = process.env.CF_SUMMARY_MODEL || "@cf/zai-org/glm-4.7-flash";
const BATCH_SIZE   = Number(process.env.BODY_WORKER_BATCH || 10);
const MAX_ATTEMPTS = 3;
const CONCURRENCY  = Number(process.env.BODY_WORKER_CONCURRENCY || 3);

// ─── Core pipeline per item ───────────────────────────────────────────────────

async function processItem(db, queueRow) {
  const { item_id } = queueRow;

  await db.prepare(`
    UPDATE ingestion_queue
    SET status='body_fetching', updated_at=datetime('now'), attempts=attempts+1
    WHERE item_id=@item_id
  `).run({ item_id });

  const item = await db.prepare(`
    SELECT id, title, url, summary, is_facebook, word_count FROM items WHERE id=@id
  `).get({ id: item_id });

  if (!item) {
    await db.prepare(`UPDATE ingestion_queue SET status='failed', last_error='not found' WHERE item_id=@item_id`)
      .run({ item_id });
    return;
  }

  // ── Step 1: Fetch body ────────────────────────────────────────────────────
  let bodyText = null;
  let rawHtml  = null;
  let wordCount = item.word_count || 0;

  if (!item.is_facebook) {
    try {
      // We need raw HTML for paywall detection + body text for everything else
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const res = await fetch(item.url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; KYNewsAggregator/1.0)" },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        rawHtml  = await res.text();
        // Extract body text from HTML
        bodyText = await fetchArticleText(item.url, rawHtml);
        if (bodyText) {
          wordCount = bodyText.trim().split(/\s+/).filter(Boolean).length;
          await db.prepare(`
            UPDATE items SET body_text=@body, word_count=@wc, body_fetched_at=datetime('now')
            WHERE id=@id
          `).run({ body: bodyText.slice(0, 50_000), wc: wordCount, id: item_id });
        }
      }
    } catch (err) {
      console.warn(`  ⚠ Body fetch failed for ${item.url}: ${err.message}`);
    }
  } else {
    bodyText = item.summary;
    wordCount = item.word_count || 0;
  }

  const effectiveBody = bodyText || item.summary || "";

  // ── Step 2: Word count gate ───────────────────────────────────────────────
  if (!isWordCountValid(effectiveBody, Boolean(item.is_facebook))) {
    console.log(`  ✗ Too short (${wordCount}w): ${item.title.slice(0, 60)}`);
    await db.prepare(`UPDATE ingestion_queue SET status='rejected_short' WHERE item_id=@item_id`)
      .run({ item_id });
    await db.prepare(`DELETE FROM item_categories WHERE item_id=@item_id`).run({ item_id });
    return;
  }

  // ── Step 3: Paywall detection ─────────────────────────────────────────────
  const { isPaywalled, confidence: pwConfidence, signals: pwSignals } = rawHtml
    ? detectPaywall(rawHtml, item.url, effectiveBody)
    : { isPaywalled: false, confidence: 0, signals: [] };

  await db.prepare(`
    UPDATE items
    SET is_paywalled=@pw, paywall_confidence=@conf, paywall_signals=@sigs
    WHERE id=@id
  `).run({
    pw: isPaywalled ? 1 : 0,
    conf: pwConfidence,
    sigs: JSON.stringify(pwSignals),
    id: item_id,
  });

  // ── Step 4: Duplicate detection ───────────────────────────────────────────
  // Store signature first (so future items can compare against us)
  await storeSignature(db, item_id, item.title, effectiveBody);

  const { isDuplicate, canonicalId, similarity } = await checkDuplicate(
    db, item.title, effectiveBody, item_id
  );

  if (isDuplicate && canonicalId) {
    console.log(`  ♻ Duplicate (${Math.round(similarity * 100)}%): ${item.title.slice(0, 50)}`);
    await db.prepare(`
      UPDATE items SET is_duplicate=1, canonical_item_id=@canonical WHERE id=@id
    `).run({ canonical: canonicalId, id: item_id });

    // If this is paywalled but the original is free → deprioritize
    if (isPaywalled) {
      const deprio = await shouldDeprioritize(db, item_id, canonicalId);
      if (deprio) {
        await db.prepare(`UPDATE items SET paywall_deprioritized=1 WHERE id=@id`).run({ id: item_id });
        console.log(`  💰 Deprioritized (paywalled duplicate)`);
      }
    }
  }

  // ── Step 5: Breaking news ─────────────────────────────────────────────────
  const { isBreaking, alertLevel, sentiment, breakingExpiresAt } =
    classifyBreaking(item.title, effectiveBody, item.url);

  await db.prepare(`
    UPDATE items
    SET is_breaking=@brk, alert_level=@lvl, sentiment=@sent, breaking_expires_at=@exp
    WHERE id=@id
  `).run({
    brk: isBreaking ? 1 : 0,
    lvl: alertLevel || null,
    sent: sentiment,
    exp: breakingExpiresAt || null,
    id: item_id,
  });

  // ── Step 6: Re-classify counties/categories on full body ──────────────────
  const feedRow = await db.prepare(`
    SELECT f.state_code, f.region_scope, f.default_county
    FROM feed_items fi JOIN feeds f ON fi.feed_id = f.id
    WHERE fi.item_id = @item_id LIMIT 1
  `).get({ item_id });

  if (effectiveBody.length > (item.summary || "").length) {
    const reclassified = classifyArticle({
      title: item.title,
      body: effectiveBody,
      feedStateCode: feedRow?.state_code,
      feedRegionScope: feedRow?.region_scope,
      isFacebook: Boolean(item.is_facebook),
    });

    if (reclassified.counties.length > 0) {
      for (const county of reclassified.counties) {
        await db.prepare(`INSERT OR IGNORE INTO item_locations (item_id, state_code, county) VALUES (@item_id, 'KY', @county)`)
          .run({ item_id, county });
      }
    }

    if (reclassified.categories.length > 0) {
      await db.prepare(`DELETE FROM item_categories WHERE item_id=@item_id`).run({ item_id });
      for (const cat of reclassified.categories) {
        await db.prepare(`INSERT OR IGNORE INTO item_categories (item_id, category) VALUES (@item_id, @cat)`)
          .run({ item_id, category: cat });
      }
      // Legislature category is added by bill tagging below
      await db.prepare(`UPDATE items SET categories_json=@cats, region_scope=@rs WHERE id=@id`).run({
        cats: JSON.stringify(reclassified.categories),
        rs: reclassified.regionScope,
        id: item_id,
      });
    }
  }

  // ── Step 7: Legislature bill tagging ─────────────────────────────────────
  try {
    await tagArticleWithBills(db, item_id, item.title, effectiveBody);
  } catch {
    // Non-fatal — bills table may not exist yet
  }

  // ── Step 8: AI Summarization ──────────────────────────────────────────────
  if (!CF_ACCOUNT_ID || !CF_AI_API_TOKEN) {
    await db.prepare(`UPDATE ingestion_queue SET status='done', updated_at=datetime('now') WHERE item_id=@item_id`)
      .run({ item_id });
    console.log(`  ✓ (no AI) ${item.title.slice(0, 60)}`);
    return;
  }

  await db.prepare(`UPDATE ingestion_queue SET status='summarizing', updated_at=datetime('now') WHERE item_id=@item_id`)
    .run({ item_id });

  try {
    const { summary, metaDescription } = await summarizeViaRestApi({
      title: item.title,
      body: effectiveBody,
      accountId: CF_ACCOUNT_ID,
      apiToken: CF_AI_API_TOKEN,
      model: CF_SUMMARY_MODEL,
    });

    await db.prepare(`
      UPDATE items
      SET ai_summary=@summary, ai_meta_description=@meta, ai_processed_at=datetime('now')
      WHERE id=@id
    `).run({ summary, meta: metaDescription, id: item_id });

    await db.prepare(`UPDATE ingestion_queue SET status='done', updated_at=datetime('now') WHERE item_id=@item_id`)
      .run({ item_id });

    console.log(`  ✓ ${isBreaking ? "🔴 BREAKING " : ""}${isPaywalled ? "💰 " : ""}${item.title.slice(0, 60)}`);
  } catch (err) {
    await db.prepare(`
      UPDATE ingestion_queue SET status='failed', last_error=@err, updated_at=datetime('now')
      WHERE item_id=@item_id
    `).run({ item_id, err: err.message.slice(0, 500) });
    return;
  }

  // ── Step 9: Alert on breaking news ───────────────────────────────────────
  if (isBreaking) {
    try {
      const fullItem = await db.prepare(`SELECT * FROM items WHERE id=@id`).get({ id: item_id });
      if (fullItem) await alertBreakingNews(db, fullItem);
    } catch {
      // Non-fatal
    }
  }
}

// ─── Concurrency pool ─────────────────────────────────────────────────────────

async function runWithConcurrency(tasks, concurrency) {
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const task = tasks[i++];
      try { await task(); } catch (err) { console.error("Worker error:", err.message); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const db = await openDb({ path: DB_PATH });

  // Unstick items
  await db.prepare(`
    UPDATE ingestion_queue SET status='pending'
    WHERE status IN ('body_fetching','summarizing')
      AND updated_at < datetime('now', '-10 minutes')
      AND attempts < @max
  `).run({ max: MAX_ATTEMPTS });

  const pending = await db.prepare(`
    SELECT item_id FROM ingestion_queue
    WHERE status='pending' AND attempts < @max
    ORDER BY created_at ASC
    LIMIT @limit
  `).all({ max: MAX_ATTEMPTS, limit: BATCH_SIZE });

  if (pending.length === 0) {
    console.log("📭 Body worker: nothing pending.");
    if (db.close) db.close();
    return;
  }

  console.log(`🤖 Body worker v2: ${pending.length} items`);
  const tasks = pending.map((row) => () => processItem(db, row));
  await runWithConcurrency(tasks, CONCURRENCY);

  if (db.close) db.close();
  console.log("✅ Body worker done.");
}

main().catch((err) => {
  console.error("Body worker fatal:", err);
  process.exit(1);
});
